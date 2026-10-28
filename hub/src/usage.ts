// How much of each engine's plan limits is used, and when each window resets. All three are
// account-wide figures (terminal use counts too), read without running a model:
//   Claude  the Agent SDK's usage call (the data behind /usage; experimental in the SDK)
//   Codex   `codex app-server`'s account/rateLimits/read
//   agy     `agy -p /usage --output-format json`

import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ENGINES, type EngineName } from './compose.ts';

/** One limit window. `usedPercent`: 0–100, null when the engine doesn't say. */
export interface UsageWindow { label: string; usedPercent: number | null; resetsAt: string | null }
export interface EngineUsage { engine: EngineName; plan: string | null; windows: UsageWindow[]; error?: string; fetchedAt: string }

const TIMEOUT_MS = 30_000;
/** Answers within this long reuse the last reading, unless a refresh is asked for. */
const CACHE_MS = 60_000;
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const AGY_BIN = process.env.AGY_BIN || 'agy';

type Json = any;

const windowLabel = (mins: number | null | undefined) =>
  mins == null ? '한도' : mins === 300 ? '5시간' : mins === 10080 ? '주간' : mins % 1440 === 0 ? `${mins / 1440}일` : mins % 60 === 0 ? `${mins / 60}시간` : `${mins}분`;

const iso = (v: unknown): string | null => {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 응답 없음 (${TIMEOUT_MS / 1000}초)`)), TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Claude: the plan's meters as the server lists them (session, weekly, weekly per model). */
export function claudeWindows(r: Json): UsageWindow[] {
  const rows: Json[] = r?.limits ?? [];
  if (rows.length) {
    return rows.map((x) => ({
      label: x.kind === 'session' ? '5시간'
        : x.kind === 'weekly_all' ? '주간 (전체)'
        : x.group === 'weekly' ? `주간 (${x.scope?.model?.display_name ?? x.scope?.surface ?? x.kind})`
        : x.kind,
      usedPercent: typeof x.percent === 'number' ? x.percent : null,
      resetsAt: iso(x.resets_at),
    }));
  }
  // Older servers: the fixed windows only.
  return ([['five_hour', '5시간'], ['seven_day', '주간 (전체)'], ['seven_day_opus', '주간 (Opus)'], ['seven_day_sonnet', '주간 (Sonnet)']] as const)
    .filter(([k]) => r?.[k]).map(([k, label]) => ({ label, usedPercent: r[k].utilization ?? null, resetsAt: iso(r[k].resets_at) }));
}

async function claude(): Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>> {
  // A session that never gets a prompt: only its control channel is used.
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = query({ prompt: idle, options: { cwd: tmpdir() } });
  try {
    const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 'Claude');
    if (!u.rate_limits_available || !u.rate_limits) return { plan: u.subscription_type, windows: [], error: '구독 한도 정보가 없습니다 (API 키 사용 등)' };
    return { plan: u.subscription_type, windows: claudeWindows(u.rate_limits) };
  } finally {
    q.close();
  }
}

/** Codex: each limit's primary and secondary windows. */
export function codexWindows(r: Json): UsageWindow[] {
  const snaps: Json[] = Object.values(r?.rateLimitsByLimitId ?? {}).filter(Boolean);
  if (!snaps.length && r?.rateLimits) snaps.push(r.rateLimits);
  return snaps.flatMap((s) => [s.primary, s.secondary].filter(Boolean).map((w: Json) => ({
    label: `${windowLabel(w.windowDurationMins)}${snaps.length > 1 ? ` (${s.limitName ?? s.limitId})` : ''}`,
    usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null,
    resetsAt: iso(w.resetsAt),
  })));
}

function codex(): Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>> {
  const child = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: tmpdir() });
  const calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let id = 0;
  const request = (method: string, params: Json) => new Promise<Json>((resolve, reject) => {
    calls.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  child.on('error', (err) => { for (const c of calls.values()) c.reject(err); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    const c = m.method === undefined ? calls.get(m.id) : undefined;
    if (!c) return;
    calls.delete(m.id);
    if (m.error) c.reject(new Error(m.error.message ?? JSON.stringify(m.error))); else c.resolve(m.result);
  });
  return withTimeout((async () => {
    await request('initialize', { clientInfo: { name: 'agent-desk', title: 'Agent Desk', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const r = await request('account/rateLimits/read', null);
    return { plan: r?.rateLimits?.planType ?? null, windows: codexWindows(r) };
  })(), 'Codex').finally(() => child.kill());
}

/** agy: buckets by model group; it reports what remains, the desk shows what is used. */
export function agyWindows(data: Json): UsageWindow[] {
  return (data?.groups ?? []).flatMap((g: Json) => (g.buckets ?? []).map((b: Json) => ({
    label: `${g.name} · ${b.window === '5h' ? '5시간' : b.window === 'weekly' ? '주간' : b.window ?? b.name}`,
    usedPercent: typeof b.remaining_fraction === 'number' ? Math.round((1 - b.remaining_fraction) * 100) : null,
    resetsAt: iso(b.reset_time),
  })));
}

function agy(): Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>> {
  return new Promise((resolve, reject) => {
    execFile(AGY_BIN, ['-p', '/usage', '--output-format', 'json'], { cwd: tmpdir(), timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) { reject(err); return; }
      try {
        const r = JSON.parse(stdout);
        if (r.status !== 'SUCCESS') throw new Error(r.error?.message ?? r.error ?? r.status);
        resolve({ plan: null, windows: agyWindows(r.command?.data) });
      } catch (e) { reject(e); }
    });
  });
}

const READERS: Record<EngineName, () => Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>>> = { claude, codex, agy };

/** The last reading per engine. Engines are read separately: agy alone takes several seconds. */
const last = new Map<EngineName, { at: number; value: Promise<EngineUsage> }>();

/** One engine's usage; a failure comes back as `error`, not as a rejection. */
export function readEngineUsage(engine: EngineName, refresh = false): Promise<EngineUsage> {
  const cached = last.get(engine);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const fetchedAt = new Date().toISOString();
  const value: Promise<EngineUsage> = READERS[engine]().then(
    (r) => ({ engine, fetchedAt, ...r }),
    (e) => ({ engine, fetchedAt, plan: null, windows: [], error: e instanceof Error ? e.message : String(e) }));
  last.set(engine, { at: Date.now(), value });
  return value;
}

/** Every engine's usage, once all have answered. */
export const readUsage = (refresh = false) => Promise.all(ENGINES.map((e) => readEngineUsage(e, refresh)));
