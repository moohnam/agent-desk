import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads a terminal Claude Code or Codex session from its local session file, so the desk can take
 * it over (desk_handoff): the conversation id to resume, the directory it ran in, and its history.
 * History keeps what the user and the agent said; tool calls come down to their names.
 */

export type Engine = 'claude' | 'codex';
export interface ImportedEvent { ts: string; kind: 'user' | 'assistant' | 'tool'; text?: string; name?: string }
export interface ImportedSession { engine: Engine; id: string; cwd: string | null; file: string; events: ImportedEvent[] }

/** Newest history kept: a long session has thousands of tool calls the thread need not page through. */
const MAX_EVENTS = 3000;
const ID = /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/;

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
/** How Claude Code names a working directory's folder under projects/. */
const claudeDir = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * The session file for `id`, or without an id the most recently written session that ran in `cwd`
 * (the calling agent's own, which is writing its file right now).
 */
export function findSession(engine: Engine, id: string | undefined, cwd: string): ImportedSession {
  if (id && !ID.test(id)) throw new Error(`세션 ID 형식이 아닙니다: ${id}`);
  const file = engine === 'claude' ? findClaude(id, cwd) : findCodex(id, cwd);
  if (!file) throw new Error(id ? `${engine} 세션 파일을 찾지 못했습니다: ${id}` : `${cwd}에서 실행한 ${engine} 세션을 찾지 못했습니다. session_id를 넘겨 주세요`);
  return engine === 'claude' ? readClaude(file) : readCodex(file);
}

function newest(files: string[]): string | undefined {
  return files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f;
}

function findClaude(id: string | undefined, cwd: string): string | undefined {
  const root = join(claudeHome(), 'projects');
  if (!existsSync(root)) return undefined;
  if (!id) {
    const dir = join(root, claudeDir(cwd));
    return existsSync(dir) ? newest(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))) : undefined;
  }
  const own = join(root, claudeDir(cwd), `${id}.jsonl`);
  if (existsSync(own)) return own;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** Codex keeps sessions as sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. */
function findCodex(id: string | undefined, cwd: string): string | undefined {
  const root = join(codexHome(), 'sessions');
  if (!existsSync(root)) return undefined;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
    }
  };
  walk(root);
  if (id) return newest(files.filter((f) => f.endsWith(`-${id}.jsonl`)));
  const recent = files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 50);
  return recent.find(({ f }) => { const m = codexMeta(f); return m?.cwd === cwd && !m.source?.subagent; })?.f;
}

/** The rollout's first line, session_meta, without reading the whole file. */
function codexMeta(file: string): { id?: string; cwd?: string; source?: any } | undefined {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const d = JSON.parse(line);
    return d.type === 'session_meta' ? d.payload : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

function lines(file: string): any[] {
  const out: any[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return out;
}

/** Text the engine put in the user's place (command output, reminders, injected context). */
const injected = (t: string) => t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('# AGENTS.md');

function push(events: ImportedEvent[], ts: string, kind: 'user' | 'assistant', text: string) {
  const t = text.trim();
  if (t && !(kind === 'user' && injected(t))) events.push({ ts, kind, text: t });
}

function readClaude(file: string): ImportedSession {
  const events: ImportedEvent[] = [];
  let id = '', cwd: string | null = null;
  for (const d of lines(file)) {
    if (d.sessionId) id = d.sessionId;
    if (d.cwd) cwd = d.cwd;
    if (d.isMeta || d.isSidechain || d.isCompactSummary) continue;
    const ts = d.timestamp ?? '';
    const content = d.message?.content;
    if (d.type === 'user') {
      if (typeof content === 'string') push(events, ts, 'user', content);
      else if (Array.isArray(content)) {
        const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        push(events, ts, 'user', text);
      }
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') push(events, ts, 'assistant', b.text ?? '');
        else if (b.type === 'tool_use') events.push({ ts, kind: 'tool', name: b.name });
      }
    }
  }
  return { engine: 'claude', id: id || file.replace(/^.*\//, '').replace(/\.jsonl$/, ''), cwd, file, events: events.slice(-MAX_EVENTS) };
}

function readCodex(file: string): ImportedSession {
  const events: ImportedEvent[] = [];
  let id = '', cwd: string | null = null;
  for (const d of lines(file)) {
    const p = d.payload ?? {};
    const ts = d.timestamp ?? '';
    // A subagent's rollout repeats its parent's session_meta after its own.
    if (d.type === 'session_meta') { if (!id) { id = p.id ?? ''; cwd = p.cwd ?? cwd; } continue; }
    if (d.type === 'turn_context' && p.cwd) cwd = p.cwd;
    if (d.type !== 'response_item') continue;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content ?? []).map((c: any) => c.text ?? '').join('\n');
      push(events, ts, p.role, text);
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) {
      events.push({ ts, kind: 'tool', name: p.name });
    }
  }
  if (!id) throw new Error(`Codex 세션 파일에 session_meta가 없습니다: ${file}`);
  return { engine: 'codex', id, cwd, file, events: events.slice(-MAX_EVENTS) };
}
