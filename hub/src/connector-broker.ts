import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConnectorContext, ConnectorGrant } from './connector-authority.ts';
import { HttpError } from './errors.ts';
import { requireAdmission } from './runtime-control.ts';

/** sourcePeerId is stamped by SharedWorkspace.authenticate, never accepted from a model. */
export interface ConnectorRequestContext extends ConnectorGrant { sourcePeerId: string }
export type ConnectorExecutionContext = ConnectorRequestContext;
export type ConnectorMethod = 'list' | 'tools' | 'read';
export interface ConnectorJob {
  callId: string; method: ConnectorMethod; context: ConnectorContext; args: Record<string, unknown>; expiresAt: number;
}
export type ConnectorCompletion = { result: unknown; error?: never } | { error: { status: number; message: string }; result?: never };
interface SessionRow { session_id: string; task_id: string; token_hash: string; context: string | null; epoch: string; active: number }
interface JobRow {
  id: string; session_id: string; peer_id: string; epoch: string; context: string; method: ConnectorMethod;
  args: string; expires_at: number; status: string; completion: string | null; completion_hash: string | null;
  acknowledged: number; consumed: number;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const EXPIRED_GRANT_MESSAGE = '이 요청의 외부 조회 권한이 만료되었습니다. 원래 요청을 보낸 허브의 대화 입력창에서 다시 보내세요. 대기 메시지가 있다면 먼저 내용을 복사하고 해당 메시지를 취소하세요. ‘지금 보내기’만 다시 눌러서는 갱신되지 않습니다';
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const policy = (context?: ConnectorRequestContext) => context ? canonical({ hubId: context.hubId, sourcePeerId: context.sourcePeerId,
  workspaceId: context.workspaceId, connections: context.connections.map(c => ({ ...c, tools: [...c.tools].sort() })).sort((a, b) => a.service.localeCompare(b.service)) }) : '';

/** Durable, peer-isolated mailbox. Runtime tokens authorize one session, never a workspace. */
export class ConnectorBroker {
  private db: DatabaseSync;
  private workspaceId: string;
  private now: () => number;
  private waitMs: number;
  private waiters = new Map<string, Set<() => void>>();
  private sessionCalls = new Map<string, number>();
  private expiredSessions = new Set<string>();
  private onIdle?: (sessionId: string) => void;
  private shouldAuthorizePeer?: (peerId: string) => boolean;
  private closed = false;
  private sweepTimer: NodeJS.Timeout;
  constructor(db: DatabaseSync, workspaceId: string, options: { now?: () => number; waitMs?: number;
    onIdle?: (sessionId: string) => void; shouldAuthorizePeer?: (peerId: string) => boolean } = {}) {
    this.db = db; this.workspaceId = workspaceId; this.now = options.now ?? Date.now;
    this.waitMs = options.waitMs ?? 60_000;
    this.onIdle = options.onIdle; this.shouldAuthorizePeer = options.shouldAuthorizePeer;
    db.exec(`CREATE TABLE IF NOT EXISTS connector_runtime (
      session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      context TEXT, epoch TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS connector_job (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, peer_id TEXT NOT NULL, epoch TEXT NOT NULL,
      context TEXT NOT NULL, method TEXT NOT NULL, args TEXT NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, completion TEXT, completion_hash TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS connector_approval (
      approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      epoch TEXT NOT NULL, policy TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS connector_job_peer ON connector_job(peer_id,status,expires_at);`);
    this.prune();
    this.sweepTimer = setInterval(() => { if (!this.closed) this.prune(true); }, 60_000);
    this.sweepTimer.unref();
  }

