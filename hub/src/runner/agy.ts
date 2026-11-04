// Antigravity CLI (agy) engine adapter: drives `agy` in stream-json mode (one NDJSON message per
// line on stdin, one turn each; events on stdout), one process per session. Checked against agy 1.4.8.
//
// Headless agy can't ask anyone, so it denies whatever needs approval. Approvals come through a
// PreToolUse hook instead: ~/.gemini/config/hooks.json runs agy-hook.sh before every tool call, and
// the hook posts the call to the small HTTP server this adapter opens (its address and token reach
// the hook through the environment agy passes on). The reply, `auto_approve` or `deny`, is held
// until the user decides on the desk, for up to APPROVAL_TIMEOUT_MS. agy processes not started by
// the desk lack the address, and the hook leaves them to agy's default.
//
// agy has no interrupt message: interrupting kills the process, and the next message starts a new
// one that resumes the conversation (`--conversation`). A model change does the same between turns.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Effort, ModelName } from '../../../shared/compose.ts';
import { config } from '../config.ts';
import { deskInstructions } from './instructions.ts';
import { StderrTail, TurnQueue, clipResult, stopTree, type StartEngine } from './engine.ts';
import { latestOfFamily } from './models.ts';
import type { RunnerEvent } from '../../../shared/protocol.ts';

const AGY_BIN = config.agyBin;
/** How long an approval may wait for the user; the hook's own timeout in hooks.json is a little longer. */
const APPROVAL_TIMEOUT_MS = 60 * 60_000;
/** Without a tag, the middle level (agy's models come in low, medium and high only). */
const DEFAULT_LEVEL = 'medium';
/** Default model family when the task names none. */
const DEFAULT_FAMILY: ModelName = 'flash';

/**
 * Tools #ask lets through without asking: they only read the workspace or wait. Edits, commands,
 * the browser, web access and everything else come to the desk.
 */
const READ_ONLY = new Set([
  'view_file', 'read_file', 'list_dir', 'find_by_name', 'grep_search', 'command_status', 'wait', 'wait_5_seconds',
  'list_permissions', 'list_resources', 'read_resource', 'manage_task', 'finish',
]);

type Json = any;

/** agy's model level for a desk effort: #xhigh and #max run as high. */
const level = (e?: Effort) => (!e ? DEFAULT_LEVEL : e === 'low' || e === 'medium' ? e : 'high');

/** An agy tool call as the desk shows it: commands as Bash, a file path where the call has one. */
export function toolView(name: string, args: Json): { name: string; input: Json } {
  const a = args && typeof args === 'object' ? { ...args } : {};
  const description = typeof a.toolSummary === 'string' ? a.toolSummary : undefined;
  delete a.toolSummary;
  if (name === 'run_command') return { name: 'Bash', input: { command: a.CommandLine ?? '', cwd: a.Cwd, description } };
  const file = a.TargetFile ?? a.AbsolutePath ?? a.FilePath ?? a.File ?? a.Path;
  return { name, input: typeof file === 'string' ? { file_path: file, ...a } : { ...a, ...(description && { description }) } };
}

/** The model id for a family at a level, the newest version agy lists, e.g. flash + low → gemini-3.8-flash-low. */
export function agyModelId(ids: string[], family: string, lvl: string): string | undefined {
  const byFamily = ids.filter((id) => id.endsWith(`-${family}-${lvl}`)).map((id) => id.slice(0, -lvl.length - 1));
  const base = latestOfFamily(byFamily, family);
  return base && `${base}-${lvl}`;
}

let modelList: Promise<string[]> | null = null;
/** `agy models`, once per runner (a failure is retried next time). */
function listModels(): Promise<string[]> {
  modelList ??= new Promise<string[]>((resolve, reject) => {
    execFile(AGY_BIN, ['models'], { timeout: 60_000 }, (err, stdout) => {
      if (err) { modelList = null; reject(err); return; }
      resolve(stdout.split('\n').map((l) => l.split('\t')[0].trim()).filter((id) => /^[a-z0-9.-]+$/.test(id)));
    });
  });
  return modelList;
}

/** A message waiting for its turn. */
interface Turn { text: string; skills?: string[] }

/** An approval the user answers: the hook's held HTTP response. */
interface Pending { res: ServerResponse; timer: NodeJS.Timeout }

