// Codex engine adapter: drives one `codex app-server` process (JSON-RPC over stdio, one JSON
// message per line) per session. Unlike `codex exec`, the app server sends approval requests to
// the client, so the app can allow or deny tool use exactly as with Claude.
// Protocol reference: `codex app-server generate-ts --out DIR` (checked against codex-cli 0.163.0).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelName, PermissionMode } from '../../../shared/compose.ts';
import { config } from '../config.ts';
import { deskInstructions } from './instructions.ts';
import { steeringSkillText } from './skill-input.ts';
import { codexMcpProcess } from './managed-mcp.ts';
import { StderrTail, TurnQueue, clipResult, type StartEngine } from './engine.ts';
import { catalogModel, catalogProblem, catalogEffort } from '../../../shared/model-catalog.ts';
import { runnerModelCatalogs, readCodexModels } from './model-catalog.ts';
import { CodexSubagents } from './codex-subagents.ts';
import { CodexActivity } from './codex-activity.ts';
import { ASK_USER, type Answers, type RunnerEvent } from '../../../shared/protocol.ts';

const CODEX_BIN = config.codexBin;

/**
 * #ask: `untrusted` asks before file edits and any command not known to be read-only; the app
 * answers. #auto: `on-request` and this adapter accepts every request itself (MCP tool calls,
 * sandbox escalations included). `never` would have Codex reject anything that needs approval,
 * MCP calls among them, without asking. Approvals always come to this client (`user`), not to a
 * reviewer the user's Codex config may set (`approvals_reviewer`). Both keep the workspace-write
 * sandbox, so commands run inside the project unless an escalation is approved.
 */
const POLICY: Record<PermissionMode, 'untrusted' | 'on-request'> = { default: 'untrusted', auto: 'on-request' };
const REVIEWER = 'user';
const SANDBOX_MODE = 'workspace-write';
/** thread/resume's error when another process (the Codex app, a `codex resume`) has the thread open. */
const WRITER_BUSY = /already has an active writer/i;
const SANDBOX_POLICY = {
  type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
};

type Json = any;
type Id = number | string;

function mcpText(result: Json): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((c: Json) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n');
}

/** A message waiting for its turn: the text and the desk skills it names. */
interface Turn { text: string; requestInputId?:string; skills?: string[]; skillSnapshotHome?: string }

/** An approval the app answers: the JSON-RPC request to reply to and how to phrase the reply. */
interface Pending { requestId: Id; reply: (allow: boolean, message?: string, answers?: Answers) => Json }

