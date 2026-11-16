import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { HttpError } from './errors.ts';
import { assertTrustedPath } from './trusted-path.ts';
import type { LiveSession } from '../../shared/protocol.ts';
import type { Hub } from './hub.ts';

export type RuntimeRole = 'hub' | 'daemon' | 'local' | 'shared' | 'remote';
export interface RuntimeStatus {
  version: 1; role: RuntimeRole; commit: string; instance: string; pid: number; owner: string;
  ready: boolean; reasons: string[]; prepared: boolean;
}
export interface ControlRequest { action: 'status' | 'prepare' | 'prepare-failed-candidate' | 'cancel' | 'stop'; instance?: string; lease?: string; owner?: string; commit?: string }
export interface ControlReply { ok: boolean; status: RuntimeStatus; lease?: string; error?: string }
let heldUntil = 0;
export const maintenanceActive = () => Date.now() < heldUntil;
export function requireAdmission() {
  if (maintenanceActive()) throw new HttpError(503, '업데이트 교체를 준비 중입니다. 잠시 뒤 다시 보내주세요');
}
export function sessionBlockers(sessions: LiveSession[]): string[] {
  return sessions.flatMap(s => [s.busy ? '실행 중인 턴' : '', s.approvals.length ? '승인 대기' : '', s.background?.length ? '백그라운드 작업' : ''].filter(Boolean));
}
export function hubBlockers(hub: Hub): string[] {
  const db = hub.store.database, now = Date.now();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('connector_job','connector_call','connector_grant')").all() as {name: string}[]).map(row => row.name));
  const connectorPending = !!hub.connectorQueriesPending?.()
    || tables.has('connector_job') && !!db.prepare("SELECT 1 FROM connector_job WHERE status='pending' AND expires_at>? LIMIT 1").get(now)
    || tables.has('connector_call') && tables.has('connector_grant') && !!db.prepare(`SELECT 1 FROM connector_call AS call
      JOIN connector_grant AS grant ON grant.capability_hash=call.capability_hash
      WHERE call.result IS NULL AND call.error IS NULL AND grant.revoked=0 AND grant.expires_at>? LIMIT 1`).get(now);
  return [hub.busy.size ? '실행 중인 턴' : '', hub.background.size ? '백그라운드 작업' : '',
    hub.store.pendingApprovals().length ? '승인 대기' : '', hub.store.pendingQuestions().length ? '질문 대기' : '',
    hub.store.queued({}).length ? '대기 중인 입력' : '', connectorPending ? '외부 조회 처리 중' : ''].filter(Boolean);
}

/** An independent, owner-only control socket. It never takes over the daemon's hub connection. */
export async function registerRuntimeControl(options: {
  role: RuntimeRole; ready: () => boolean; blockers: () => string[]; stop: () => void | Promise<void>;
  socket?: string; commit?: string; leaseMs?: number;
}): Promise<Server | undefined> {
  const path = options.socket ?? process.env.AGENT_DESK_UPDATE_SOCKET;
  if (!path) return undefined; // Explicit per-machine supervisor opt-in only.
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100) throw new Error('업데이트 제어 소켓은 100바이트 이하의 절대 경로여야 합니다');
  const directory = dirname(path);
  assertTrustedPath(directory, {kind: 'directory', private: true, allowMissing: true});
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertTrustedPath(directory, {kind: 'directory', private: true});
  try {
    const existing = lstatSync(path);
    if (!existing.isSocket()) throw new Error('제어 소켓 경로에 다른 파일이 있습니다');
    assertTrustedPath(path, {kind: 'socket', private: true});
    try { await controlRequest(path, { action: 'status' }); throw new Error('해당 역할의 관리 프로세스가 이미 실행 중입니다'); }
    catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      unlinkSync(path);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const instance = randomUUID(), commit = options.commit ?? process.env.AGENT_DESK_RELEASE_SHA ?? '';
  let lease: string | undefined, stopping = false;
  const status = (): RuntimeStatus => ({ version: 1, role: options.role, commit, instance, pid: process.pid,
    owner: process.env.AGENT_DESK_UPDATE_OWNER ?? '',
    ready: !stopping && options.ready(), reasons: options.blockers(), prepared: maintenanceActive() });
  const server = createServer(socket => {
    let input = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      let stop = false;
      let reply: ControlReply;
      try {
        const request = JSON.parse(input.split('\n')[0]) as ControlRequest;
        if (!request || !['status', 'prepare', 'prepare-failed-candidate', 'cancel', 'stop'].includes(request.action)) throw new Error('잘못된 제어 요청입니다');
        if (request.action !== 'status' && request.instance !== instance) throw new Error('런타임 인스턴스가 바뀌었습니다');
        if (request.action === 'prepare' || request.action === 'prepare-failed-candidate') {
          if (maintenanceActive() || stopping) throw new Error('이미 교체를 준비 중입니다');
          const state = status();
          const failedCandidate = request.action === 'prepare-failed-candidate';
          if (failedCandidate && (!state.owner || request.owner !== state.owner || request.commit !== state.commit || state.ready))
            throw new Error('실패 후보의 소유자·커밋·미준비 상태가 일치하지 않습니다');
          if ((!state.ready && !failedCandidate) || state.reasons.length) throw new Error('작업이 유휴 상태가 아닙니다');
          lease = randomUUID(); heldUntil = Date.now() + (options.leaseMs ?? 30_000);
        } else if (request.action === 'cancel' || request.action === 'stop') {
          if (!maintenanceActive() || !lease || request.lease !== lease) throw new Error('교체 준비 시간이 만료되었거나 소유권이 다릅니다');
          if (request.action === 'stop') {
            if (status().reasons.length) throw new Error('교체 준비 뒤 작업 상태가 바뀌었습니다');
            stopping = true; stop = true;
          } else { heldUntil = 0; lease = undefined; }
        }
        reply = { ok: true, status: status(), ...((request.action === 'prepare' || request.action === 'prepare-failed-candidate') && { lease }) };
      } catch (error) { reply = { ok: false, status: status(), error: error instanceof Error ? error.message : String(error) }; }
      socket.end(JSON.stringify(reply) + '\n', () => {
        if (stop) void Promise.resolve(options.stop()).catch(error => { console.error('업데이트 종료 실패:', error); process.exitCode = 1; });
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { chmodSync(path, 0o600); resolve(); }); });
  return server;
}

export function controlRequest(path: string, request: ControlRequest, timeoutMs = 3000): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = '', finished = false;
    const finish = (error?: Error, reply?: ControlReply) => {
      if (finished) return; finished = true; socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('런타임 제어 응답 시간이 초과되었습니다')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('end', () => { if (!finished) finish(new Error('런타임 제어 응답이 끊겼습니다')); });
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 65536) { finish(new Error('런타임 제어 응답이 너무 큽니다')); return; }
      if (!input.includes('\n')) return;
      try {
        const reply = JSON.parse(input.split('\n')[0]) as ControlReply;
        if (typeof reply.ok !== 'boolean' || reply.status?.version !== 1 || typeof reply.status.instance !== 'string' || !Array.isArray(reply.status.reasons)) throw new Error('런타임 제어 응답 형식이 잘못되었습니다');
        finish(undefined, reply);
      } catch (error) { finish(error as Error); }
    });
  });
}
