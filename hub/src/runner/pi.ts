// pi engine adapter: local models (Ollama) through the pi coding agent, one `pi --mode rpc` process
// per session. Commands go in on stdin as JSONL, events and responses come out on stdout (checked
// against pi 1.5.0): `prompt` starts a run, `steer` adds to the running one (#now), `abort` stops it
// along with the command it runs, and `agent_settled` says pi has nothing more to do.
//
// pi itself never asks before a tool runs. The desk extension (pi-extension.ts) does: its confirm
// requests become approval cards here, or are answered yes at once under #auto. Work starts only
// after the extension reports in, so a pi that failed to load it never runs tools unasked.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_MODELS, PI_DEFAULT_CONTEXT, type Effort, type ModelName } from '../../../shared/compose.ts';
import type { RunnerEvent } from '../../../shared/protocol.ts';
import { config } from '../config.ts';
import { StderrTail, clipResult, stopTree, type StartEngine } from './engine.ts';
import { deskInstructions } from './instructions.ts';
import { TITLE_PREFIX } from './pi-extension.ts';

const PI_BIN = config.piBin;
const PROVIDER = 'ollama';
const EXTENSION = join(import.meta.dirname, 'pi-extension.ts');
/** Default family when the task names none: the light one. */
const DEFAULT_FAMILY: ModelName = 'gemma';
/** How long pi gets to start and load the desk extension. */
const READY_MS = 30_000;

type Json = any;

/** pi's thinking level for a desk effort (pi has the same names). */
const thinking = (e?: Effort) => (!e ? 'medium' : e === 'ultra' ? 'max' : e);

/**
 * The model a family tag runs among those pi lists: names containing the family, the newest version
 * (gemma4 over gemma3), then the smallest (12b over 26b). Undefined when none.
 */
export function piModelId(ids: string[], family: string): string | undefined {
  const version = (id: string) => Number(id.toLowerCase().match(new RegExp(`${family}(\\d+(?:\\.\\d+)?)`))?.[1] ?? 0);
  const size = (id: string) => Number(id.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? Infinity);
  return ids.filter((id) => id.toLowerCase().includes(family) && !id.includes(VARIANT))
    .sort((a, b) => version(b) - version(a) || size(a) - size(b) || a.localeCompare(b))[0];
}

/** The model ids `pi --list-models <provider>` prints (its table's second column). */
export function parseModelList(out: string): string[] {
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[0] === PROVIDER && c[1]).map((c) => c[1]);
}

// --- Context size ---
// Ollama's OpenAI API (the one pi speaks) ignores a context size sent with a request, so each size
// gets an Ollama variant of the model (`gemma4:12b-desk-64k`: num_ctx set, weights shared) and a pi
// entry for it whose contextWindow is that size, so pi compacts before Ollama would cut the start.

/** Marks the desk's variants in model names. */
const VARIANT = '-desk-';
const MODELS_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'models.json');

/** The variant of `base` at `ctx` tokens. */
export const variantName = (base: string, ctx: number) => `${base}${base.includes(':') ? '' : ':latest'}${VARIANT}${Math.round(ctx / 1024)}k`;

/**
 * pi's models.json with an entry for `name` (a copy of `base`'s, at `ctx` tokens), or null when it
 * already has one at that size. Other entries stay as they are.
 */
export function withVariant(doc: Json, base: string, name: string, ctx: number): Json | null {
  const provider = doc?.providers?.[PROVIDER];
  if (!provider) throw new Error(`pi 설정(models.json)에 ${PROVIDER} provider가 없습니다`);
  const models: Json[] = Array.isArray(provider.models) ? provider.models : [];
  if (models.find((m) => m?.id === name)?.contextWindow === ctx) return null;
  const entry = { ...(models.find((m) => m?.id === base) ?? {}), id: name, contextWindow: ctx };
  const next = models.some((m) => m?.id === name) ? models.map((m) => (m?.id === name ? entry : m)) : [...models, entry];
  return { ...doc, providers: { ...doc.providers, [PROVIDER]: { ...provider, models: next } } };
}

