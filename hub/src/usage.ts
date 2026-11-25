// How much of each engine's plan limits is used, and when each window resets. All three are
// account-wide figures (terminal use counts too), read without running a model:
//   Claude  the Agent SDK's usage call (the data behind /usage; experimental in the SDK)
//   Codex   `codex app-server`'s account/rateLimits/read
//   agy     `agy -p /usage --output-format json`

import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EngineAuth, EngineUsage, UsageWindow } from '../../shared/api.ts';
import { config } from './config.ts';
import { ENGINES, type EngineName } from '../../shared/compose.ts';

/** One limit window. `usedPercent`: 0–100, null when the engine doesn't say. */

const TIMEOUT_MS = 30_000;
/** Answers within this long reuse the last reading, unless a refresh is asked for. */
const CACHE_MS = 60_000;
const { codexBin: CODEX_BIN, agyBin: AGY_BIN } = config;
const resolveSdk = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));

type Json = any;

const windowLabel = (mins: number | null | undefined) =>
  mins == null ? '한도' : mins === 300 ? '5시간' : mins === 10080 ? '주간' : mins % 1440 === 0 ? `${mins / 1440}일` : mins % 60 === 0 ? `${mins / 60}시간` : `${mins}분`;

const iso = (v: unknown): string | null => {
  if (typeof v === 'number') {
    const value = new Date(v * 1000);
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
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
      applicability: x.scope?.surface ? 'unknown' : !x.scope?.model && (x.kind === 'session' || x.kind === 'weekly_all') ? 'all'
        : /opus/i.test(x.scope?.model?.display_name ?? '') ? 'opus'
        : /sonnet/i.test(x.scope?.model?.display_name ?? '') ? 'sonnet' : 'unknown',
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
    .filter(([k]) => r?.[k]).map(([k, label]) => ({ applicability: k === 'seven_day_opus' ? 'opus' : k === 'seven_day_sonnet' ? 'sonnet' : 'all', label, usedPercent: r[k].utilization ?? null, resetsAt: iso(r[k].resets_at) }));
}

function claudeAuth(): Promise<EngineAuth> {
  const platform = `${process.platform}-${process.arch}`;
  for (const variant of process.platform === 'linux' ? [platform, `${platform}-musl`] : [platform]) {
    let manifest: string;
    try { manifest = resolveSdk.resolve(`@anthropic-ai/claude-agent-sdk-${variant}/package.json`); }
    catch { continue; }
    const binary = join(dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude');
    return new Promise(resolve => {
      execFile(binary, ['auth', 'status', '--json'], { cwd: tmpdir(), timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        // The CLI also emits JSON and exits with code 1 when signed out.
        if (error && error.code !== 1) { resolve('unknown'); return; }
        try {
          const status = JSON.parse(stdout)?.loggedIn;
          resolve(status === true && !error ? 'authenticated' : status === false ? 'signed-out' : 'unknown');
        } catch { resolve('unknown'); }
      });
    });
  }
  return Promise.resolve('unknown');
}

async function claudeMeters(): Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>> {
  // A session that never gets a prompt: only its control channel is used.
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = query({ prompt: idle, options: { cwd: tmpdir() } });
  try {
    const u = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 'Claude');
    if (!u.rate_limits_available || !u.rate_limits) return { plan: u.subscription_type, windows: [] };
    return { plan: u.subscription_type, windows: claudeWindows(u.rate_limits) };
  } finally {
    q.close();
  }
}

async function claude(): Promise<Omit<EngineUsage, 'engine' | 'fetchedAt'>> {
  const [auth, meters] = await Promise.all([
    claudeAuth(),
    claudeMeters().catch(() => ({ plan: null, windows: [], error: 'Claude 사용량을 조회하지 못했습니다.' })),
  ]);
  return { ...meters, auth };
}

/** Codex: each limit's primary and secondary windows. */
export function codexWindows(r: Json): UsageWindow[] {
  const snaps: Json[] = Object.entries(r?.rateLimitsByLimitId ?? {}).filter(([, value]) => !!value).map(([id, value]) => ({ ...(value as Json), limitId: (value as Json).limitId ?? id }));
  if (!snaps.length && r?.rateLimits) snaps.push(r.rateLimits);
  return snaps.flatMap((s) => [s.primary, s.secondary].filter(Boolean).map((w: Json) => ({
    applicability: !s.limitId || s.limitId === 'codex' ? 'all' : 'unknown',
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
  const failed = (error: Error) => { for (const call of calls.values()) call.reject(error); };
  child.on('error', failed);
  child.stdin.on('error', failed);
  child.on('close', () => failed(new Error('Codex 사용량 조회가 종료되었습니다')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
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
  })(), 'Codex').finally(() => { calls.clear(); lines.close(); child.kill('SIGKILL'); });
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
    execFile(AGY_BIN, ['-p', '/usage', '--output-format', 'json'], { cwd: tmpdir(), timeout: TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) => {
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
const last = new Map<EngineName, { at: number; pending: boolean; value: Promise<EngineUsage> }>();

/** One engine's usage; a failure comes back as `error`, not as a rejection. */
export function readEngineUsage(engine: EngineName, refresh = false): Promise<EngineUsage> {
  const cached = last.get(engine);
  if (cached && (cached.pending || !refresh && Date.now() - cached.at < CACHE_MS)) return cached.value;
  const value: Promise<EngineUsage> = Promise.resolve().then(READERS[engine]).then(
    (r) => ({ engine, fetchedAt: new Date().toISOString(), ...r }),
    (e) => ({ engine, fetchedAt: new Date().toISOString(), plan: null, windows: [], error: e instanceof Error ? e.message : String(e) }));
  const entry = { at: Date.now(), pending: true, value };
  last.set(engine, entry);
  void value.then(() => { entry.pending = false; });
  return value;
}

/** Every engine's usage, once all have answered. */
export const readUsage = (refresh = false) => Promise.all(ENGINES.map((e) => readEngineUsage(e, refresh)));

/** Only normalized meter data crosses runner boundaries. Provider errors can contain local details. */
export async function readRunnerUsage(engine: EngineName, refresh: boolean): Promise<EngineUsage> {
  const { plan, windows, error, fetchedAt, auth } = await readEngineUsage(engine, refresh);
  return {
    engine, fetchedAt, plan: typeof plan === 'string' ? plan.slice(0, 100) : null,
    ...(auth ? { auth } : {}),
    ...(error ? { error: '엔진의 사용량을 조회하지 못했습니다. 러너의 CLI 설치와 로그인 상태를 확인하세요.' } : {}),
    windows: windows.slice(0, 40).map(window => ({
      label: typeof window.label === 'string' ? window.label.slice(0, 140) : '한도',
      usedPercent: window.usedPercent !== null && Number.isFinite(window.usedPercent)
        ? Math.max(0, Math.min(100, window.usedPercent)) : null,
      resetsAt: window.resetsAt,
      applicability: window.applicability,
    })),
  };
}
