import {catalogProblem,catalogEffort} from '../../../shared/model-catalog.ts';
import {runnerModelCatalogs} from './model-catalog.ts';
import { randomUUID } from 'node:crypto';
import { query, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { modelReference, type ModelName, type Effort } from '../../../shared/compose.ts';
import { clipResult, type StartEngine } from './engine.ts';
import { deskInstructions } from './instructions.ts';
import { steeringSkillText } from './skill-input.ts';
import type { BackgroundTask, SubagentEvent, SubagentInfo, SubagentStatus } from '../../../shared/protocol.ts';
import { claudeMcpOptions } from './managed-mcp.ts';

/** #ultra is Codex's; the hub refuses it for Claude, and anything that slips through runs as max. */
const claudeEffort = (e: Effort | undefined) => (e === 'ultra' ? 'max' : e);

/** Push-based prompt stream so one long-lived query can take follow-up messages. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  /**
   * Mid-turn, the CLI folds a 'next' message into the running turn and runs a 'later' one as its
   * own turn afterwards ('now' would abort the turn); when idle, either starts a turn right away.
   */
  push(text: string, priority: 'next' | 'later',uuid?:string) {
    const msg: SDKUserMessage = {
      type: 'user', ...(uuid && {uuid}), message: { role: 'user', content: text }, parent_tool_use_id: null, priority,
    } as SDKUserMessage;
    if (this.waiter) { this.waiter({ value: msg, done: false }); this.waiter = null; }
    else this.items.push(msg);
  }
  end() {
    this.done = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

/** Desk skills load as plugin skills (`desk:<name>`); #tags ask for them on that message only. */
export function withSkills(text: string, skills?: string[]): string {
  if (!skills?.length) return text;
  const names = skills.map((s) => `desk:${s}`).join(', ');
  return `[데스크 스킬] 이 메시지에는 Skill 도구로 ${names} 스킬을 먼저 불러와 그 지침을 따르세요.\n\n${text || '(추가 지시 없음)'}`;
}

function resultText(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n')
    : '';
  return clipResult(text);
}

/** How often a running subagent's progress is reported, at most. */
const PROGRESS_MS = 2000;
/** Subagent messages kept until the subagent they belong to is known, per call and calls; past this they are dropped. */
const EARLY_LIMIT = 50;
const EARLY_CALLS = 20;
/**
 * A subagent step's largest text or tool input kept: one message must stay well under what a remote
 * runner's journal sends at once (remote-journal.ts), and a subagent writes whole files at a time.
 */
const STEP_MAX = 64 * 1024;
const fit = (event: SubagentEvent): SubagentEvent => {
  if (event.kind === 'tool' && JSON.stringify(event.input ?? null).length > STEP_MAX)
    return { ...event, input: { truncated: JSON.stringify(event.input).slice(0, STEP_MAX) + '…' } };
  if ((event.kind === 'assistant' || event.kind === 'user') && event.text.length > STEP_MAX)
    return { ...event, text: event.text.slice(0, STEP_MAX) + '\n…(truncated)' };
  return event;
};

/**
 * Follows the subagents (and background commands) a session starts and reports what they are told,
 * say and do. A subagent's messages carry the id of the Agent tool call that started it, even when a
 * follow-up (SendMessage) resumes it; `task_started` ties that call to the task.
 */
export function subagentTracker(sessionId: string, emit: Parameters<StartEngine>[0]['emit']) {
  const known = new Map<string, SubagentInfo>();
  const byToolUse = new Map<string, string>();
  const early = new Map<string, SubagentEvent[]>();
  const reported = new Map<string, number>();
  // A command the turn waits for is an ordinary tool call, shown in the thread; it is recorded only
  // if it moves to the background.
  const foreground = new Map<string, SubagentInfo>();
  // Each run (a follow-up starts another) has its id; frames of an earlier run that come late are dropped.
  const runs = new Map<string, string>();
  const late = (taskId: string, runId?: string) => !!runId && (runs.get(taskId) ?? '') > runId;
  const report = (info: SubagentInfo) => {
    known.set(info.id, info);
    reported.set(info.id, Date.now());
    emit({ type: 'subagent', sessionId, subagent: info });
  };
  const send = (subagentId: string, event: SubagentEvent) => emit({ type: 'subagent_event', sessionId, subagentId, event: fit(event) });
  const update = (id: string, patch: Partial<SubagentInfo>) => {
    const info = known.get(id);
    if (info) report({ ...info, ...patch });
  };
  const eventsOf = (m: SDKMessage): SubagentEvent[] => {
    if (m.type === 'assistant') return m.message.content.flatMap((block): SubagentEvent[] =>
      block.type === 'text' && block.text.trim() ? [{ kind: 'assistant', text: block.text }]
        : block.type === 'tool_use' ? [{ kind: 'tool', toolUseId: block.id, name: block.name, input: block.input }] : []);
    if (m.type === 'user' && Array.isArray(m.message.content)) return m.message.content.flatMap((block): SubagentEvent[] =>
      typeof block === 'object' && block.type === 'tool_result'
        ? [{ kind: 'tool_result', toolUseId: block.tool_use_id, isError: !!block.is_error, text: resultText(block.content) }] : []);
    return [];
  };
  /** Whether `m` was a subagent's (handled here) rather than the main conversation's. */
  return (m: SDKMessage): boolean => {
    if ((m.type === 'assistant' || m.type === 'user') && m.parent_tool_use_id) {
      const id = byToolUse.get(m.parent_tool_use_id);
      const events = eventsOf(m);
      if (id) for (const event of events) send(id, event);
      else {
        const waiting = early.get(m.parent_tool_use_id) ?? [];
        waiting.push(...events);
        early.set(m.parent_tool_use_id, waiting.slice(0, EARLY_LIMIT));
        if (early.size > EARLY_CALLS) early.delete(early.keys().next().value!);
      }
      return true;
    }
    if (m.type !== 'system') return false;
    if (m.subtype === 'task_started') {
      if (m.ambient || m.skip_transcript || late(m.task_id, m.run_id)) return true;
      if (m.run_id) runs.set(m.task_id, m.run_id);
      const previous = known.get(m.task_id);
      const info: SubagentInfo = {
        ...previous, id: m.task_id, type: m.task_type ?? previous?.type ?? 'local_agent', description: m.description,
        ...(m.subagent_type && { agent: m.subagent_type }), status: 'running',
        ...(m.is_backgrounded !== undefined && { background: m.is_backgrounded }),
        ...(m.parent_task_id && { parentId: m.parent_task_id }), ...(!previous && m.tool_use_id && { toolUseId: m.tool_use_id }),
        summary: undefined,
      };
      if (!previous && info.type === 'local_bash' && !info.background) { foreground.set(m.task_id, info); return true; }
      report(info);
      // A follow-up (SendMessage) starts the task again with its message as the prompt.
      if (m.prompt) send(m.task_id, { kind: 'user', text: m.prompt });
      if (m.tool_use_id && !previous) {
        byToolUse.set(m.tool_use_id, m.task_id);
        for (const event of early.get(m.tool_use_id) ?? []) send(m.task_id, event);
        early.delete(m.tool_use_id);
      }
    } else if (m.subtype === 'task_progress') {
      const info = known.get(m.task_id);
      if (!info || late(m.task_id, m.run_id)) return true;
      known.set(m.task_id, { ...info, usage: { tokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, durationMs: m.usage.duration_ms },
        ...(m.last_tool_name && { lastTool: m.last_tool_name }), ...(m.summary && { summary: m.summary }) });
      if (Date.now() - (reported.get(m.task_id) ?? 0) >= PROGRESS_MS) report(known.get(m.task_id)!);
    } else if (m.subtype === 'task_updated') {
      if (late(m.task_id, m.run_id)) return true;
      const waiting = foreground.get(m.task_id);
      if (waiting && m.patch.is_backgrounded) { foreground.delete(m.task_id); report({ ...waiting, background: true }); return true; }
      if (waiting) { if (m.patch.status && m.patch.status !== 'running' && m.patch.status !== 'pending') foreground.delete(m.task_id); return true; }
      const status: SubagentStatus | undefined = m.patch.status === 'completed' || m.patch.status === 'failed' ? m.patch.status
        : m.patch.status === 'killed' ? 'stopped' : undefined;
      if (status || m.patch.is_backgrounded !== undefined)
        update(m.task_id, { ...(status && { status }), ...(m.patch.is_backgrounded !== undefined && { background: m.patch.is_backgrounded }) });
    } else if (m.subtype === 'task_notification') {
      if (late(m.task_id, m.run_id) || foreground.delete(m.task_id)) return true;
      update(m.task_id, { status: m.status, summary: clipResult(m.summary ?? ''),
        ...(m.usage && { usage: { tokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, durationMs: m.usage.duration_ms } }) });
    } else return false;
    return true;
  };
}

export const startClaude: StartEngine = (opts) => {
  const { sessionId, emit } = opts;
  const prompts = new PromptQueue();
  const pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown> }>();
  // The SDK ends an interrupted turn with an error result; report it as an interruption instead.
  let interrupting = false;
  // init repeats on every turn; only the first one starts the session.
  let started = false;
  let model: string | undefined;
  // Set by close(): the stream ending (or throwing) afterwards is a requested shutdown, not a failure.
  let closing = false;
  // A turn is in progress: one we sent, or one the agent started itself (a background subagent finished).
  let busy = false;
  let hadBackground = false;
  let awaitingBackgroundTurn = false;
  let backgroundTurn = false;
  const setBusy = (b: boolean, awaitingContinuation?: boolean) => {
    if (busy === b) return;
    busy = b;
    emit({ type: 'busy', sessionId, busy: b, ...(awaitingContinuation && { awaitingContinuation }) });
  };
  const startBackgroundTurn = () => {
    if (busy || (!awaitingBackgroundTurn && !hadBackground)) return;
    awaitingBackgroundTurn = false;
    backgroundTurn = true;
    setBusy(true);
  };

  const q = query({
    prompt: prompts,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      forkSession: opts.resume && opts.fork ? true : undefined,
      permissionMode: opts.permissionMode,
      model: modelReference(opts.model)?.id ?? opts.model,
      effort: claudeEffort(opts.effort),
      // Subagents' own words, not just their tool calls (subagentTracker).
      ...(opts.subagents && { forwardSubagentText: true }),
      plugins: opts.skillsHome ? [{ type: 'local', path: opts.skillsHome }] : undefined,
      ...claudeMcpOptions(opts.mcp, opts.connectorMcp),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: deskInstructions(opts.skillsHome, opts.instructions) },
      canUseTool: (toolName, input, { signal }) => new Promise<PermissionResult>((resolve) => {
        const approvalId = randomUUID();
        pending.set(approvalId, { resolve, input });
        signal.addEventListener('abort', () => {
          if (pending.delete(approvalId)) {
            emit({ type: 'approval_cancelled', sessionId, approvalId });
            resolve({ behavior: 'deny', message: 'Request aborted' });
          }
        });
        emit({ type: 'approval_request', sessionId, approvalId, toolName, input });
      }),
    },
  });

  const subagents = opts.subagents ? subagentTracker(sessionId, emit) : undefined;
  const handle = (m: SDKMessage) => {
    if (subagents?.(m)) return;
    if (m.type === 'system' && m.subtype === 'init') {
      if (started) {
        startBackgroundTurn();
        if (m.model !== model) {
          model = m.model;
          emit({ type: 'event', sessionId, event: { kind: 'status', state: 'model_changed', detail: { model: m.model } } });
        }
        return;
      }
      started = true;
      model = m.model;
      emit({ type: 'engine_session', sessionId, engineSessionId: m.session_id });
      emit({ type: 'event', sessionId, event: { kind: 'status', state: 'started', detail: { model: m.model, cwd: m.cwd } } });
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      // The whole list each time; ambient tasks (watchers) are not work the agent is doing.
      const tasks: BackgroundTask[] = m.tasks.filter((t) => !t.ambient)
        .map((t) => ({ id: t.task_id, type: t.task_type, description: t.description, ...(t.subagent_type && { agent: t.subagent_type }) }));
      awaitingBackgroundTurn = !tasks.length && (awaitingBackgroundTurn || hadBackground && !busy);
      hadBackground = tasks.length > 0;
      emit({ type: 'background', sessionId, tasks });
    } else if (m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'running') {
      startBackgroundTurn();
    } else if (m.type === 'assistant' && m.parent_tool_use_id === null) {
      for (const id of m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []))
        opts.onRequestStarted?.(id);
      setBusy(true);
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          emit({ type: 'event', sessionId, event: { kind: 'assistant', text: block.text } });
        } else if (block.type === 'tool_use') {
          emit({ type: 'event', sessionId, event: { kind: 'tool', toolUseId: block.id, name: block.name, input: block.input } });
        }
      }
    } else if (m.type === 'user' && m.parent_tool_use_id === null && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (typeof block === 'object' && block.type === 'tool_result') {
          emit({ type: 'event', sessionId, event: {
            kind: 'tool_result', toolUseId: block.tool_use_id, isError: !!block.is_error, text: resultText(block.content),
          } });
        }
      }
    } else if (m.type === 'result') {
      // A background task's completion notice yields an empty turn with no model call; it neither
      // says anything nor ends the user's turn.
      if (m.subtype === 'success' && m.num_turns === 0) {
        if (backgroundTurn) {
          backgroundTurn = false;
          awaitingBackgroundTurn = true;
          setBusy(false, true);
        }
        return;
      }
      backgroundTurn = awaitingBackgroundTurn = false;
      const state = m.subtype === 'success' ? 'turn_done' : interrupting ? 'interrupted' : 'error';
      interrupting = false;
      emit({ type: 'event', sessionId, event: {
        kind: 'status', state,
        detail: { subtype: m.subtype, cost_usd: m.total_cost_usd, duration_ms: m.duration_ms, num_turns: m.num_turns },
      } });
      setBusy(false);
    }
  };

  (async () => {
    try {
      for await (const m of q) handle(m);
      emit({ type: 'closed', sessionId });
    } catch (err) {
      if (closing) emit({ type: 'closed', sessionId });
      else emit({ type: 'closed', sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  const deliver = (text: string, skills?: string[], steer?: boolean, skillSnapshotHome?: string,requestInputId?:string) => {
    backgroundTurn = awaitingBackgroundTurn = false;
    busy = true;
    emit({ type: 'busy', sessionId, busy: true });
    prompts.push(skillSnapshotHome ? steeringSkillText(text, skills, skillSnapshotHome) : withSkills(text, skills), steer ? 'next' : 'later',requestInputId);
  };
  let selectedChoice = opts.model, selectedEffort = opts.effort;
  const validateModel = async (choice?: ModelName, effort?: Effort) => {
    const catalog = await runnerModelCatalogs.read('claude');
    const problem = catalogProblem('claude',choice,effort,catalog);
    if (problem) throw new Error(problem);
    return catalogEffort(catalog,choice,effort);
  };
  let initialized = false;
  let deliveryVersion = 0;
  setBusy(true);
  const ready = validateModel(selectedChoice,selectedEffort).then(async effective => {
    if (closing) return;
    if (effective && effective !== selectedEffort) await q.applyFlagSettings({effortLevel:claudeEffort(effective)});
    initialized = true;
    if (!closing && deliveryVersion === 0) deliver(opts.prompt, opts.skills, false, opts.skillSnapshotHome,opts.requestInputId);
  }).catch(error => {
    if (closing) return;
    closing = true; prompts.end(); q.close();
    emit({type:'closed',sessionId,error:error instanceof Error ? error.message : String(error)});
  });
  const send = (text: string,skills?:string[],steer?:boolean,skillSnapshotHome?:string,requestInputId?:string) => {
    const version = deliveryVersion;
    void ready.then(() => { if (!closing && version === deliveryVersion) deliver(text,skills,steer,skillSnapshotHome,requestInputId); });
  };

  return {
    send,
    interrupt: async () => {
      // With no turn running the flag would stick and mislabel the next turn's failure as an interrupt.
      if (!busy) return;
      deliveryVersion++;
      if (!initialized) { setBusy(false); return; }
      interrupting = true;
      await q.interrupt();
    },
    setMode: (mode) => q.setPermissionMode(mode),
    setModel: async (model, effort) => {
      await ready;
      if (closing) throw new Error('Claude 세션이 종료되었습니다');
      const choice = model ?? selectedChoice, wantedEffort = effort ?? selectedEffort;
      const effective = await validateModel(choice,wantedEffort);
      if (model) await q.setModel(modelReference(model)?.id ?? model);
      if (effective) await q.applyFlagSettings({ effortLevel: claudeEffort(effective) });
      selectedChoice = choice; selectedEffort = wantedEffort;
    },
    resolveApproval: (approvalId, allow, message, answers) => {
      const p = pending.get(approvalId);
      if (!p) return;
      pending.delete(approvalId);
      // AskUserQuestion reads the user's picks from `answers` in its (updated) input.
      p.resolve(!allow ? { behavior: 'deny', message: message || 'Denied by user' }
        : answers ? { behavior: 'allow', updatedInput: { ...p.input, answers } } : { behavior: 'allow' });
    },
    close: () => {
      if (closing) return;
      closing = true;
      for (const p of pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed' });
      pending.clear();
      prompts.end();
      q.close();
    },
  };
};