/** Ollama's own API root, from pi's provider URL (its OpenAI API ends in /v1). */
function ollamaRoot(doc: Json): string {
  return String(doc?.providers?.[PROVIDER]?.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
}

/** Makes Ollama's variant unless it exists. */
async function ensureOllamaVariant(root: string, base: string, name: string, ctx: number) {
  const post = (path: string, body: Json) => fetch(`${root}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  if ((await post('/api/show', { model: name })).ok) return;
  // A base Ollama lacks would be looked for in the registry (slow, then a failure).
  if (!(await post('/api/show', { model: base })).ok) throw new Error(`Ollama에 ${base} 모델이 없습니다 (pi 설정의 모델 이름 확인)`);
  const res = await post('/api/create', { model: name, from: base, parameters: { num_ctx: ctx }, stream: false });
  if (!res.ok) throw new Error(`Ollama에 ${name}을(를) 만들지 못했습니다: ${(await res.text()).slice(0, 200)}`);
}

/** One preparation at a time: two sessions starting together would race on models.json. */
let preparing: Promise<unknown> = Promise.resolve();
/**
 * The variant each family runs at `ctx`, made in Ollama and registered with pi first (pi reads
 * models.json only when it starts, so every family's is ready for a later model switch). A family
 * whose model fails is left out, with the reason.
 */
function prepareVariants(ctx: number): Promise<{ variants: Partial<Record<ModelName, string>>; errors: Partial<Record<ModelName, string>> }> {
  const run = preparing.then(async () => {
    const ids = await listModels();
    let doc = JSON.parse(readFileSync(MODELS_FILE, 'utf8'));
    const root = ollamaRoot(doc);
    const variants: Partial<Record<ModelName, string>> = {}, errors: Partial<Record<ModelName, string>> = {};
    for (const family of ENGINE_MODELS.pi) {
      const base = piModelId(ids, family);
      if (!base) { errors[family] = `pi 모델 목록(${PROVIDER})에 #${family} 계열이 없습니다`; continue; }
      const name = variantName(base, ctx);
      try {
        await ensureOllamaVariant(root, base, name, ctx);
        doc = withVariant(doc, base, name, ctx) ?? doc;
        variants[family] = name;
      } catch (err) { errors[family] = err instanceof Error ? err.message : String(err); }
    }
    // Written only when an entry was added, whole at once (a reader never sees half a file).
    if (JSON.stringify(JSON.parse(readFileSync(MODELS_FILE, 'utf8'))) !== JSON.stringify(doc)) {
      writeFileSync(`${MODELS_FILE}.desk-tmp`, JSON.stringify(doc, null, 2) + '\n');
      renameSync(`${MODELS_FILE}.desk-tmp`, MODELS_FILE);
    }
    return { variants, errors };
  });
  preparing = run.catch(() => {});
  return run;
}

let modelList: Promise<string[]> | null = null;
function listModels(): Promise<string[]> {
  modelList ??= new Promise<string[]>((resolve, reject) => {
    execFile(PI_BIN, ['--offline', '--list-models', PROVIDER], { timeout: 60_000 }, (err, stdout) => {
      if (err) { modelList = null; reject(err); return; }
      resolve(parseModelList(stdout));
    });
  });
  return modelList;
}

/** A pi tool call as the desk shows it: commands as Bash, files with their path. */
export function toolView(name: string, args: Json): { name: string; input: Json } {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'bash') return { name: 'Bash', input: { command: a.command ?? '' } };
  const label = ({ read: 'Read', edit: 'Edit', write: 'Write' } as Record<string, string>)[name] ?? name;
  if (typeof a.path === 'string') {
    const { path, content, ...rest } = a;
    return { name: label, input: { file_path: path, ...rest, ...(typeof content === 'string' ? { content: clipResult(content) } : {}) } };
  }
  return { name: label, input: a };
}

