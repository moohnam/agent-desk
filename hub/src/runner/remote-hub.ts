import {modelReference, type EngineName} from '../../../shared/compose.ts';
import {checkModelCatalogs, type ModelCatalogs} from '../../../shared/model-catalog.ts';
import { DEFAULT_INSTRUCTIONS } from '../instruction-store.ts';
// Durable remote delivery uses the hub's own SQLite transaction, separate from the #later queue.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RemoteExchange, RemoteReply, RemoteRunnerView } from '../../../shared/remote.ts';
import { remoteLocation } from '../../../shared/remote.ts';
import { checkRunnerToHub, type HubToRunner, type LiveSession, type RunnerToHub } from '../../../shared/protocol.ts';
import type { Session, Store } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { RunnerPort } from './client.ts';
import type { SkillStore } from '../skills.ts';
import { checkUsageReport, type UsageReading, type UsageReport, type UsageRequest, type UsageTarget } from '../../../shared/runner-usage.ts';
import { UsageProbe } from './usage-probe.ts';

type Peer = { id: string; address: string; token_hash: string; journal_id: string | null; event_ack: number; sent_through: number; last_seen: string | null; engines: string; sessions: string; skill_snapshot: number; instructions: number; connector_mcp: number };
type CommandRow = { seq: number; payload: string };
type PreviousModel = Pick<Session, 'model' | 'effort'>;
type StoredCommand = HubToRunner & { previousModel?: PreviousModel };
type RejectedCommand = { message: string; busy: boolean; uncertain: boolean; sequences: number[]; invalidatesQueue: boolean; previousModel?: PreviousModel };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const ALIVE_MS = 15_000;
const UPDATE_RUNNER = '러너를 업데이트한 뒤 스레드에서 필요한 요청을 다시 보내세요.';

function unsupported(command: HubToRunner, caps: { models?: boolean; connector?: boolean; instructions?: boolean; skills?: boolean }) {
  if ((command.type === 'start' || command.type === 'set_model') && modelReference(command.model) && caps.models === false) return '실제 모델 ID 선택';
  if (command.type === 'start' && command.connectorMcp && !caps.connector) return '외부 연결 도구';
  if (command.type === 'start' && command.instructions !== undefined && command.instructions !== DEFAULT_INSTRUCTIONS && !caps.instructions) return '사용자 지침';
  if ((command.type === 'start' || command.type === 'send') && command.skillSnapshot && !caps.skills) return '고정 스킬 버전';
}

