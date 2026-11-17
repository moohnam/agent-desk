import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Connectors, connectorReadToolNames, connectorTagTools, type ConnectorService } from './connectors.ts';
import { HttpError } from './errors.ts';
import { requireAdmission } from './runtime-control.ts';
import type { ConnectorCompletion, ConnectorJob } from './connector-broker.ts';
import { CONNECTOR_SCOPES, type ConnectorScope } from '../../shared/connector-tags.ts';

export interface ConnectorPolicy { service: ConnectorService; generation: string; tools: string[] }
export interface ConnectorIdentity { hubId:string; connections:{service:ConnectorService;generation:string}[] }
export interface ConnectorGrant {
  capability: string; hubId: string; workspaceId: string; requestId: string; expiresAt: number;
  connections: ConnectorPolicy[];
  inputScoped?: true;
}
/** Populated by the authenticated execution layer, never from model-supplied task IDs. */
export interface ConnectorContext {
  capability: string; workspaceId: string; requestId: string; taskId: string; sessionId: string;
}
export interface ConnectorCall extends ConnectorContext {
  callId: string; service: ConnectorService; tool: string; arguments: Record<string, unknown>;
}
interface GrantRow {
  capability_hash: string; workspace_id: string; request_id: string; task_id: string | null;
  session_id: string | null; expires_at: number; policy: string; revoked: number;
  active_ttl_ms: number | null;
}
interface CallRow { fingerprint: string; result: string | null; error: string | null }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const DEFAULT_TTL = 15 * 60_000, MAX_TTL = 60 * 60_000;
// Leave room for the peer-completion and JSON-RPC envelopes under the HTTP body limit.
const MAX_RESULT = 1024 * 1024, MAX_CACHE = 32 * 1024 * 1024;
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new HttpError(400, '조회 인자의 중첩이 너무 깊습니다');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item, depth + 1)).join(',') + '}';
  throw new HttpError(400, '조회 인자는 JSON 값이어야 합니다');
}