/** The text of a tool result's content blocks. */
const resultText = (r: Json) => (Array.isArray(r?.content) ? r.content : [])
  .map((c: Json) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n');

/** An assistant message's visible text (thinking left out). */
const messageText = (m: Json) => typeof m?.content === 'string' ? m.content
  : (Array.isArray(m?.content) ? m.content : []).filter((c: Json) => c?.type === 'text').map((c: Json) => c.text).join('\n');

export const startPi: StartEngine = (opts) => {
  const { sessionId, emit } = opts;
  const event = (e: RunnerEvent) => emit({ type: 'event', sessionId, event: e });
  let mode = opts.permissionMode;
  let family: ModelName = opts.model ?? DEFAULT_FAMILY;
  let effort = opts.effort;
  /** The model and thinking level pi runs; a different wanted one is set before the next run. */
  let running: { model: string; thinking: string } | null = null;
  let closing = false;
  /** A run is going (prompt sent, agent_settled not yet seen). */
  let active = false;
  /** An abort was sent: the run's "aborted" error is the interruption, not a failure to show. */
  let aborting = false;
  /** Messages waiting for pi to be ready (extension loaded, session known). */
  const waiting: { text: string; skills?: string[]; steer?: boolean }[] = [];
  let ready = false;
  const stderrTail = new StderrTail();
  /** Tool calls shown, by pi's call id. */
  const tools = new Set<string>();
  /** Approval cards waiting: the confirm request id each answers. */
  const pending = new Map<string, string>();
  let nextId = 1;
  const calls = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();

  const fail = (message: string) => {
    if (closing) return;
    closing = true;
    cancelApprovals();
    emit({ type: 'busy', sessionId, busy: false });
    emit({ type: 'closed', sessionId, error: message });
    if (child) stopTree(child, 'SIGTERM');
  };

  let child: ChildProcess | null = null;
  const context = opts.context ?? PI_DEFAULT_CONTEXT;
  /** Each family's variant at this session's context size (prepareVariants). */
  let prepared: Awaited<ReturnType<typeof prepareVariants>> = { variants: {}, errors: {} };
  const modelFor = (f: ModelName) => {
    const model = prepared.variants[f];
    if (!model) throw new Error(prepared.errors[f] ?? `#${f} 모델을 준비하지 못했습니다`);
    return model;
  };
  const start = async () => {
    prepared = await prepareVariants(context);
    const model = modelFor(family);
    running = { model, thinking: thinking(effort) };
    const args = ['--mode', 'rpc', '--provider', PROVIDER, '--model', model, '--thinking', running.thinking,
      // Project-local pi resources are not trusted (their prompt would block a headless run).
      '--no-approve', '-e', EXTENSION, '--append-system-prompt', deskInstructions(opts.skillsHome),
      ...(opts.skillsHome ? ['--skill', join(opts.skillsHome, 'skills')] : []),
      ...(opts.resume ? [opts.fork ? '--fork' : '--session', opts.resume] : [])];
    const proc = spawn(PI_BIN, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    child = proc;
    proc.stdin!.on('error', () => {}); // EPIPE after the process went; 'exit' reports it
    proc.stderr!.on('data', (chunk: Buffer) => stderrTail.push(chunk));
    // JSONL split on LF only: readline would also split on U+2028/U+2029, which JSON strings may hold.
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    proc.on('error', (err) => fail(`pi 실행 실패 (${PI_BIN}): ${err.message}`));
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      for (const c of calls.values()) c.reject(new Error('pi exited'));
      calls.clear();
      if (closing) return;
      const tail = stderrTail.last(3).map((l) => `\n${l}`).join('');
      if (code === 0 && !active) { closing = true; emit({ type: 'closed', sessionId }); return; }
      fail(`pi 종료 (code ${code ?? signal})${tail}`);
    });
    setTimeout(() => { if (!ready && !closing) fail('pi에 데스크 승인 확장이 올라오지 않아 시작하지 않았습니다'); }, READY_MS).unref();
  };

  const write = (msg: Json) => { if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n'); };
  const request = (msg: Json) => new Promise<Json>((resolve, reject) => {
    const id = `d${nextId++}`;
    calls.set(id, { resolve, reject });
    write({ ...msg, id });
  });

  const cancelApprovals = () => {
    for (const [approvalId, uiId] of pending) {
      emit({ type: 'approval_cancelled', sessionId, approvalId });
      write({ type: 'extension_ui_response', id: uiId, confirmed: false });
    }
    pending.clear();
  };

  const onUi = (m: Json) => {
    if (m.method === 'setStatus' && m.statusKey === 'agent-desk') { if (!ready) void onReady(); return; }
    if (m.method !== 'confirm' && m.method !== 'select' && m.method !== 'input' && m.method !== 'editor') return;
    // Only the desk extension's confirms are approvals; another extension's dialog is declined.
    if (m.method !== 'confirm' || !String(m.title ?? '').startsWith(TITLE_PREFIX)) {
      write({ type: 'extension_ui_response', id: m.id, cancelled: true });
      return;
    }
    if (mode === 'auto') { write({ type: 'extension_ui_response', id: m.id, confirmed: true }); return; }
    let input: Json = {};
    try { input = JSON.parse(String(m.message ?? '{}')); } catch { /* shown empty */ }
    const view = toolView(String(m.title).slice(TITLE_PREFIX.length), input);
    const approvalId = randomUUID();
    pending.set(approvalId, m.id);
    emit({ type: 'approval_request', sessionId, approvalId, toolName: view.name, input: view.input });
  };

  const onLine = (line: string) => {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    switch (m.type) {
      case 'response': {
        const c = calls.get(m.id);
        if (!c) return;
        calls.delete(m.id);
        if (m.success) c.resolve(m.data); else c.reject(new Error(m.error ?? `${m.command} 실패`));
        return;
      }
      case 'extension_ui_request': onUi(m); return;
      case 'message_end': {
        const msg = m.message ?? {};
        if (msg.role !== 'assistant') return;
        const text = messageText(msg).trim();
        if (text) event({ kind: 'assistant', text });
        if (msg.stopReason === 'error' && !aborting) event({ kind: 'status', state: 'error', detail: { message: String(msg.errorMessage ?? '모델 오류') } });
        return;
      }
      case 'tool_execution_start': {
        if (tools.has(m.toolCallId)) return;
        tools.add(m.toolCallId);
        const view = toolView(m.toolName, m.args);
        event({ kind: 'tool', toolUseId: m.toolCallId, name: view.name, input: view.input });
        return;
      }
      case 'tool_execution_end':
        if (!tools.delete(m.toolCallId)) return;
        event({ kind: 'tool_result', toolUseId: m.toolCallId, isError: !!m.isError, text: clipResult(resultText(m.result)) });
        return;
      case 'extension_error':
        event({ kind: 'status', state: 'warning', detail: { message: `pi 확장 오류: ${m.error ?? ''}` } });
        return;
      case 'agent_settled': {
        if (!active) return;
        active = false;
        aborting = false;
        for (const id of tools) event({ kind: 'tool_result', toolUseId: id, isError: true, text: m.aborted ? '중단됨' : '끝나지 않음' });
        tools.clear();
        cancelApprovals();
        event({ kind: 'status', state: m.aborted ? 'interrupted' : 'turn_done', detail: { subtype: m.aborted ? 'interrupted' : 'completed' } });
        flush();
        return;
      }
    }
  };

  const onReady = async () => {
    try {
      const state = await request({ type: 'get_state' });
      if (state?.sessionId) emit({ type: 'engine_session', sessionId, engineSessionId: state.sessionId });
      event({ kind: 'status', state: 'started', detail: {
        model: state?.model?.id ?? running?.model, cwd: opts.cwd, reasoning_effort: state?.thinkingLevel,
        ...(opts.resume ? (opts.fork ? { forked: true } : { resumed: true }) : {}),
      } });
      ready = true;
      flush();
    } catch (err) {
      fail(`pi 세션 정보를 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const turnText = (text: string, skills?: string[]) => {
    if (!skills?.length || !opts.skillsHome) return text || '(추가 지시 없음)';
    const files = skills.map((s) => join(opts.skillsHome!, 'skills', s, 'SKILL.md')).join(', ');
    return `[데스크 스킬] 이 메시지에는 먼저 다음 스킬 파일을 읽고 그 지침을 따르세요: ${files}\n\n${text || '(추가 지시 없음)'}`;
  };

  /** A model or effort chosen since: set before the next run. */
  const applyModel = async () => {
    const wanted = modelFor(family);
    if (running && wanted !== running.model) {
      await request({ type: 'set_model', provider: PROVIDER, modelId: wanted });
      running.model = wanted;
      event({ kind: 'status', state: 'model_changed', detail: { model: wanted, reasoning_effort: thinking(effort) } });
    }
    if (running && thinking(effort) !== running.thinking) {
      await request({ type: 'set_thinking_level', level: thinking(effort) });
      running.thinking = thinking(effort);
    }
  };

  /** Sends what waited: a steer into the running run, else the next message as a new run. */
  const flush = () => {
    if (!ready || closing) return;
    while (waiting.length && active && waiting[0].steer) {
      const m = waiting.shift()!;
      write({ type: 'steer', message: turnText(m.text, m.skills) });
    }
    if (active) return;
    const next = waiting.shift();
    if (!next) { emit({ type: 'busy', sessionId, busy: false }); return; }
    active = true;
    void applyModel().then(() => request({ type: 'prompt', message: turnText(next.text, next.skills) })).catch((err: Error) => {
      if (closing) return;
      active = false;
      event({ kind: 'status', state: 'error', detail: { message: `pi 턴 시작 실패: ${err.message}` } });
      flush();
    });
  };

  const send = (text: string, skills?: string[], steer?: boolean) => {
    if (closing) return;
    emit({ type: 'busy', sessionId, busy: true });
    waiting.push({ text, skills, steer });
    flush();
  };

  start().catch((err: Error) => fail(`pi를 시작하지 못했습니다: ${err.message}`));
  send(opts.prompt, opts.skills);

  return {
    send,
    interrupt: async () => {
      waiting.length = 0;
      cancelApprovals();
      if (active) { aborting = true; write({ type: 'abort' }); }
    },
    // #auto also answers the approvals waiting now.
    setMode: async (m) => {
      mode = m;
      if (m !== 'auto') return;
      for (const [approvalId, uiId] of pending) {
        emit({ type: 'approval_cancelled', sessionId, approvalId });
        write({ type: 'extension_ui_response', id: uiId, confirmed: true });
      }
      pending.clear();
    },
    // Applied before the next run (set_model / set_thinking_level).
    setModel: async (m, e) => {
      if (m) family = m;
      if (e) effort = e;
    },
    resolveApproval: (approvalId, allow) => {
      const uiId = pending.get(approvalId);
      if (!uiId) return;
      pending.delete(approvalId);
      write({ type: 'extension_ui_response', id: uiId, confirmed: allow });
    },
    close: () => {
      if (closing) return;
      closing = true;
      cancelApprovals();
      if (child) { child.stdin?.end(); stopTree(child, 'SIGTERM'); }
      child = null;
    },
  };
};