/** The delivery tables also exist before a migrated workspace starts its Hub. */
export function ensureRemoteTables(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_runner (
      id TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL, journal_id TEXT,
      event_ack INTEGER NOT NULL DEFAULT 0, sent_through INTEGER NOT NULL DEFAULT 0, last_seen TEXT,
      engines TEXT NOT NULL DEFAULT '["claude","codex","agy"]', sessions TEXT NOT NULL DEFAULT '[]',
      skill_snapshot INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS remote_command (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, runner_id TEXT NOT NULL REFERENCES remote_runner(id),
      session_id TEXT NOT NULL, kind TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS remote_command_runner ON remote_command(runner_id, seq);
      CREATE INDEX IF NOT EXISTS remote_command_session ON remote_command(session_id);
      CREATE TABLE IF NOT EXISTS remote_migration (
        runner_id TEXT PRIMARY KEY, address TEXT NOT NULL, fingerprint TEXT NOT NULL,
        legacy_json TEXT NOT NULL, committed_at TEXT NOT NULL);`);
  if (!(db.prepare('PRAGMA table_info(remote_command)').all() as {name:string}[]).some(c=>c.name==='kind')) {
    db.exec("ALTER TABLE remote_command ADD COLUMN kind TEXT; UPDATE remote_command SET kind=json_extract(payload,'$.type')");
  }
  if (!(db.prepare('PRAGMA table_info(remote_runner)').all() as {name:string}[]).some(c=>c.name==='skill_snapshot'))
    db.exec('ALTER TABLE remote_runner ADD COLUMN skill_snapshot INTEGER NOT NULL DEFAULT 0');
  if (!(db.prepare('PRAGMA table_info(remote_runner)').all() as {name:string}[]).some(c=>c.name==='instructions'))
    db.exec('ALTER TABLE remote_runner ADD COLUMN instructions INTEGER NOT NULL DEFAULT 0');
  if (!(db.prepare('PRAGMA table_info(remote_runner)').all() as {name:string}[]).some(c=>c.name==='connector_mcp'))
    db.exec('ALTER TABLE remote_runner ADD COLUMN connector_mcp INTEGER NOT NULL DEFAULT 0');
}

export class RemoteRunners implements RunnerPort {
  private db: DatabaseSync;
  private syncing = new Set<string>();
  private timer: NodeJS.Timeout;
  private store: Store;
  private local: RunnerPort;
  private onMessage: (m: RunnerToHub, at?: string) => void;
  private onSnapshot: (sessions: LiveSession[], runnerId: string) => void;
  private onReadyExchange: (runnerId: string) => void;
  private onRejected: (sessionId: string, result: RejectedCommand) => void;
  private changed: () => void;
  private skills: SkillStore;
  private reported = '';
  private catalogs = new Map<string,ModelCatalogs>();
  private modelSupport = new Map<string, boolean>();
  private catalogRequests = new Map<string,boolean>();
  private localUsage = new UsageProbe();
  private localUsageId?: string;
  private localUsageSupported = false;
  private remoteUsage = new Map<string, UsageProbe>();
  private usageSupported = new Set<string>();

  localUsageHello(id: string, supported: boolean) {
    if (this.localUsageId !== id) {
      this.localUsage.disconnect();
      this.localUsage = new UsageProbe();
      this.localUsageId = id;
    }
    if (!supported) this.localUsage.disconnect();
    this.localUsageSupported = supported;
  }
  localUsageDisconnected() { this.localUsage.disconnect(); }
  acceptLocalUsage(report: UsageReport) { this.localUsage.accept(report); }

  usageTargets(includeLocal: boolean): UsageTarget[] {
    return [...(includeLocal ? [{ id: 'local', label: '이 Mac', runnerId: this.localUsageId }] : []),
      ...this.peers().map(peer => ({ id: peer.id, label: peer.address, runnerId: peer.id }))];
  }

  readUsage(id: string, engine: EngineName, refresh: boolean): Promise<UsageReading> {
    if (id === 'local') {
      if (!this.local.connected) return Promise.resolve(this.localUsage.offline(engine));
      if (!this.localUsageSupported || !this.local.engines.has(engine)) return Promise.resolve({ status: 'unsupported' });
      return this.localUsage.read(engine, refresh, () => this.local.connected,
        request => this.local.handle({ type: 'refresh_usage', sessionId: 'runner-usage', request }));
    }
    const peer = this.peer(id);
    if (!peer) throw new HttpError(404, '등록되지 않은 러너입니다');
    const online = () => { const current = this.peer(id); return !!current && this.heartbeatAlive(current); };
    const probe = this.remoteUsage.get(id);
    if (!online()) return Promise.resolve(probe?.offline(engine) ?? { status: 'offline' });
    if (!probe || !this.usageSupported.has(id) || !JSON.parse(peer.engines).includes(engine))
      return Promise.resolve({ status: 'unsupported' });
    return probe.read(engine, refresh, online);
  }
  refreshModels(force=false) {
    this.local.refreshModels?.(force);
    for (const peer of this.peers()) if (this.catalogs.has(peer.id)) this.catalogRequests.set(peer.id,force || this.catalogRequests.get(peer.id) === true);
  }
  catalogsSupported(id: string) { return this.catalogs.has(id); }
  catalogsFor(id: string): ModelCatalogs { return this.catalogs.get(id) ?? {}; }
  constructor(store: Store, local: RunnerPort,
    onMessage: (m: RunnerToHub, at?: string) => void,
    onSnapshot: (sessions: LiveSession[], runnerId: string) => void,
    changed: () => void, skills: SkillStore, onReadyExchange: (runnerId: string) => void,
    onRejected: (sessionId: string, result: RejectedCommand) => void) {
    this.store=store; this.local=local; this.onMessage=onMessage; this.onSnapshot=onSnapshot; this.changed=changed;
    this.skills=skills;
    this.onReadyExchange=onReadyExchange;
    this.onRejected=onRejected;
    this.db = store.database;
    ensureRemoteTables(this.db);
    // A process restart does not prove that a remote process has stopped.
    this.db.prepare('UPDATE remote_runner SET last_seen = NULL').run();
    this.timer = setInterval(() => {
      const expired = this.peers().filter(p => p.last_seen && Date.now() - Date.parse(p.last_seen) > ALIVE_MS);
      for (const peer of expired) {
        this.db.prepare('UPDATE remote_runner SET last_seen = NULL WHERE id = ?').run(peer.id);
        this.remoteUsage.get(peer.id)?.disconnect();
        this.notify();
      }
    }, 3000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.localUsage.disconnect();
    for (const probe of this.remoteUsage.values()) probe.disconnect();
  }
  private notify() {
    const signature = JSON.stringify(this.list().map(({last_seen, ...view}) => view));
    if (signature !== this.reported) { this.reported = signature; this.changed(); }
  }
  get connected() { return this.local.connected; }
  get connectionProblem() { return this.local.connectionProblem; }
  get id() { return this.local.id; }
  get engines() { return this.local.engines; }
  private peers() { return this.db.prepare('SELECT * FROM remote_runner').all() as unknown as Peer[]; }
  peer(id: string) { return this.db.prepare('SELECT * FROM remote_runner WHERE id = ?').get(id) as Peer | undefined; }
  owns(id: string) { return !!this.peer(id); }
  private sessionPeer(sessionId: string) { const s = this.store.getSession(sessionId); return s ? this.peer(s.runner_id) : undefined; }
  private heartbeatAlive(p: Peer) { return !!p.last_seen && Date.now() - Date.parse(p.last_seen) < ALIVE_MS; }
  private online(p: Peer) { return !this.syncing.has(p.id) && this.heartbeatAlive(p); }
  ready(sessionId: string) { const p = this.sessionPeer(sessionId); return p ? this.online(p) : this.local.connected; }
  canQueue(sessionId: string) { return !!this.sessionPeer(sessionId); }
  canConnector(sessionId: string) { const peer = this.sessionPeer(sessionId);
    return peer ? peer.connector_mcp === 1 : this.local.connectorMcpSupported === true; }
  canSnapshot(sessionId?: string) { const peer = sessionId ? this.sessionPeer(sessionId) : undefined;
    return peer ? peer.skill_snapshot === 1 : this.local.skillSnapshotSupported !== false; }
  canSnapshotForPath(path: string) { const peer = this.forPath(path);
    return peer ? peer.skill_snapshot === 1 : this.local.skillSnapshotSupported !== false; }
  has(sessionId: string) {
    const p = this.sessionPeer(sessionId);
    return p ? this.online(p) && ((JSON.parse(p.sessions) as LiveSession[]).some(s => s.sessionId === sessionId)
      || this.pendingWork(p.id).some(s => s.sessionId === sessionId)) : this.local.has(sessionId);
  }
  forPath(path: string) {
    let location;
    try { location = remoteLocation(path); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    if (!location) return null;
    const peers = this.peers();
    const migrated=this.db.prepare('SELECT address FROM remote_migration').all() as {address:string}[];
    if (migrated.some(r=>r.address===location.address||(!location.address.includes('@')&&r.address.split('@').at(-1)===location.address)))
      throw new HttpError(409, '이 원격 러너의 작업 원본은 해당 머신의 작업공간으로 옮겼습니다');
    // An explicitly registered name also remains stable when more accounts are registered later.
    const exact = peers.find(p => p.address === location.address);
    if (exact) return exact;
    // Include offline peers: connectivity must not choose between accounts on the same host.
    const candidates = peers.filter(p => !location.address.includes('@') && p.address.split('@').at(-1) === location.address);
    if (!candidates.length) throw new HttpError(409, `${location.address} 러너를 먼저 등록하세요`);
    if (candidates.length > 1) throw new HttpError(409, `${location.address}에 러너가 여러 개 있습니다. ${candidates.map(p=>p.address).join(', ')} 중 실행 계정까지 지정하세요`);
    return candidates[0];
  }
  canonicalPath(path: string) {
    const peer = this.forPath(path);
    return peer ? `${peer.address}:${remoteLocation(path)!.path}` : null;
  }
  list(): RemoteRunnerView[] {
    return this.peers().map(p => ({ id: p.id, address: p.address, connected: this.online(p), last_seen: p.last_seen,
      pending: Number((this.db.prepare("SELECT count(*) AS n FROM remote_command WHERE runner_id = ? AND session_id NOT GLOB 'delivery-ack-*'").get(p.id) as { n: number }).n), engines: JSON.parse(p.engines) }));
  }
  register(address: string) {
    try {
      if (typeof address !== 'string' || remoteLocation(`${address}:/`)?.address !== address) throw new Error();
    } catch { throw new HttpError(400, '호스트 또는 사용자@호스트 형식으로 입력하세요'); }
    if (this.peers().some(p => p.address === address)) throw new HttpError(409, '이미 등록된 러너입니다');
    if (this.db.prepare('SELECT 1 FROM remote_migration WHERE address=?').get(address))
      throw new HttpError(409, '이미 해당 머신의 작업공간으로 이관한 러너입니다');
    const id = `remote-${randomUUID()}`, token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO remote_runner (id, address, token_hash) VALUES (?, ?, ?)').run(id, address, hash(token));
    this.notify();
    return { runner: this.list().find(p => p.id === id)!, token };
  }
  rotate(id: string) {
    if (!this.peer(id)) throw new HttpError(404, '등록되지 않은 러너입니다');
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE remote_runner SET token_hash = ?, last_seen = NULL WHERE id = ?').run(hash(token), id);
    this.remoteUsage.get(id)?.disconnect();
    this.notify();
    return { runner: this.list().find(p => p.id === id)!, token };
  }
  cancelSession(sessionId: string) {
    const peer = this.sessionPeer(sessionId);
    if (!peer) return false;
    this.db.prepare('DELETE FROM remote_command WHERE session_id = ? AND runner_id = ?').run(sessionId, peer.id);
    this.handle({ type: 'close', sessionId });
    return true;
  }
  accepts(id: string, token: unknown) {
    const p = this.peer(id);
    return !!p && typeof token === 'string' && timingSafeEqual(Buffer.from(p.token_hash), Buffer.from(hash(token)));
  }
  handle(cmd: HubToRunner, previousModel?: PreviousModel) {
    if (cmd.type === 'auth') throw new Error('unexpected auth command');
    // This hub stores subagent reports (subagents.ts); runners send them only when asked.
    if (cmd.type === 'start') {
      const rows = cmd.resume && !cmd.fork ? this.db.prepare('SELECT id, info_json FROM subagent WHERE session_id = ? LIMIT 10000').all(cmd.sessionId) as {id:string;info_json:string}[] : [];
      const links = rows.flatMap(row => {
        const {id,type,description,status,toolUseId,agent,parentId,background,backgroundEvidence,command} = JSON.parse(row.info_json);
        return typeof toolUseId === 'string' ? [{id:row.id,toolUseId,info:{id,type,description,status,toolUseId,agent,parentId,background,backgroundEvidence,command}}] : [];
      });
      cmd = { ...cmd, subagents: true, ...(links.length ? {subagentLinks:links} : {}) };
    }
    const peer = this.sessionPeer(cmd.sessionId);
    if (!peer) { this.local.handle(cmd); return; }
    const feature = unsupported(cmd, { models: this.modelSupport.get(peer.id),
      connector: peer.connector_mcp === 1, instructions: peer.instructions === 1, skills: peer.skill_snapshot === 1 });
    if (feature) throw new HttpError(409, `현재 원격 러너는 ${feature} 기능을 지원하지 않습니다. ${UPDATE_RUNNER}`);
    if (cmd.type === 'start') {
      const location = remoteLocation(cmd.cwd);
      if (!location || (location.address !== peer.address && this.forPath(cmd.cwd)?.id !== peer.id)) throw new Error('원격 작업 경로와 러너가 일치하지 않습니다');
      cmd = { ...cmd, cwd: location.path, skillsHome: undefined };
    }
    if ((cmd.type === 'start' || (cmd.type === 'send' && cmd.skills?.length)) && !cmd.skillSnapshot) {
      const files = this.skills.list().flatMap(s => s.files.map(f => ({ name: s.name, ...this.skills.readFile(s.name, f.path) })));
      if (Buffer.byteLength(JSON.stringify(files)) > 4 * 1024 * 1024) throw new HttpError(413, '원격 전송할 데스크 스킬은 합계 4 MiB 이하여야 합니다');
      cmd = { ...cmd, skillFiles: files };
    }
    this.db.prepare('INSERT INTO remote_command (runner_id, session_id, kind, payload) VALUES (?, ?, ?, ?)')
      .run(peer.id, cmd.sessionId, cmd.type, JSON.stringify(previousModel ? { ...cmd, previousModel } : cmd));
    // A start already queued but not reported by the runner must not look like a lost session.
    this.notify();
  }
  private pendingWork(id: string): LiveSession[] {
    return (this.db.prepare("SELECT DISTINCT session_id FROM remote_command WHERE runner_id = ? AND kind IN ('start','send')").all(id) as unknown as { session_id: string }[])
      .map(r => ({ sessionId: r.session_id, busy: true, approvals: [] }));
  }
  pendingFor(sessionId: string) {
    return Number((this.db.prepare('SELECT count(*) AS n FROM remote_command WHERE session_id = ?').get(sessionId) as { n: number }).n);
  }
  private commandBatch(id: string): CommandRow[] {
    return this.db.prepare('SELECT seq, payload FROM remote_command WHERE runner_id = ? ORDER BY seq LIMIT 16').all(id) as CommandRow[];
  }
  /** Record skipped sequences before ACK can advance past them. Previously offered input needs manual confirmation. */
  private rejectUnsupported(peer: Peer, input: RemoteExchange): boolean {
    let rejected = false;
    let uncertainThrough = 0;
    const live = new Map(input.sessions.map(session => [session.sessionId, session]));
    const caps = { models: input.modelCatalogs !== undefined, connector: input.connectorMcp, instructions: input.instructions, skills: input.skillSnapshot };
    if (caps.models && caps.connector && caps.instructions && caps.skills) return false;
    for (const row of this.commandBatch(peer.id)) {
      const command = JSON.parse(row.payload) as StoredCommand;
      const feature = unsupported(command, caps);
      if (!feature || command.type === 'auth') continue;
      const removed = this.db.prepare(`DELETE FROM remote_command WHERE runner_id = ? AND session_id = ? AND
        (seq = ? OR (seq > ? AND (kind IN ('start','send') OR (? = 1 AND kind = 'set_model')))) RETURNING seq`)
        .all(peer.id, command.sessionId, row.seq, row.seq, command.type === 'set_model' ? 1 : 0) as { seq: number }[];
      if (!removed.length) continue;
      rejected = true;
      const sequences = removed.map(entry => entry.seq).sort((a, b) => a - b);
      const offered = sequences.filter(seq => seq <= peer.sent_through).at(-1);
      if (offered !== undefined) uncertainThrough = Math.max(uncertainThrough, offered);
      const pending = this.db.prepare("SELECT 1 FROM remote_command WHERE session_id = ? AND kind IN ('start','send') LIMIT 1").get(command.sessionId);
      const session = live.get(command.sessionId);
      const uncertain = offered !== undefined;
      const message = `원격 러너가 ${feature} 기능을 지원하지 않아 이 요청${removed.length > 1 ? '과 같은 세션의 후속 요청' : ''}의 전달을 중단했습니다. ${uncertain ? '이미 전송을 시도한 요청은 실행 여부를 먼저 확인하세요. ' : ''}${UPDATE_RUNNER}`;
      this.onRejected(command.sessionId, { message, sequences, uncertain, busy: !!(pending || session?.busy || session?.approvals.length),
        invalidatesQueue: command.type !== 'send', previousModel: command.previousModel });
    }
    // A fresh sequence, using the existing no-op close on a reserved non-session ID, lets even
    // an old journal advance its watermark. Never change the payload of an already offered seq.
    if (uncertainThrough && !this.db.prepare("SELECT 1 FROM remote_command WHERE runner_id = ? AND seq > ? AND session_id GLOB 'delivery-ack-*' LIMIT 1").get(peer.id, uncertainThrough)) {
      const sessionId = `delivery-ack-${randomUUID()}`;
      this.db.prepare("INSERT INTO remote_command (runner_id, session_id, kind, payload) VALUES (?, ?, 'close', ?)")
        .run(peer.id, sessionId, JSON.stringify({ type: 'close', sessionId }));
    }
    return rejected;
  }
  exchange(id: string, input: RemoteExchange): RemoteReply {
    const peer = this.peer(id);
    if (!peer) throw new HttpError(404, '등록되지 않은 러너입니다');
    if (!input || input.version !== 1 || typeof input.journalId !== 'string' || input.journalId.length > 100 || !input.journalId
      || !integer(input.commandAck) || input.commandAck > peer.sent_through || !Array.isArray(input.events) || input.events.length > 64
      || typeof input.more !== 'boolean' || !Array.isArray(input.sessions) || !Array.isArray(input.engines)
      || input.engines.some(e => !['claude','codex','agy'].includes(e)) || (input.skillSnapshot !== undefined && typeof input.skillSnapshot !== 'boolean') || (input.connectorMcp !== undefined && typeof input.connectorMcp !== 'boolean') || (input.instructions !== undefined && typeof input.instructions !== 'boolean')) throw new HttpError(400, '원격 러너 교환 형식이 잘못되었습니다');
    if (input.modelCatalogs !== undefined && !checkModelCatalogs(input.modelCatalogs)) throw new HttpError(400, '모델 목록 형식이 잘못되었습니다');
    if (peer.journal_id && peer.journal_id !== input.journalId) throw new HttpError(409, '러너 전달 DB가 바뀌었습니다. 이전 DB를 복구하거나 새 러너로 등록하세요');
    const snapshot = checkRunnerToHub({ type: 'hello', runnerId: id, host: peer.address, capabilities: { engines: input.engines }, sessions: input.sessions });
    if (typeof snapshot === 'string' || input.sessions.length > 1000 || input.sessions.some(s => !s || typeof s.sessionId !== 'string' || typeof s.busy !== 'boolean' || !Array.isArray(s.approvals) || s.approvals.some(a => !a || typeof a.approvalId !== 'string' || typeof a.toolName !== 'string') || (this.store.getSession(s.sessionId) && this.store.getSession(s.sessionId)?.runner_id !== id))) throw new HttpError(403, '다른 러너의 세션을 보고할 수 없습니다');
    let ack = peer.event_ack, previous = 0;
    // A subagent report this hub cannot read is passed over: a record must not hold up the session's delivery.
    const unreadable = new Set<number>();
    for (const item of input.events) {
      let event = checkRunnerToHub(item?.value);
      const raw = item?.value as unknown as { type?: unknown; sessionId?: unknown } | undefined;
      if (typeof event === 'string' && (raw?.type === 'subagent' || raw?.type === 'subagent_event') && typeof raw.sessionId === 'string') {
        unreadable.add(item.seq);
        event = { type: 'subagent_event', sessionId: raw.sessionId, subagentId: '-', event: { kind: 'user', text: '' } };
      }
      if (!integer(item?.seq) || item.seq < 1 || item.seq <= previous || typeof event === 'string' || event.type === 'hello' || event.type === 'usage'
        || (item.created_at !== undefined && (typeof item.created_at !== 'string' || item.created_at.length > 30 || !Number.isFinite(Date.parse(item.created_at))))
        || (this.store.getSession(event.sessionId)?.runner_id !== id && this.store.getSession(event.sessionId))) throw new HttpError(403, '다른 러너의 이벤트이거나 잘못된 이벤트입니다');
      previous = item.seq;
      if (item.seq <= ack) continue;
      if (item.seq !== ack + 1) throw new HttpError(409, `이벤트 ${ack + 1}부터 다시 보내세요`);
      ack = item.seq;
    }
    const reconcile = !this.online(peer) || peer.sessions !== JSON.stringify(input.sessions) || ack > peer.event_ack
      || peer.connector_mcp !== (input.connectorMcp === true ? 1 : 0) || peer.instructions !== (input.instructions === true ? 1 : 0) || peer.skill_snapshot !== (input.skillSnapshot === true ? 1 : 0);
    this.syncing.add(id);
    const priorModelSupport = this.modelSupport.get(id);
    this.modelSupport.set(id, input.modelCatalogs !== undefined);
    this.db.exec('SAVEPOINT remote_exchange');
    try {
      this.db.prepare('DELETE FROM remote_command WHERE runner_id = ? AND seq <= ?').run(id, input.commandAck);
      for (const item of input.events) if (item.seq > peer.event_ack && !unreadable.has(item.seq)) this.onMessage(item.value, item.created_at);
      this.db.prepare('UPDATE remote_runner SET journal_id = ?, event_ack = ?, last_seen = ?, engines = ?, sessions = ?, skill_snapshot = ?, instructions = ?, connector_mcp = ? WHERE id = ?')
        .run(input.journalId, ack, new Date().toISOString(), JSON.stringify(input.engines), JSON.stringify(input.sessions), input.skillSnapshot === true ? 1 : 0, input.instructions === true ? 1 : 0, input.connectorMcp === true ? 1 : 0, id);
      if (!input.more) {
        const rejected = this.rejectUnsupported(peer, input);
        this.syncing.delete(id);
        const combined = new Map(input.sessions.map(s => [s.sessionId, s]));
        for (const pending of this.pendingWork(id)) combined.set(pending.sessionId, { ...pending, ...combined.get(pending.sessionId), busy: true });
        if (reconcile || rejected) this.onSnapshot([...combined.values()], id);
        this.onReadyExchange(id);
      }
      let bytes = 0;
      const commands: { seq: number; value: HubToRunner }[] = [];
      if (!input.more) for (const row of this.commandBatch(id)) {
        const { previousModel: _, ...value } = JSON.parse(row.payload) as StoredCommand;
        // A batch may reveal more commands after pruning. Leave an incompatible sequence for the next exchange.
        if (unsupported(value, { models: input.modelCatalogs !== undefined, connector: input.connectorMcp, instructions: input.instructions, skills: input.skillSnapshot })) break;
        bytes += Buffer.byteLength(row.payload);
        if (bytes > 8 * 1024 * 1024) break;
        commands.push({ seq: row.seq, value });
      }
      if (commands.length) this.db.prepare('UPDATE remote_runner SET sent_through = max(sent_through, ?) WHERE id = ?').run(commands.at(-1)!.seq, id);
      this.db.exec('RELEASE remote_exchange');
      if (input.modelCatalogs !== undefined) this.catalogs.set(id,structuredClone(input.modelCatalogs));
      else this.catalogs.delete(id);
      this.notify();
      const forceModelRefresh = this.catalogRequests.get(id);
      const refreshModels = input.modelCatalogs !== undefined && this.catalogRequests.delete(id);
      const reports = input.usageReports;
      let usageRequests: UsageRequest[] | undefined;
      if (Array.isArray(reports) && reports.length <= 3) {
        this.usageSupported.add(id);
        let probe = this.remoteUsage.get(id);
        if (!probe) this.remoteUsage.set(id, probe = new UsageProbe());
        for (const report of reports) if (checkUsageReport(report)) probe.accept(report);
        usageRequests = probe.requests();
      } else if (this.usageSupported.delete(id)) this.remoteUsage.get(id)?.disconnect();
      return { eventAck: ack, commands, ...(refreshModels ? {refreshModels:true,forceModelRefresh} : {}),
        ...(usageRequests?.length && { usageRequests }) };
    } catch (e) {
      this.db.exec('ROLLBACK TO remote_exchange; RELEASE remote_exchange');
      if (priorModelSupport === undefined) this.modelSupport.delete(id);
      else this.modelSupport.set(id, priorModelSupport);
      throw e;
    }
    finally { if (!input.more) this.syncing.delete(id); }
  }
}
