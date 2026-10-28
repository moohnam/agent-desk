import { randomUUID } from 'node:crypto';
import { query, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Effort, ModelName, PermissionMode } from '../compose.ts';
import { DESK_INSTRUCTIONS } from './instructions.ts';
import type { BackgroundTask, EngineAdapter, RunnerToHub } from './protocol.ts';

const MAX_RESULT_TEXT = 4000;
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
  push(text: string, priority: 'next' | 'later') {
    const msg: SDKUserMessage = {
      type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority,
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
  return text.length > MAX_RESULT_TEXT ? text.slice(0, MAX_RESULT_TEXT) + '\n…(truncated)' : text;
}

export function startClaude(opts: {
  sessionId: string; cwd: string; prompt: string; resume?: string; fork?: boolean; permissionMode: PermissionMode;
  model?: ModelName; effort?: Effort; skills?: string[]; skillsHome?: string;
  emit: (m: RunnerToHub) => void;
}): EngineAdapter {
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
  const setBusy = (b: boolean) => { if (busy !== b) { busy = b; emit({ type: 'busy', sessionId, busy: b }); } };

  const q = query({
    prompt: prompts,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      forkSession: opts.resume && opts.fork ? true : undefined,
      permissionMode: opts.permissionMode,
      model: opts.model,
      effort: claudeEffort(opts.effort),
      plugins: opts.skillsHome ? [{ type: 'local', path: opts.skillsHome }] : undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT_APPEND },
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

  const handle = (m: SDKMessage) => {
    if (m.type === 'system' && m.subtype === 'init') {
      if (started) {
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
      emit({ type: 'background', sessionId, tasks });
    } else if (m.type === 'assistant' && m.parent_tool_use_id === null) {
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
      if (m.subtype === 'success' && m.num_turns === 0) return;
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

  const send = (text: string, skills?: string[], steer?: boolean) => {
    busy = true;
    emit({ type: 'busy', sessionId, busy: true });
    prompts.push(withSkills(text, skills), steer ? 'next' : 'later');
  };
  send(opts.prompt, opts.skills);

  return {
    send,
    interrupt: async () => {
      interrupting = true;
      await q.interrupt();
    },
    setMode: (mode) => q.setPermissionMode(mode),
    setModel: async (model, effort) => {
      if (model) await q.setModel(model);
      // 'max' on a model without it runs as 'high' (the SDK's rule).
      if (effort) await q.applyFlagSettings({ effortLevel: claudeEffort(effort) });
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
}