export const startCodex: StartEngine = (opts) => {
  const { sessionId, emit } = opts;
  const event = (e: RunnerEvent) => emit({ type: 'event', sessionId, event: e });
  let mode = opts.permissionMode;
  /** The model id a family tag resolved to, and the effort; both go with every turn/start. Unset: Codex's default. */
  let model: string | undefined;
  let effort = opts.effort;
  let selectedChoice = opts.model;
  /** The model the feed last heard of (thread start or a later switch). */
  let reported: string | undefined;
  let threadId: string | null = null;
  let turnId: string | null = null;
  /** Messages sent while a turn runs, or before the thread starts, each start the next turn (as the Claude SDK queues them). */
  const turns = new TurnQueue<Turn>((turn) => startTurn(turn), (busy) => emit({ type: 'busy', sessionId, busy }), false);
  /** An interrupt came while turn/start was in flight; sent once the turn id is known. */
  let stopAsked = false;
  const noteTurn = (id: string | undefined) => {
    turnId = id ?? turnId;
    if (!stopAsked || !threadId || !turnId) return;
    stopAsked = false;
    request('turn/interrupt', { threadId, turnId }).catch(() => {});
  };
  /** Set by close(): the process exiting afterwards is a requested shutdown, not a failure. */
  let closing = false;
  let closedEmitted = false;
  const pending = new Map<string, Pending>();
  /** Request id → approval id, to cancel approvals the server withdraws (e.g. on interrupt). */
  const byRequest = new Map<string, string>();
  /** File changes seen in item/started, shown with the fileChange approval that follows. */
  const fileChanges = new Map<string, Json>();
  const stderrTail = new StderrTail();

  const mcpProcess = codexMcpProcess(opts.mcp, opts.connectorMcp);
  const child = spawn(CODEX_BIN, mcpProcess.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: mcpProcess.env });

  const closed = (error?: string) => {
    if (closedEmitted) return;
    closedEmitted = true;
    activity.stop(); subagents?.stop();
    for (const approvalId of pending.keys()) emit({ type: 'approval_cancelled', sessionId, approvalId });
    pending.clear();
    emit(error && !closing ? { type: 'closed', sessionId, error } : { type: 'closed', sessionId });
  };

  // --- JSON-RPC plumbing ---
  let nextId = 1;
  const calls = new Map<Id, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const write = (msg: Json) => {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const request = (method: string, params: Json, timeoutMs?:number) => new Promise<Json>((resolve, reject) => {
    const id = nextId++;
    const timer = timeoutMs ? setTimeout(()=>{calls.delete(id);reject(new Error(`${method} 응답 시간 초과`));},timeoutMs) : undefined;
    calls.set(id, { resolve: value=>{clearTimeout(timer);resolve(value);}, reject: error=>{clearTimeout(timer);reject(error);} });
    write({ id, method, params });
  });
  const subagents = opts.subagents ? new CodexSubagents(sessionId,(method,p)=>request(method,p,5000),emit) : undefined;
  const activity = new CodexActivity((method,params)=>request(method,params,5000),tasks=>emit({type:'background',sessionId,tasks}),5000,(t,root)=>subagents?.discover(t,root));
  const respond = (id: Id, result: Json) => write({ id, result });

  // Writing after the process went raises EPIPE here; 'exit' reports the end.
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk: Buffer) => stderrTail.push(chunk));
  child.on('error', (err) => {
    for (const c of calls.values()) c.reject(err);
    calls.clear();
    closed(`codex 실행 실패 (${CODEX_BIN}): ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    for (const c of calls.values()) c.reject(new Error('codex app-server exited'));
    calls.clear();
    const tail = stderrTail.last(3, (l) => /error/i.test(l)).join('\n');
    closed(code === 0 ? undefined : `codex app-server 종료 (code ${code ?? signal})${tail ? `\n${tail}` : ''}`);
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const call = calls.get(msg.id);
      if (!call) return;
      calls.delete(msg.id);
      if (msg.error) call.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else call.resolve(msg.result);
    } else if (msg.id !== undefined) {
      onServerRequest(msg.id, msg.method, msg.params ?? {});
    } else if (msg.method) {
      onNotification(msg.method, msg.params ?? {});
    }
  });

  // --- Approvals ---
  const ask = (requestId: Id, toolName: string, input: unknown, reply: Pending['reply']) => {
    // #auto approves on the user's behalf, but only the user can answer a question.
    if (mode === 'auto' && toolName !== ASK_USER) { respond(requestId, reply(true)); return; }
    const approvalId = randomUUID();
    pending.set(approvalId, { requestId, reply });
    byRequest.set(String(requestId), approvalId);
    emit({ type: 'approval_request', sessionId, approvalId, toolName, input });
  };

  const onServerRequest = (id: Id, method: string, p: Json) => {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        ask(id, 'Bash', { command: p.command ?? '', cwd: p.cwd, description: p.reason ?? undefined },
          (allow) => ({ decision: allow ? 'accept' : 'decline' }));
        return;
      case 'item/fileChange/requestApproval': {
        const changes = fileChanges.get(p.itemId) ?? [];
        ask(id, 'Edit', {
          file_path: changes.map((c: Json) => c.path).join(', ') || p.grantRoot || '',
          changes: changes.map((c: Json) => ({ path: c.path, kind: c.kind?.type ?? c.kind, diff: clipResult(c.diff ?? '') })),
          description: p.reason ?? undefined,
        }, (allow) => ({ decision: allow ? 'accept' : 'decline' }));
        return;
      }
      case 'item/permissions/requestApproval':
        ask(id, 'Permissions', { permissions: p.permissions, description: p.reason ?? undefined },
          (allow) => ({ permissions: allow ? stripNulls(p.permissions) : {}, scope: 'turn' }));
        return;
      case 'item/tool/requestUserInput': {
        // Shown like Claude's AskUserQuestion; answers come back keyed by question text.
        const qs: Json[] = p.questions ?? [];
        ask(id, ASK_USER, {
          questions: qs.map((q) => ({
            question: q.question, header: q.header, multiSelect: false, secret: q.isSecret || undefined,
            options: (q.options ?? []).map((o: Json) => ({ label: o.label, description: o.description })),
          })),
        }, (allow, _message, answers) => ({
          answers: Object.fromEntries(allow && answers ? qs.flatMap((q) =>
            answers[q.question] != null ? [[q.id, { answers: [answers[q.question]] }]] : []) : []),
        }));
        return;
      }
      case 'mcpServer/elicitation/request':
        ask(id, `mcp__${p.serverName}`, { message: p.message, url: p.url },
          (allow) => ({ action: allow ? 'accept' : 'decline', content: allow && p.mode !== 'url' ? {} : null, _meta: null }));
        return;
      // Legacy (v1) approval requests, in case the server still sends them.
      case 'execCommandApproval':
        ask(id, 'Bash', { command: Array.isArray(p.command) ? p.command.join(' ') : p.command, cwd: p.cwd },
          (allow, message) => ({ decision: allow ? 'approved' : { denied: { rejection: message || 'Denied by user' } } }));
        return;
      case 'applyPatchApproval':
        ask(id, 'Edit', { file_path: Object.keys(p.fileChanges ?? {}).join(', ') },
          (allow, message) => ({ decision: allow ? 'approved' : { denied: { rejection: message || 'Denied by user' } } }));
        return;
      default:
        write({ id, error: { code: -32601, message: `agent-desk does not handle ${method}` } });
    }
  };

  // --- Turn events ---
  const toolStart = (item: Json) => {
    switch (item.type) {
      case 'commandExecution':
        event({ kind: 'tool', toolUseId: item.id, name: 'Bash', input: { command: item.command, cwd: item.cwd } });
        break;
      case 'fileChange':
        fileChanges.set(item.id, item.changes ?? []);
        event({ kind: 'tool', toolUseId: item.id, name: 'Edit', input: {
          file_path: (item.changes ?? []).map((c: Json) => c.path).join(', '),
          changes: (item.changes ?? []).map((c: Json) => ({ path: c.path, kind: c.kind?.type ?? c.kind })),
        } });
        break;
      case 'mcpToolCall':
        event({ kind: 'tool', toolUseId: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments });
        break;
      case 'dynamicToolCall':
        event({ kind: 'tool', toolUseId: item.id, name: item.tool, input: item.arguments });
        break;
      case 'webSearch':
        event({ kind: 'tool', toolUseId: item.id, name: 'WebSearch', input: { query: item.query } });
        break;
    }
  };

  const itemDone = (item: Json) => {
    switch (item.type) {
      case 'agentMessage': {
        // An async question (request_user_input_async): the turn goes on, and the answer is the
        // user's next message. Its options are kept so the desk can offer them as buttons.
        const questions = item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length
          ? item.questions.map((q: Json) => ({ title: String(q.title ?? ''), options: (q.options ?? []).map(String) })) : undefined;
        if (item.text?.trim()) event({ kind: 'assistant', text: item.text, ...(questions ? { questions } : {}) });
        break;
      }
      case 'commandExecution': {
        const isError = item.status !== 'completed' || (item.exitCode ?? 0) !== 0;
        const text = item.status === 'declined' ? '사용자가 거절함' : (item.aggregatedOutput ?? '');
        event({ kind: 'tool_result', toolUseId: item.id, isError, text: clipResult(text) });
        break;
      }
      case 'fileChange': {
        fileChanges.delete(item.id);
        const text = (item.changes ?? []).map((c: Json) => c.diff ? `${c.path}\n${c.diff}` : c.path).join('\n');
        event({ kind: 'tool_result', toolUseId: item.id, isError: item.status !== 'completed', text: clipResult(text) });
        break;
      }
      case 'mcpToolCall':
        event({ kind: 'tool_result', toolUseId: item.id, isError: !!item.error || item.status === 'failed',
          text: clipResult(item.error?.message ?? mcpText(item.result)) });
        break;
      case 'dynamicToolCall':
        event({ kind: 'tool_result', toolUseId: item.id, isError: item.success === false,
          text: clipResult((item.contentItems ?? []).map((c: Json) => c.text ?? `[${c.type}]`).join('\n')) });
        break;
      case 'webSearch':
        event({ kind: 'tool_result', toolUseId: item.id, isError: false, text: '' });
        break;
    }
  };

  const onNotification = (method: string, p: Json) => {
    activity.notification(method,p);
    subagents?.notification(method,p,threadId??'');
    if (p.threadId && threadId && p.threadId !== threadId) return; // sub-agent threads
    switch (method) {
      case 'turn/started': noteTurn(p.turn?.id); break;
      case 'item/started': toolStart(p.item); break;
      case 'item/completed': itemDone(p.item); break;
      case 'serverRequest/resolved': {
        const approvalId = byRequest.get(String(p.requestId));
        byRequest.delete(String(p.requestId));
        if (approvalId && pending.delete(approvalId)) emit({ type: 'approval_cancelled', sessionId, approvalId });
        break;
      }
      case 'turn/completed': {
        const turn = p.turn ?? {};
        turnId = null;
        stopAsked = false;
        const state = turn.status === 'completed' ? 'turn_done' : turn.status === 'interrupted' ? 'interrupted' : 'error';
        event({ kind: 'status', state, detail: {
          subtype: turn.status, duration_ms: turn.durationMs ?? undefined,
          ...(turn.error?.message ? { message: turn.error.message } : {}),
        } });
        turns.ended();
        break;
      }
    }
  };

  // Desk skills come from the skills root registered at start; a skill input names one for this turn.
  const skillItem = (name: string) => ({ type: 'skill', name, path: join(opts.skillsHome!, 'skills', name, 'SKILL.md') });

  const turnInput = (turn: Turn, steering = false) => {
    const input: Json[] = opts.skillsHome && !turn.skillSnapshotHome ? (turn.skills ?? []).map(skillItem) : [];
    const text = turn.skillSnapshotHome ? steeringSkillText(turn.text, turn.skills, turn.skillSnapshotHome)
      : steering ? steeringSkillText(turn.text, turn.skills, opts.skillsHome) : turn.text;
    // Codex 0.164.0 accepts skill items in turn/steer without expanding their instructions.
    // Keep the native items, but explicitly ask the model to read the selected files as well.
    if (text || !input.length) input.push({ type: 'text', text, text_elements: [] });
    return input;
  };

  /** Resolve only on session start or explicit selection; refreshes never change this session. */
  const resolveModel = async (choice: ModelName, wantedEffort = effort, pinnedId?: string): Promise<{model:string;effort:typeof effort}> => {
    const fresh = await runnerModelCatalogs.read('codex',false,()=>readCodexModels(request));
    const catalog = pinnedId ? {...fresh,models:fresh.models.filter(m=>m.id===pinnedId)} : fresh;
    if (!catalog.updatedAt) throw new Error(catalog.error ?? 'Codex 모델 목록을 확인하지 못했습니다');
    const problem = catalogProblem('codex',choice,wantedEffort,catalog);
    if (problem) throw new Error(problem);
    const selected = catalogModel(catalog,choice,wantedEffort);
    if (!selected) throw new Error(`Codex 모델 목록에 ${choice}이 없습니다`);
    return {model:selected.id,effort:catalogEffort(catalog,choice,wantedEffort)};
  };

  /** Runs a turn; the queue calls it once the thread has started. */
  const startTurn = (turn: Turn) => {
    const input = turnInput(turn);
    if (model && model !== reported) {
      reported = model;
      event({ kind: 'status', state: 'model_changed', detail: { model, reasoning_effort: effort } });
    }
    request('turn/start', {
      threadId, input,
      approvalPolicy: POLICY[mode], approvalsReviewer: REVIEWER, sandboxPolicy: SANDBOX_POLICY,
      ...(model && { model }), ...(effort && { effort }),
    }).then((r) => {
      noteTurn(r?.turn?.id);
      if (turn.requestInputId && r?.turn?.id) opts.onRequestStarted?.(turn.requestInputId);
    }).catch((err: Error) => {
      if (closing) return;
      stopAsked = false;
      event({ kind: 'status', state: 'error', detail: { message: `Codex 턴 시작 실패: ${err.message}` } });
      turns.ended();
    });
  };

  // --- Session start ---
  (async () => {
    try {
      await request('initialize', {
        clientInfo: { name: 'agent-desk', title: 'Agent Desk', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      write({ method: 'initialized' });
      if (opts.skillsHome) {
        await request('skills/extraRoots/set', { extraRoots: [join(opts.skillsHome, 'skills')] }).catch((err: Error) => {
          event({ kind: 'status', state: 'warning', detail: { message: `데스크 스킬 등록 실패: ${err.message}` } });
        });
      }
      if (opts.model) ({model,effort} = await resolveModel(opts.model));
      const common = {
        ...(model && { model }), cwd: opts.cwd, approvalPolicy: POLICY[mode], approvalsReviewer: REVIEWER, sandbox: SANDBOX_MODE, developerInstructions: deskInstructions(opts.skillsHome, opts.instructions),
      };
      // Codex lets one process write a thread. Another client holding it (the Codex app with the
      // conversation open) makes resuming fail; a fork carries the history over to a new thread.
      let lockedBy = false;
      const r = !opts.resume ? await request('thread/start', common)
        : opts.fork ? await request('thread/fork', { threadId: opts.resume, ...common, excludeTurns: true })
        : await request('thread/resume', { threadId: opts.resume, ...common, excludeTurns: true }).catch((err: Error) => {
          if (opts.requestInputId || !WRITER_BUSY.test(err.message)) throw err;
          lockedBy = true;
          return request('thread/fork', { threadId: opts.resume, ...common, excludeTurns: true });
        });
      threadId = r.thread.id as string;
      activity.start(threadId);
      emit({ type: 'engine_session', sessionId, engineSessionId: threadId });
      reported = r.model;
      event({ kind: 'status', state: 'started', detail: {
        model: r.model, cwd: r.cwd, reasoning_effort: effort ?? r.reasoningEffort ?? undefined,
        ...(opts.resume ? (opts.fork ? { forked: true } : lockedBy ? { resumed: true, writer_busy: opts.resume } : { resumed: true }) : {}),
      } });
      turns.open();
    } catch (err) {
      if (closing || closedEmitted) return;
      const message = err instanceof Error ? err.message : String(err);
      closing = true; // the failure is reported here; the kill below must not report again
      closedEmitted = true;
      activity.stop(); subagents?.stop();
      emit({ type: 'busy', sessionId, busy: false });
      emit({ type: 'closed', sessionId, error: `Codex 세션 시작 실패: ${message}` });
      child.kill();
    }
  })();

  // A model switch looks the id up first; messages sent after it wait so their turn runs on the new model.
  let switching: Promise<unknown> = Promise.resolve();
  const send = (text: string, skills?: string[], steer?: boolean, skillSnapshotHome?: string, requestInputId?:string) => {
    emit({ type: 'busy', sessionId, busy: true });
    void switching.then(() => deliver(text, skills, steer, skillSnapshotHome,requestInputId));
  };
  const deliver = (text: string, skills?: string[], steer?: boolean, skillSnapshotHome?: string, requestInputId?:string) => {
    if (closing) return;
    if (steer && turns.active && threadId && turnId) {
      // Adds the input to the running turn; if that turn ended meanwhile, run it as the next turn.
      const turn = { text, skills, skillSnapshotHome,requestInputId };
      request('turn/steer', { threadId, input: turnInput(turn, true), expectedTurnId: turnId }).catch(() => {
        if (closing) return;
        turns.push(turn);
      });
    } else turns.push({ text, skills, skillSnapshotHome,requestInputId });
  };
  send(opts.prompt, opts.skills, false, opts.skillSnapshotHome,opts.requestInputId);

  return {
    send,
    interrupt: async () => {
      const dropped = turns.clear();
      if (threadId && turnId) await request('turn/interrupt', { threadId, turnId });
      else if (turns.active) stopAsked = true;
      else if (dropped) {
        // Still starting: the only work was the queued message, now dropped, so the session is idle.
        event({ kind: 'status', state: 'interrupted', detail: { subtype: 'interrupted' } });
        emit({ type: 'busy', sessionId, busy: false });
      }
    },
    // Applies from the next turn (turn/start carries the policy); within the running turn, switching
    // to #auto answers further approval requests automatically.
    setMode: async (m) => { mode = m; },
    // Like the mode, applies from the next turn/start.
    setModel: (m, e) => {
      const p = switching.then(async () => {
        const choice = m ?? selectedChoice;
        if (choice) { ({model,effort} = await resolveModel(choice,e ?? effort,m ? undefined : model)); selectedChoice = choice; }
        else if (e) effort = e;
      });
      switching = p.catch(() => {});
      return p;
    },
    resolveApproval: (approvalId, allow, message, answers) => {
      const p = pending.get(approvalId);
      if (!p) return;
      pending.delete(approvalId);
      byRequest.delete(String(p.requestId));
      respond(p.requestId, p.reply(allow, message, answers));
    },
    close: () => {
      if (closing) return;
      closing = true;
      activity.stop(); subagents?.stop();
      pending.clear();
      child.stdin.end();
      child.kill();
    },
  };
};

function stripNulls(o: Json): Json {
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
}