  private session(sessionId: string, taskId?: string) {
    if (this.closed) throw new HttpError(503, '외부 조회 중계가 종료되었습니다');
    const session = this.db.prepare('SELECT task_id,status FROM session WHERE id=?').get(sessionId) as { task_id: string; status: string } | undefined;
    if (!session || (taskId !== undefined && session.task_id !== taskId) || ['closed', 'failed'].includes(session.status))
      throw new HttpError(403, '외부 조회를 실행할 세션이 없거나 종료되었습니다');
    return session;
  }
  private peer(peerId: string) {
    if (this.closed) throw new HttpError(503, '외부 조회 중계가 종료되었습니다');
    if (this.shouldAuthorizePeer ? !this.shouldAuthorizePeer(peerId) : !this.db.prepare('SELECT 1 FROM workspace_peer WHERE id=? AND revoked=0').get(peerId))
      throw new HttpError(403, '외부 조회를 전달한 허브 권한이 취소되었습니다');
  }
  private checked(context: ConnectorRequestContext, allowExpired = false): ConnectorRequestContext {
    if (!context || context.workspaceId !== this.workspaceId || !id(context.hubId) || !id(context.sourcePeerId) || !id(context.requestId)
      || typeof context.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(context.capability)
      || !Number.isSafeInteger(context.expiresAt) || !Array.isArray(context.connections)
      || context.connections.length > 2 || new Set(context.connections.map(c => c?.service)).size !== context.connections.length
      || context.connections.some(c => !c || !['jira', 'slack'].includes(c.service) || !id(c.generation) || !Array.isArray(c.tools)
        || c.tools.length > 100 || c.tools.some(tool => !id(tool))))
      throw new HttpError(403, '외부 조회 요청 문맥이 올바르지 않거나 만료되었습니다');
    if (!allowExpired && context.expiresAt <= this.now()) throw new HttpError(403, EXPIRED_GRANT_MESSAGE);
    this.peer(context.sourcePeerId);
    return JSON.parse(JSON.stringify(context));
  }
  private row(sessionId: string) { return this.db.prepare('SELECT * FROM connector_runtime WHERE session_id=?').get(sessionId) as SessionRow | undefined; }
  hasSession(sessionId: string): boolean { return !!this.row(sessionId)?.active; }
  /** An expired grant cannot authorize tools, even before the periodic sweep removes it. */
  hasAuthority(sessionId: string): boolean {
    const row = this.row(sessionId), context = row?.active && this.context(row);
    return !!context && context.expiresAt > this.now();
  }
  /** Expiry removes tool access, not the text of an already accepted user input. */
  inputContext(context: ConnectorExecutionContext | null | undefined): ConnectorExecutionContext | null | undefined {
    if (!context) return context;
    const checked = this.checked(context, true);
    return checked.expiresAt > this.now() ? checked : null;
  }
  private context(row: SessionRow): ConnectorRequestContext | undefined { return row.context ? JSON.parse(row.context) : undefined; }
  stored(sessionId: string): ConnectorExecutionContext | undefined {
    const row = this.row(sessionId);
    if (!row?.context) return;
    return this.checked(this.context(row)!);
  }

  /** Keep the requesting account even when its grant expires or the process restarts. */
  bindApproval(approvalId: string, sessionId: string): void {
    const row = this.row(sessionId), context = row && this.context(row);
    if (!context) return;
    this.db.prepare('INSERT OR IGNORE INTO connector_approval VALUES (?,?,?,?,?)')
      .run(approvalId, sessionId, context.sourcePeerId, row!.epoch, policy(context));
  }
  assertApprovalReply(approvalId: string, sessionId: string, peerId?: string, context?: ConnectorRequestContext | null): void {
    const binding = this.db.prepare('SELECT * FROM connector_approval WHERE approval_id=?').get(approvalId) as
      { session_id: string; peer_id: string; epoch: string; policy: string } | undefined;
    const row = this.row(sessionId);
    // Pre-upgrade approvals with active grants have no trustworthy originating epoch.
    if (!binding && !row?.context) return;
    if (!binding || binding.session_id !== sessionId || !row?.active || row.epoch !== binding.epoch
      || peerId !== binding.peer_id || !context || context.sourcePeerId !== peerId
      || !this.samePolicy(sessionId, context) || policy(context) !== binding.policy)
      throw new HttpError(409, '질문·승인을 요청한 외부 연결 계정과 응답 계정이 다르거나 요청 문맥이 만료되었습니다');
  }