export const startAgy: StartEngine = (opts) => {
  const { sessionId, emit } = opts;
  const event = (e: RunnerEvent) => emit({ type: 'event', sessionId, event: e });
  let mode = opts.permissionMode;
  let family: ModelName = opts.model ?? DEFAULT_FAMILY;
  let effort = opts.effort;
  /** The model id the running process uses; a different wanted one restarts it between turns. */
  let running: string | null = null;
  /** The model the feed last heard of. */
  let reported: string | undefined;
  let conversationId: string | null = opts.fork ? null : opts.resume ?? null;
  let child: ChildProcess | null = null;
  let closing = false;
  /** agy can't add to a running turn, so every message waits for the turn before it. */
  const turns = new TurnQueue<Turn>((turn) => void startTurn(turn), (busy) => emit({ type: 'busy', sessionId, busy }));
  const pending = new Map<string, Pending>();
  const stderrTail = new StderrTail();
  /** The last stderr lines, to add to a message about the process ending. */
  const tail = () => stderrTail.last(3).map((l) => `\n${l}`).join('');
  /** Text of the agent message being streamed, by step. */
  const texts = new Map<number, string>();
  /** Tool steps already shown, by step index (a step reports ACTIVE and then DONE). */
  const toolIds = new Map<number, string>();
  // A resumed conversation also needs the current runner instructions, once per adapter.
  let first = true;

  // --- Approvals: the hook's requests ---
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      let call: Json;
      try { call = JSON.parse(body)?.toolCall ?? {}; } catch { call = {}; }
      const name = String(call.name ?? '');
      if (mode === 'auto' || READ_ONLY.has(name)) { decide(res, true, mode === 'auto' ? '#auto' : '읽기 전용 도구'); return; }
      const approvalId = randomUUID();
      const timer = setTimeout(() => {
        if (!pending.delete(approvalId)) return;
        emit({ type: 'approval_cancelled', sessionId, approvalId });
        decide(res, false, '데스크에서 1시간 동안 결정이 없어 거부했습니다');
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      pending.set(approvalId, { res, timer });
      // The hook was killed (agy interrupted or timed out): the card goes away.
      res.on('close', () => {
        const p = pending.get(approvalId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(approvalId);
        emit({ type: 'approval_cancelled', sessionId, approvalId });
      });
      const view = toolView(name, call.args);
      emit({ type: 'approval_request', sessionId, approvalId, toolName: view.name, input: view.input });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  const decide = (res: ServerResponse, allow: boolean, reason: string) => {
    if (res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ decision: allow ? 'auto_approve' : 'deny', reason }));
  };
  const cancelApprovals = () => {
    for (const [approvalId, p] of pending) {
      clearTimeout(p.timer);
      emit({ type: 'approval_cancelled', sessionId, approvalId });
      decide(p.res, false, '작업이 중단되었습니다');
    }
    pending.clear();
  };

  // --- Turn events ---
  const toolStart = (s: Json) => {
    if (toolIds.has(s.step_index)) return;
    const id = randomUUID();
    toolIds.set(s.step_index, id);
    const view = toolView(s.tool_info?.name ?? s.tool_name ?? 'tool', s.tool_info?.parameters);
    event({ kind: 'tool', toolUseId: id, name: view.name, input: view.input });
  };

  const onStep = (s: Json) => {
    if (s.step_type === 'agent_response') {
      if (s.text_delta) texts.set(s.step_index, (texts.get(s.step_index) ?? '') + s.text_delta);
      if (s.state !== 'ACTIVE') {
        const text = texts.get(s.step_index)?.trim();
        texts.delete(s.step_index);
        if (text) event({ kind: 'assistant', text });
      }
    } else if (s.step_type === 'tool') {
      toolStart(s);
      if (s.state !== 'ACTIVE') {
        const info = s.tool_info ?? {};
        const isError = s.state === 'ERROR' || !!info.error;
        event({ kind: 'tool_result', toolUseId: toolIds.get(s.step_index)!, isError,
          text: clipResult(String(info.error?.message ?? info.output ?? '')) });
        toolIds.delete(s.step_index);
      }
    }
  };

  const turnEnded = (state: 'turn_done' | 'error' | 'interrupted', detail: Record<string, unknown>) => {
    if (!turns.active) return;
    // Text cut off mid-stream still reaches the feed.
    for (const text of texts.values()) if (text.trim()) event({ kind: 'assistant', text: text.trim() });
    texts.clear();
    for (const id of toolIds.values()) event({ kind: 'tool_result', toolUseId: id, isError: true, text: state === 'interrupted' ? '중단됨' : '끝나지 않음' });
    toolIds.clear();
    event({ kind: 'status', state, detail });
    turns.ended();
  };

  const onLine = (line: string) => {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    switch (msg.event) {
      case 'init': {
        const id = msg.conversation_id as string;
        const resumed = !!conversationId;
        if (id && id !== conversationId) { conversationId = id; emit({ type: 'engine_session', sessionId, engineSessionId: id }); }
        if (msg.init?.model && msg.init.model !== reported) {
          const firstReport = reported === undefined;
          reported = msg.init.model;
          event({ kind: 'status', state: firstReport ? 'started' : 'model_changed', detail: {
            model: msg.init.model, cwd: msg.init.cwd, ...(firstReport && resumed ? { resumed: true } : {}),
          } });
        }
        break;
      }
      case 'step_update': onStep(msg.step_update ?? {}); break;
      case 'result': {
        const r = msg.result ?? {};
        const denied = (r.denied_actions ?? []).map((d: Json) => d.display_name ?? d.action);
        turnEnded(r.status === 'SUCCESS' ? 'turn_done' : 'error', {
          subtype: String(r.status ?? '').toLowerCase(), duration_ms: r.duration_seconds != null ? Math.round(r.duration_seconds * 1000) : undefined,
          ...(r.error ? { message: typeof r.error === 'string' ? r.error : r.error.message ?? JSON.stringify(r.error) } : {}),
          ...(denied.length ? { denied } : {}),
        });
        break;
      }
    }
  };

  /** The process for `model`, started (resuming the conversation) or restarted if it runs another model. */
  const processFor = async (model: string): Promise<ChildProcess> => {
    if (child && running === model) return child;
    if (child) { const old = child; child = null; old.stdin?.end(); stopTree(old, 'SIGTERM'); }
    const port = await listening;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
      ...(conversationId ? ['--conversation', conversationId] : [])];
    const proc = spawn(AGY_BIN, args, {
      cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_DESK_AGY_URL: `http://127.0.0.1:${port}/approve`, AGENT_DESK_AGY_TOKEN: token },
    });
    child = proc;
    running = model;
    stderrTail.clear();
    proc.stdin!.on('error', () => {}); // EPIPE after the process went; 'exit' reports it
    proc.stderr!.on('data', (chunk: Buffer) => stderrTail.push(chunk));
    createInterface({ input: proc.stdout! }).on('line', (line) => { if (child === proc) onLine(line); });
    const gone = (message?: string) => {
      if (child !== proc) return;
      child = null;
      running = null;
      if (closing) return;
      cancelApprovals();
      turnEnded('error', { message: message ?? `agy 종료${tail()}` });
    };
    proc.on('error', (err) => gone(`agy 실행 실패 (${AGY_BIN}): ${err.message}`));
    proc.on('exit', (code, signal) => gone(code === 0 && !turns.active ? undefined : `agy 종료 (code ${code ?? signal})${tail()}`));
    return proc;
  };

  const turnText = (turn: Turn) => {
    let text = turn.text || '(추가 지시 없음)';
    if (turn.skills?.length && opts.skillsHome) {
      const files = turn.skills.map((s) => join(opts.skillsHome!, 'skills', s, 'SKILL.md')).join(', ');
      text = `[데스크 스킬] 이 메시지에는 먼저 다음 스킬 파일을 읽고 그 지침을 따르세요: ${files}\n\n${text}`;
    }
    if (first) { first = false; text = `[데스크 지침]\n${deskInstructions(opts.skillsHome)}\n\n${text}`; }
    return text;
  };

  // Bumped per turn, so a turn interrupted while still looking up its model doesn't go on to run.
  let turnSeq = 0;
  /** Runs a turn; the queue calls it when the one before has ended. */
  const startTurn = async (turn: Turn) => {
    const seq = ++turnSeq;
    const current = () => !closing && turns.active && seq === turnSeq;
    try {
      const ids = await listModels();
      if (!current()) return;
      const model = agyModelId(ids, family, level(effort));
      if (!model) throw new Error(`agy 모델 목록에 #${family} (${level(effort)})이 없습니다`);
      const proc = await processFor(model);
      if (!current()) return;
      proc.stdin!.write(JSON.stringify({ event: 'user', message: { content: turnText(turn) } }) + '\n');
    } catch (err) {
      if (!current()) return;
      turnEnded('error', { message: `agy 턴 시작 실패: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  if (opts.fork) {
    event({ kind: 'status', state: 'warning', detail: { message: 'agy는 대화 복제(#fork)를 지원하지 않아 새 대화로 시작합니다' } });
  }

  const send = (text: string, skills?: string[]) => {
    if (closing) return;
    emit({ type: 'busy', sessionId, busy: true });
    // #now waits like #later (see turns).
    turns.push({ text, skills });
  };
  listening.catch((err: Error) => {
    if (closing) return;
    closing = true;
    emit({ type: 'busy', sessionId, busy: false });
    emit({ type: 'closed', sessionId, error: `agy 승인 서버를 열지 못했습니다: ${err.message}` });
  });
  send(opts.prompt, opts.skills);

  return {
    send,
    interrupt: async () => {
      turns.clear();
      cancelApprovals();
      // The process goes (its later output is dropped); the next message resumes the conversation.
      if (!turns.active) return;
      if (child) {
        const proc = child;
        child = null;
        running = null;
        stopTree(proc, 'SIGINT');
      }
      // Without a process the turn was still starting; startTurn sees it ended and stops there.
      turnEnded('interrupted', { subtype: 'interrupted' });
    },
    // #auto also answers the approvals waiting now.
    setMode: async (m) => {
      mode = m;
      if (m !== 'auto') return;
      for (const [approvalId, p] of pending) {
        clearTimeout(p.timer);
        emit({ type: 'approval_cancelled', sessionId, approvalId });
        decide(p.res, true, '#auto');
      }
      pending.clear();
    },
    // Takes effect from the next turn, which restarts the process on the new model.
    setModel: async (m, e) => {
      if (m) family = m;
      if (e) effort = e;
    },
    resolveApproval: (approvalId, allow, message) => {
      const p = pending.get(approvalId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(approvalId);
      decide(p.res, allow, allow ? '데스크에서 승인' : message || '데스크에서 거절');
    },
    close: () => {
      if (closing) return;
      closing = true;
      cancelApprovals();
      server.close();
      if (child) { child.stdin?.end(); stopTree(child, 'SIGTERM'); }
      child = null;
    },
  };
};