/** OAuth stays in Connectors. This gateway-local authority owns only narrow, expiring grants. */
export class ConnectorAuthority {
  readonly hubId: string;
  private now: () => number;
  private active = new Map<string, Promise<unknown>>();
  private catalogActive = 0;
  private closed = false;
  get busy() { return this.active.size > 0 || this.catalogActive > 0; }
  private sweepTimer: NodeJS.Timeout;
  private db: DatabaseSync;
  private connectors: Connectors;
  constructor(db: DatabaseSync, connectors: Connectors, options: { now?: () => number } = {}) {
    this.db = db; this.connectors = connectors;
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS connector_authority_identity (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS connector_grant (
        capability_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
        task_id TEXT, session_id TEXT, expires_at INTEGER NOT NULL, policy TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_id,request_id));
      CREATE TABLE IF NOT EXISTS connector_call (
        capability_hash TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT, error TEXT, PRIMARY KEY(capability_hash,call_id));`);
    if (!(db.prepare('PRAGMA table_info(connector_grant)').all() as {name:string}[]).some(column=>column.name==='active_ttl_ms'))
      db.exec('ALTER TABLE connector_grant ADD COLUMN active_ttl_ms INTEGER');
    if (!db.prepare('SELECT id FROM connector_authority_identity').get())
      db.prepare('INSERT INTO connector_authority_identity VALUES (?)').run(randomUUID());
    this.hubId = (db.prepare('SELECT id FROM connector_authority_identity').get() as { id: string }).id;
    this.prune();
    this.sweepTimer = setInterval(() => { if (!this.closed) this.prune(); }, 60_000);
    this.sweepTimer.unref();
  }

  private prune() {
    this.db.prepare('DELETE FROM connector_call WHERE capability_hash IN (SELECT capability_hash FROM connector_grant WHERE expires_at<=? OR revoked=1)').run(this.now());
    this.db.prepare('DELETE FROM connector_grant WHERE expires_at<=? OR revoked=1').run(this.now());
  }

  /** Only the gateway's accepted user-input path may invoke this method. */
  identity(): ConnectorIdentity { return {hubId:this.hubId,connections:this.connectors.connections()}; }
  select(scopes: readonly ConnectorScope[]): ConnectorPolicy[] {
    if (!Array.isArray(scopes) || scopes.some(scope => !CONNECTOR_SCOPES.includes(scope))) throw new HttpError(400, '외부 조회 태그가 올바르지 않습니다');
    const connections = this.connectors.connections();
    const selected: ConnectorPolicy[] = [];
    for (const scope of new Set(scopes)) {
      const service = scope === 'slack' ? 'slack' : 'jira';
      const connection = connections.find(c => c.service === service);
      if (!connection) throw new HttpError(409, `#${scope} 연결이 없습니다. 설정에서 먼저 연결해 주세요`);
      const tools = connectorTagTools([scope],service);
      const prior = selected.find(c => c.service === service);
      if (prior) prior.tools = [...new Set([...prior.tools,...tools])].sort();
      else selected.push({...connection,tools:tools.sort()});
    }
    return selected.sort((a,b)=>a.service.localeCompare(b.service));
  }

  issue(input: { workspaceId: string; requestId: string; taskId?: string; sessionId?: string; ttlMs?: number;
    scopes?: ConnectorScope[]; expectedPolicy?: ConnectorPolicy[] }): ConnectorGrant {
    if (this.closed) throw new HttpError(503, '외부 연결 권한 처리가 종료되었습니다');
    if (!validId(input.workspaceId) || !validId(input.requestId)
      || (input.taskId !== undefined && !validId(input.taskId)) || (input.sessionId !== undefined && !validId(input.sessionId)))
      throw new HttpError(400, '외부 연결 요청 문맥이 올바르지 않습니다');
    const scoped = input.scopes !== undefined;
    const ttl = input.ttlMs ?? (scoped ? 24 * 60 * 60_000 : DEFAULT_TTL);
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > (scoped ? 24 * 60 * 60_000 : MAX_TTL)) throw new HttpError(400, '외부 연결 허가 기간이 올바르지 않습니다');
    this.prune();
    if (this.db.prepare('SELECT 1 FROM connector_grant WHERE workspace_id=? AND request_id=?').get(input.workspaceId, input.requestId))
      throw new HttpError(409, '이미 허가한 사용자 요청입니다');
    if ((this.db.prepare('SELECT count(*) n FROM connector_grant').get() as { n: number }).n >= 256)
      throw new HttpError(429, '외부 연결 허가 한도에 도달했습니다');
    const connections = scoped ? this.select(input.scopes!) : this.connectors.connections().map(connection => ({ ...connection, tools: connectorReadToolNames(connection.service) }));
    if (input.expectedPolicy && canonical(connections) !== canonical(input.expectedPolicy))
      throw new HttpError(409, '대기 중 외부 연결 계정이나 권한이 바뀌었습니다. 연결을 확인한 뒤 태그를 붙여 다시 보내세요');
    const capability = randomBytes(32).toString('base64url'), expiresAt = this.now() + ttl;
    this.db.prepare('INSERT INTO connector_grant VALUES (?,?,?,?,?,?,?,0,?)').run(hash(capability), input.workspaceId,
      input.requestId, input.taskId ?? null, input.sessionId ?? null, expiresAt, JSON.stringify(connections),scoped?DEFAULT_TTL:null);
    return { capability, hubId: this.hubId, workspaceId: input.workspaceId, requestId: input.requestId, expiresAt, connections, ...(scoped && {inputScoped:true as const}) };
  }

  private grant(context: ConnectorContext): GrantRow {
    if (this.closed) throw new HttpError(503, '외부 연결 권한 처리가 종료되었습니다');
    if (!context || typeof context.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(context.capability)
      || ![context.workspaceId, context.requestId, context.taskId, context.sessionId].every(validId))
      throw new HttpError(403, '외부 연결 요청 권한을 확인하지 못했습니다');
    const row = this.db.prepare('SELECT * FROM connector_grant WHERE capability_hash=?').get(hash(context.capability)) as GrantRow | undefined;
    if (!row || row.revoked || row.expires_at <= this.now() || row.workspace_id !== context.workspaceId || row.request_id !== context.requestId
      || (row.task_id !== null && row.task_id !== context.taskId) || (row.session_id !== null && row.session_id !== context.sessionId))
      throw new HttpError(403, '외부 연결 요청 권한이 만료되었거나 문맥이 일치하지 않습니다');
    return row;
  }

  /** The authoritative broker binds newly-created tasks exactly once before exposing tools. */
  bind(context: ConnectorContext): void {
    const row = this.grant(context);
    if (row.task_id === null || row.session_id === null || row.active_ttl_ms !== null)
      this.db.prepare('UPDATE connector_grant SET task_id=?,session_id=?,expires_at=?,active_ttl_ms=NULL WHERE capability_hash=?')
        .run(context.taskId,context.sessionId,row.active_ttl_ms===null?row.expires_at:Math.min(row.expires_at,this.now()+row.active_ttl_ms),row.capability_hash);
  }

  private allowed(context: ConnectorContext, service?: ConnectorService): { row: GrantRow; policies: ConnectorPolicy[] } {
    const row = this.grant(context);
    if (row.task_id === null || row.session_id === null) throw new HttpError(403, '실행 작업에 아직 결합하지 않은 외부 연결 허가입니다');
    const policies = JSON.parse(row.policy) as ConnectorPolicy[];
    const live = this.connectors.connections();
    const current = policies.filter(policy => live.some(connection => connection.service === policy.service && connection.generation === policy.generation));
    if (service !== undefined && !current.some(policy => policy.service === service))
      throw new HttpError(403, '이 요청에 허용되지 않았거나 교체·해제된 외부 연결입니다');
    return { row, policies: current };
  }

  list(context: ConnectorContext) {
    return { hubId: this.hubId, requestId: context.requestId, connections: this.allowed(context).policies };
  }

  async tools(submitted: ConnectorContext & { service: ConnectorService }) {
    requireAdmission();
    const context = { ...submitted };
    const { policies } = this.allowed(context, context.service);
    if (this.active.size + this.catalogActive >= 8) throw new HttpError(429, '외부 조회 동시 처리 한도에 도달했습니다');
    this.catalogActive++;
    try {
      const result = await this.connectors.tools(context.service);
      this.allowed(context, context.service);
      const names = new Set(policies.find(policy => policy.service === context.service)!.tools);
      const tools = result.filter(tool => names.has(tool.name));
      if (Buffer.byteLength(JSON.stringify(tools)) > MAX_RESULT) throw new HttpError(502, '외부 도구 목록이 너무 큽니다');
      return tools;
    } finally { this.catalogActive--; }
  }

  async call(submitted: ConnectorCall): Promise<Awaited<ReturnType<Connectors['read']>>> {
    requireAdmission();
    const input = { ...submitted };
    const { row, policies } = this.allowed(input, input.service);
    if (!validId(input.callId) || typeof input.tool !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))
      throw new HttpError(400, '외부 조회 호출 형식이 올바르지 않습니다');
    if (!policies.find(policy => policy.service === input.service)?.tools.includes(input.tool))
      throw new HttpError(403, '이 요청에 허용된 읽기 도구만 사용할 수 있습니다');
    const args = canonical(input.arguments);
    if (Buffer.byteLength(args) > 64 * 1024) throw new HttpError(413, '외부 조회 인자가 너무 큽니다');
    const fingerprint = hash(canonical({ workspaceId: input.workspaceId, requestId: input.requestId, taskId: input.taskId,
      sessionId: input.sessionId, service: input.service, tool: input.tool, arguments: JSON.parse(args) }));
    const key = row.capability_hash + ':' + input.callId;
    const prior = this.db.prepare('SELECT fingerprint,result,error FROM connector_call WHERE capability_hash=? AND call_id=?')
      .get(row.capability_hash, input.callId) as CallRow | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HttpError(409, '같은 조회 ID의 내용이 바뀌었습니다');
      const running = this.active.get(key);
      if (running) { await running; return this.call(input); }
      this.allowed(input, input.service);
      if (prior.result !== null) return JSON.parse(prior.result);
      if (prior.error !== null) { const error = JSON.parse(prior.error); throw new HttpError(error.status, error.message); }
      throw new HttpError(409, '이전 조회가 중단되었습니다. 새 조회 ID로 다시 요청하세요');
    }
    if (this.active.size + this.catalogActive >= 8) throw new HttpError(429, '외부 조회 동시 처리 한도에 도달했습니다');
    this.prune();
    const usage = this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(result AS BLOB))),0) bytes FROM connector_call').get() as { n: number; bytes: number };
    if (usage.n >= 1024 || usage.bytes >= MAX_CACHE) throw new HttpError(429, '외부 조회 결과 보관 한도에 도달했습니다');
    this.db.prepare('INSERT INTO connector_call VALUES (?,?,?,NULL,NULL)').run(row.capability_hash, input.callId, fingerprint);
    const operation = (async () => {
      try {
        // Freeze the accepted arguments: callers cannot alter an in-flight invocation.
        const result = await this.connectors.read(input.service, input.tool, JSON.parse(args));
        this.allowed(input, input.service);
        const encoded = JSON.stringify(result);
        const bytes = (this.db.prepare('SELECT coalesce(sum(length(CAST(result AS BLOB))),0) bytes FROM connector_call').get() as { bytes: number }).bytes;
        if (Buffer.byteLength(encoded) > MAX_RESULT || bytes + Buffer.byteLength(encoded) > MAX_CACHE)
          throw new HttpError(502, '외부 조회 결과가 보관 한도를 넘었습니다');
        this.db.prepare('UPDATE connector_call SET result=? WHERE capability_hash=? AND call_id=?').run(encoded, row.capability_hash, input.callId);
        return result;
      } catch (cause) {
        const error = cause instanceof HttpError ? cause : new HttpError(502, '외부 조회를 처리하지 못했습니다');
        if (!this.closed) this.db.prepare('UPDATE connector_call SET error=? WHERE capability_hash=? AND call_id=?')
          .run(JSON.stringify({ status: error.status, message: error.message }), row.capability_hash, input.callId);
        throw error;
      }
    })();
    this.active.set(key, operation);
    try { return await operation; }
    finally { if (this.active.get(key) === operation) this.active.delete(key); }
  }

  revoke(capability: string) { this.db.prepare('UPDATE connector_grant SET revoked=1 WHERE capability_hash=?').run(hash(capability)); }
  revokeWorkspace(workspaceId: string) { this.db.prepare('UPDATE connector_grant SET revoked=1 WHERE workspace_id=?').run(workspaceId); }
  close() { this.closed = true; clearInterval(this.sweepTimer); }
}

/** Shared by network polling and the colocated gateway; never trusts IDs from tool arguments. */
export async function executeConnectorJob(authority: ConnectorAuthority, job: ConnectorJob): Promise<ConnectorCompletion> {
  try {
    authority.bind(job.context);
    let result: unknown;
    if (job.method === 'list') result = authority.list(job.context);
    else if (job.method === 'tools') result = await authority.tools({ ...job.context, service: job.args.service as ConnectorService });
    else if (job.method === 'read') result = await authority.call({ ...job.context, callId: job.callId,
      service: job.args.service as ConnectorService, tool: job.args.tool as string, arguments: job.args.arguments as Record<string, unknown> });
    else throw new HttpError(400, '지원하지 않는 외부 조회입니다');
    return { result };
  } catch (error) {
    return { error: { status: error instanceof HttpError ? error.status : 502,
      message: error instanceof HttpError ? error.message : '외부 조회를 처리하지 못했습니다' } };
  }
}
