import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localAuthorityActivated } from './local-ownership.ts';

export type LocalLaunchSettings = { authorityUrl: string; tokenFile: string; gatewayDbPath: string };

/** A verified authority is temporarily unreachable; the gateway may use an existing trusted link. */
export class LocalAuthorityUnavailableError extends Error {}

/** Only paths are persisted. The bearer token remains in a private file. */
export function readLocalLaunchSettings(path: string): LocalLaunchSettings | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`로컬 모드 설정 파일을 읽을 수 없습니다: ${path}`); }
  if (!value || typeof value !== 'object') throw new Error('로컬 모드 설정 형식이 잘못되었습니다');
  const { authorityUrl, tokenFile, gatewayDbPath } = value as Partial<LocalLaunchSettings>;
  if (typeof authorityUrl !== 'string' || typeof tokenFile !== 'string' || !isAbsolute(tokenFile)
    || typeof gatewayDbPath !== 'string' || !isAbsolute(gatewayDbPath))
    throw new Error('로컬 모드 설정에는 authorityUrl과 절대 경로 tokenFile·gatewayDbPath가 필요합니다');
  return { authorityUrl, tokenFile, gatewayDbPath };
}

function expectedWorkspace(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT id FROM workspace_identity LIMIT 1").get() as { id: string } | undefined;
    if (!row?.id) throw new Error('로컬 작업공간 신원 기록이 없습니다');
    return row.id;
  } finally { db.close(); }
}

/** Offline startup is only for a gateway that has already authenticated this exact authority. */
export async function ensureGatewayLocalAuthority(input: Parameters<typeof ensureLocalAuthority>[0] & { gatewayDbPath: string }): Promise<'ready' | 'offline'> {
  try {
    await ensureLocalAuthority(input);
    return 'ready';
  } catch (error) {
    if (!(error instanceof LocalAuthorityUnavailableError)) throw error;
    const workspaceId = expectedWorkspace(resolve(input.dbPath));
    const db = new DatabaseSync(resolve(input.gatewayDbPath), { readOnly: true });
    try {
      const link = db.prepare('SELECT url,token,workspace_id FROM workspace_link WHERE id=?')
        .get('local-authority') as { url: string; token: string; workspace_id: string } | undefined;
      const token = readFileSync(resolve(input.tokenFile), 'utf8').trim();
      if (!link || link.workspace_id !== workspaceId || link.url !== new URL(input.url).href || link.token !== token)
        throw new Error('기존 게이트웨이의 로컬 작업공간 신원·주소·토큰이 현재 설정과 다릅니다');
    } finally { db.close(); }
    return 'offline';
  }
}

async function probe(url: string, token: string, expectedId: string): Promise<'ready' | 'absent'> {
  let response: Response;
  try {
    response = await fetch(new URL('/v1/identity', url), {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(700), redirect: 'error',
    });
  } catch { return 'absent'; }
  if (response.status !== 200) throw new Error(`로컬 작업공간 주소가 다른 응답을 보냈습니다 (HTTP ${response.status}). 자동 시작을 중단합니다`);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('로컬 작업공간 주소의 신원 응답이 JSON이 아닙니다'); }
  if (!body || typeof body !== 'object' || (body as { workspace_id?: string }).workspace_id !== expectedId
    || (body as { version?: number }).version !== 1)
    throw new Error('로컬 작업공간 주소의 신원이 원본 DB와 다릅니다');
  return 'ready';
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
    return true;
  } catch { return false; }
  finally { if (server.listening) await new Promise<void>(done => server.close(() => done())); }
}

/** Recover an already activated local authority; first live takeover remains an explicit operation. */
export async function ensureLocalAuthority(input: {
  dbPath: string; url: string; tokenFile: string; port: number; scriptPath?: string;
  timeoutMs?: number; spawnAuthority?: typeof spawn;
}) {
  // The Desktop app starts index.ts from hub/, but this child starts from the repository root.
  const dbPath = resolve(input.dbPath);
  const tokenFile = resolve(input.tokenFile);
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash)
    throw new Error('로컬 작업공간 주소 형식이 잘못되었습니다');
  const mode = statSync(tokenFile).mode;
  if (mode & 0o077) throw new Error('로컬 작업공간 토큰 파일 권한은 소유자 전용이어야 합니다');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('로컬 작업공간 토큰 파일 내용이 잘못되었습니다');
  const expectedId = expectedWorkspace(dbPath);
  if (await probe(input.url, token, expectedId) === 'ready') return;
  if (!localAuthorityActivated(dbPath))
    throw new Error('첫 로컬 작업공간 전환은 자동 시작하지 않습니다. --takeover-live로 인수하세요');
  // A remote authority or a forwarded localhost port is never started here.
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || Number(target.port) !== input.port)
    throw new LocalAuthorityUnavailableError('원격 작업공간 주소에 연결할 수 없습니다. 자동 시작하지 않습니다');
  if (!await portAvailable(input.port))
    throw new Error('로컬 작업공간 포트가 다른 프로세스에 점유되었습니다. 자동 시작하지 않습니다');
  const script = input.scriptPath ? resolve(input.scriptPath) : resolve(import.meta.dirname, 'local.ts');
  const log = join(dirname(dbPath), 'local-runtime.log');
  const fd = openSync(log, 'a', 0o600);
  fchmodSync(fd, 0o600);
  let child;
  let spawnError: Error | undefined;
  let exited = false;
  try {
    child = (input.spawnAuthority ?? spawn)(process.execPath, [script], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: { ...process.env, AGENT_DESK_DB: dbPath, AGENT_DESK_SHARED_PORT: String(input.port) },
      detached: true, stdio: ['ignore', fd, fd],
    });
    child.on('error', error => { spawnError = error; });
    child.once('exit', () => { exited = true; });
    child.unref();
  } finally { closeSync(fd); }
  try {
    const deadline = Date.now() + (input.timeoutMs ?? 8_000);
    while (Date.now() < deadline) {
      if (spawnError) {
        const message = `로컬 작업공간을 시작할 수 없습니다: ${spawnError.message}`;
        if (['EACCES', 'EPERM'].includes((spawnError as NodeJS.ErrnoException).code ?? '')) throw new Error(message);
        throw new LocalAuthorityUnavailableError(message);
      }
      if (await probe(input.url, token, expectedId) === 'ready') return;
      if (exited || child.exitCode !== null || child.signalCode !== null)
        throw new LocalAuthorityUnavailableError(`로컬 작업공간이 준비되기 전에 종료되었습니다 (${child.signalCode ?? child.exitCode})`);
      await delay(150);
    }
    throw new LocalAuthorityUnavailableError('로컬 작업공간 시작을 기다리다 시간이 초과되었습니다');
  } catch (error) {
    // Only this invocation's child is eligible for cleanup. Existing authorities and the daemon
    // are never signalled here.
    if (!exited && child.exitCode === null && child.signalCode === null && child.pid) {
      const done = new Promise<boolean>(resolve => child.once('exit', () => resolve(true)));
      const signalled = child.kill('SIGTERM');
      const stopped = exited || child.exitCode !== null || child.signalCode !== null
        || (signalled && await Promise.race([done, delay(1_000).then(() => false)]));
      if (!stopped) throw new AggregateError([error], '로컬 작업공간 시작 실패 후 자식 프로세스 종료를 확인하지 못했습니다');
    }
    throw error;
  }
}