  /** New engine process only: rotates the secret and rejects calls from the old process. */
  open(sessionId: string, taskId: string, context?: ConnectorRequestContext): string {
    this.session(sessionId, taskId);
    const accepted = context ? this.checked(context) : undefined;
    const token = randomBytes(32).toString('base64url');
    this.deactivate(sessionId);
    this.db.prepare(`INSERT INTO connector_runtime VALUES (?,?,?,?,?,1)
      ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id,token_hash=excluded.token_hash,context=excluded.context,epoch=excluded.epoch,active=1`)
      .run(sessionId, taskId, hash(token), accepted ? JSON.stringify(accepted) : null, randomUUID());
    return token;
  }
  samePolicy(sessionId: string, context?: ConnectorRequestContext): boolean {
    const row = this.row(sessionId);
    if (!row?.active) return !context;
    try {
      this.session(sessionId, row.task_id);
      const current = this.context(row);
      if (current) this.checked(current);
      if (context) this.checked(context);
      return policy(current) === policy(context);
    } catch { return false; }
  }
  /** Explains an already-blocked switch; never grants authority or changes admission. */
  switchBlockedMessage(sessionId: string, context?: ConnectorRequestContext): string {
    if (context && context.expiresAt <= this.now()) return EXPIRED_GRANT_MESSAGE;
    const row = this.row(sessionId), current = row && this.context(row);
    const reason = !current || current.expiresAt <= this.now()
      ? '이전 외부 조회 권한이 만료되었거나 없어 새 입력의 권한을 확인해야 합니다.'
      : '실행 중인 작업과 새 입력의 외부 연결 권한이 다르거나 유효성을 확인할 수 없습니다.';
    return reason + ' 현재 작업·서브 에이전트·백그라운드 작업·외부 조회가 끝날 때까지 기다려 주세요. 대기 메시지는 종료 후 자동으로 전송을 시도합니다. 권한 만료 안내가 나오면 내용을 복사한 뒤 대기 메시지를 취소하고 원래 허브의 입력창에서 다시 보내세요';
  }
  busy(sessionId: string): boolean {
    return !!this.sessionCalls.get(sessionId) || !!this.db.prepare("SELECT 1 FROM connector_job WHERE session_id=? AND status='pending' AND expires_at>? LIMIT 1").get(sessionId, this.now());
  }
  /** Parent also checks engine busy/background. Same-policy steering retains the active grant. */
  activate(sessionId: string, taskId: string, context?: ConnectorRequestContext): void {
    this.session(sessionId, taskId);
    const row = this.row(sessionId);
    if (!row?.active || row.task_id !== taskId) throw new HttpError(403, '실행 중인 외부 조회 인증이 없습니다');
    const accepted = context ? this.checked(context) : undefined;
    if (this.busy(sessionId)) {
      if (this.samePolicy(sessionId, accepted)) return;
      throw new HttpError(409, '진행 중인 외부 조회가 끝난 뒤 계정을 바꿀 수 있습니다');
    }
    this.db.prepare('UPDATE connector_runtime SET context=?,epoch=? WHERE session_id=?')
      .run(accepted ? JSON.stringify(accepted) : null, randomUUID(), sessionId);
  }
  deactivate(sessionId: string): void {
    this.db.prepare('UPDATE connector_runtime SET active=0 WHERE session_id=?').run(sessionId);
    this.db.prepare("UPDATE connector_job SET status='cancelled',completion=NULL WHERE session_id=? AND status='pending'").run(sessionId);
    for (const row of this.db.prepare('SELECT id FROM connector_job WHERE session_id=?').all(sessionId) as { id: string }[]) this.wake(row.id);
  }
  private authenticate(token: string): SessionRow {
    if (this.closed) throw new HttpError(503, '외부 조회 중계가 종료되었습니다');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(403, '실행 세션의 외부 조회 인증이 필요합니다');
    const row = this.db.prepare('SELECT * FROM connector_runtime WHERE token_hash=? AND active=1').get(hash(token)) as SessionRow | undefined;
    if (!row) throw new HttpError(403, '실행 세션의 외부 조회 인증이 필요합니다');
    this.session(row.session_id, row.task_id);
    if (row.context) this.checked(this.context(row)!);
    return row;
  }
  authorize(token: string): void { this.authenticate(token); }
  private live(job: JobRow) {
    const row = this.row(job.session_id);
    this.session(job.session_id, row?.task_id);
    this.peer(job.peer_id);
    if (!row?.active || row.epoch !== job.epoch || job.expires_at <= this.now() || job.status === 'cancelled')
      throw new HttpError(409, '외부 조회 문맥이 변경되었거나 요청이 만료되었습니다');
    this.checked(this.context(row)!);
  }
  private job(callId: string) { return this.db.prepare('SELECT * FROM connector_job WHERE id=?').get(callId) as JobRow | undefined; }
  private wake(callId: string) { for (const resolve of this.waiters.get(callId) ?? []) resolve(); }
  private prune(notify = false) {
    const expired = this.db.prepare('SELECT id FROM connector_job WHERE expires_at<=?').all(this.now()) as { id: string }[];
    this.db.prepare('DELETE FROM connector_job WHERE expires_at<=?').run(this.now());
    for (const { id } of expired) this.wake(id);
    // Preserve the process token so a later user input can activate a fresh grant.
    const cleared = this.db.prepare("UPDATE connector_runtime SET context=NULL WHERE context IS NOT NULL AND json_extract(context,'$.expiresAt')<=? RETURNING session_id")
      .all(this.now()) as { session_id: string }[];
    for (const { session_id } of cleared) this.expiredSessions.add(session_id);
    this.db.prepare('DELETE FROM connector_runtime WHERE session_id NOT IN (SELECT id FROM session)').run();
    this.db.prepare('DELETE FROM connector_approval WHERE session_id NOT IN (SELECT id FROM session)').run();
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval'").get())
      this.db.prepare("DELETE FROM connector_approval WHERE approval_id NOT IN (SELECT id FROM approval WHERE status='pending')").run();
    // A turn may already be idle while a background command continues. Expiry removes
    // the authority barrier, so retry its queued text without granting the command new access.
    if (notify) {
      const sessions = [...this.expiredSessions];
      this.expiredSessions.clear();
      for (const sessionId of sessions) if (!this.busy(sessionId)) this.onIdle?.(sessionId);
    }
  }
  async invoke(token: string, method: ConnectorMethod, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    requireAdmission();
    const row = this.authenticate(token), context = this.context(row);
    if (!['list', 'tools', 'read'].includes(method) || !args || typeof args !== 'object' || Array.isArray(args))
      throw new HttpError(400, '외부 조회 도구 형식이 올바르지 않습니다');
    const fields = method === 'read' ? ['service', 'tool', 'arguments'] : method === 'tools' ? ['service'] : [];
    if (Object.keys(args).some(key => !fields.includes(key))) throw new HttpError(400, '외부 조회 도구에 허용되지 않은 인자가 있습니다');
    if (!context) {
      if (method === 'list') return { connections: [] };
      throw new HttpError(403, '이 사용자 입력에 허용된 외부 연결이 없습니다');
    }
    if (method !== 'list') {
      const allowed = context.connections.find(connection => connection.service === args.service);
      if (!allowed || (method === 'read' && (typeof args.tool !== 'string' || !allowed.tools.includes(args.tool))))
        throw new HttpError(403, '이 입력에 허용된 읽기 도구만 사용할 수 있습니다');
      if (method === 'read' && (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)))
        throw new HttpError(400, '읽기 도구 arguments 객체가 필요합니다');
    }
    let encoded: string;
    try { encoded = JSON.stringify(args); } catch { throw new HttpError(400, '외부 조회 인자는 JSON이어야 합니다'); }
    if (Buffer.byteLength(encoded) > 64 * 1024) throw new HttpError(413, '외부 조회 인자가 너무 큽니다');
    signal?.throwIfAborted();
    this.prune();
    const pending = this.db.prepare("SELECT count(*) n FROM connector_job WHERE status='pending'").get() as { n: number };
    const mine = this.db.prepare("SELECT count(*) n FROM connector_job WHERE status='pending' AND session_id=?").get(row.session_id) as { n: number };
    const retained = this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(args AS BLOB))+length(CAST(context AS BLOB))+coalesce(length(CAST(completion AS BLOB)),0)),0) bytes FROM connector_job').get() as { n: number; bytes: number };
    if (pending.n >= 256 || mine.n >= 4 || retained.n >= 1024 || retained.bytes + Buffer.byteLength(encoded) + 4096 > 32 * 1024 * 1024)
      throw new HttpError(429, '외부 조회 대기 한도에 도달했습니다');
    const callId = randomUUID(), expiresAt = Math.min(context.expiresAt, this.now() + this.waitMs);
    const ownerContext: ConnectorContext = { capability: context.capability, workspaceId: this.workspaceId, requestId: context.requestId,
      taskId: row.task_id, sessionId: row.session_id };
    this.db.prepare("INSERT INTO connector_job VALUES (?,?,?,?,?,?,?,?, 'pending',NULL,NULL,0,0)")
      .run(callId, row.session_id, context.sourcePeerId, row.epoch, JSON.stringify(ownerContext), method, encoded, expiresAt);
    this.sessionCalls.set(row.session_id, (this.sessionCalls.get(row.session_id) ?? 0) + 1);
    try {
      for (;;) {
        if (this.closed) throw new HttpError(503, '외부 조회 중계가 종료되었습니다');
        const job = this.job(callId);
        if (!job) throw new HttpError(409, '외부 조회 요청이 만료되었습니다');
        this.authenticate(token); this.live(job);
        if (job.status === 'done') {
          if (!job.completion) throw new HttpError(409, '외부 조회 결과가 이미 수거되었습니다');
          const completion = JSON.parse(job.completion) as ConnectorCompletion;
          this.db.prepare('UPDATE connector_job SET consumed=1,completion=CASE WHEN acknowledged=1 THEN NULL ELSE completion END WHERE id=?').run(callId);
          if (completion.error) throw new HttpError(completion.error.status, completion.error.message);
          return completion.result;
        }
        await new Promise<void>((resolve, reject) => {
          const listeners = this.waiters.get(callId) ?? new Set<() => void>();
          this.waiters.set(callId, listeners);
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); listeners.delete(done); if (!listeners.size) this.waiters.delete(callId); };
          const done = () => { cleanup(); resolve(); };
          const aborted = () => { cleanup(); reject(new HttpError(409, '외부 조회 요청이 취소되었습니다')); };
          const timer = setTimeout(done, Math.max(1, expiresAt - this.now()));
          listeners.add(done); signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        });
      }
    } finally {
      if (!this.closed) this.db.prepare("UPDATE connector_job SET status='cancelled',completion=NULL WHERE id=? AND status='pending'").run(callId);
      const remaining = (this.sessionCalls.get(row.session_id) ?? 1) - 1;
      if (remaining) this.sessionCalls.set(row.session_id, remaining); else this.sessionCalls.delete(row.session_id);
      if (!this.closed && !this.busy(row.session_id)) this.onIdle?.(row.session_id);
    }
  }

  poll(peerId: string): ConnectorJob[] {
    this.peer(peerId); this.prune();
    const jobs = this.db.prepare("SELECT * FROM connector_job WHERE peer_id=? AND status='pending' ORDER BY rowid LIMIT 32").all(peerId) as unknown as JobRow[];
    return jobs.filter(job => {
      try { this.live(job); return true; }
      catch { this.db.prepare("UPDATE connector_job SET status='cancelled' WHERE id=?").run(job.id); this.wake(job.id); return false; }
    }).map(job => ({ callId: job.id, context: JSON.parse(job.context), method: job.method, args: JSON.parse(job.args), expiresAt: job.expires_at }));
  }
  complete(peerId: string, callId: string, completion: ConnectorCompletion): { accepted: true } {
    this.peer(peerId);
    const job = this.job(callId);
    if (!job || job.peer_id !== peerId) throw new HttpError(403, '이 허브의 외부 조회 요청이 아닙니다');
    this.live(job);
    if (!completion || typeof completion !== 'object' || (Object.hasOwn(completion, 'result') === Object.hasOwn(completion, 'error'))
      || (Object.hasOwn(completion, 'result') && completion.result === undefined)
      || (Object.hasOwn(completion, 'error') && (!completion.error || typeof completion.error !== 'object'
        || !Number.isInteger(completion.error.status) || completion.error.status < 400 || completion.error.status > 599
        || typeof completion.error.message !== 'string' || completion.error.message.length > 2000)))
      throw new HttpError(400, '외부 조회 결과 형식이 올바르지 않습니다');
    let encoded: string;
    try { encoded = canonical(JSON.parse(JSON.stringify(completion))); } catch { throw new HttpError(400, '외부 조회 결과는 JSON이어야 합니다'); }
    const bytes = Buffer.byteLength(encoded), fingerprint = hash(encoded);
    if (job.completion_hash) {
      if (job.completion_hash !== fingerprint) throw new HttpError(409, '같은 조회 ID의 결과가 바뀌었습니다');
      return { accepted: true };
    }
    const usage = this.db.prepare('SELECT coalesce(sum(length(CAST(completion AS BLOB))),0) bytes FROM connector_job').get() as { bytes: number };
    if (bytes > 2 * 1024 * 1024 || usage.bytes + bytes > 32 * 1024 * 1024) throw new HttpError(413, '외부 조회 결과 보관 한도를 넘었습니다');
    this.db.prepare("UPDATE connector_job SET status='done',completion=?,completion_hash=? WHERE id=?").run(encoded, fingerprint, callId);
    this.wake(callId);
    return { accepted: true };
  }
  /** Owner confirms successful submission; bytes are erased only after the engine consumes them. */
  ack(peerId: string, callIds: string[]): void {
    this.peer(peerId);
    if (!Array.isArray(callIds) || callIds.length > 32 || !callIds.every(id)) throw new HttpError(400, '외부 조회 확인 ID가 올바르지 않습니다');
    for (const callId of callIds) {
      const job = this.job(callId);
      if (!job || job.peer_id !== peerId) throw new HttpError(403, '이 허브의 외부 조회 요청이 아닙니다');
      if (job.status !== 'done') throw new HttpError(409, '아직 결과를 받지 못한 외부 조회입니다');
      this.db.prepare('UPDATE connector_job SET acknowledged=1,completion=CASE WHEN consumed=1 THEN NULL ELSE completion END WHERE id=?').run(callId);
    }
  }
  close() { this.closed = true; clearInterval(this.sweepTimer); this.expiredSessions.clear(); for (const callId of this.waiters.keys()) this.wake(callId); }
}
