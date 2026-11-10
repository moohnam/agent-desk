// Durable remote delivery uses the hub's own SQLite transaction, separate from the #later queue.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RemoteExchange, RemoteReply, RemoteRunnerView } from '../../../shared/remote.ts';
import { remoteLocation } from '../../../shared/remote.ts';
import { checkRunnerToHub, type HubToRunner, type LiveSession, type RunnerToHub } from '../../../shared/protocol.ts';
import type { Store } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { RunnerPort } from './client.ts';
import type { SkillStore } from '../skills.ts';

type Peer = { id: string; address: string; token_hash: string; journal_id: string | null; event_ack: number; sent_through: number; last_seen: string | null; engines: string; sessions: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const ALIVE_MS = 15_000;

export class RemoteRunners implements RunnerPort {
  private db: DatabaseSync;
  private syncing = new Set<string>();
  private timer: NodeJS.Timeout;
  private store: Store;
  private local: RunnerPort;
  private onMessage: (m: RunnerToHub, at?: string) => void;
  private onSnapshot: (sessions: LiveSession[], runnerId: string) => void;
  private changed: () => void;
  private skills: SkillStore;
  private reported = '';
  constructor(store: Store, local: RunnerPort,
    onMessage: (m: RunnerToHub, at?: string) => void,
    onSnapshot: (sessions: LiveSession[], runnerId: string) => void,
    changed: () => void, skills: SkillStore) {
    this.store=store; this.local=local; this.onMessage=onMessage; this.onSnapshot=onSnapshot; this.changed=changed;
    this.skills=skills;
    this.db = store.database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_runner (
      id TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL, journal_id TEXT,
      event_ack INTEGER NOT NULL DEFAULT 0, sent_through INTEGER NOT NULL DEFAULT 0, last_seen TEXT,
      engines TEXT NOT NULL DEFAULT '["claude","codex","agy"]', sessions TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS remote_command (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, runner_id TEXT NOT NULL REFERENCES remote_runner(id),
      session_id TEXT NOT NULL, kind TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS remote_command_runner ON remote_command(runner_id, seq);
      CREATE INDEX IF NOT EXISTS remote_command_session ON remote_command(session_id);`);
    if (!(this.db.prepare('PRAGMA table_info(remote_command)').all() as {name:string}[]).some(c=>c.name==='kind')) {
      this.db.exec("ALTER TABLE remote_command ADD COLUMN kind TEXT; UPDATE remote_command SET kind=json_extract(payload,'$.type')");
    }
    // A process restart does not prove that a remote process has stopped.
    this.db.prepare('UPDATE remote_runner SET last_seen = NULL').run();
    this.timer = setInterval(() => {
      const expired = this.peers().filter(p => p.last_seen && Date.now() - Date.parse(p.last_seen) > ALIVE_MS);
      for (const peer of expired) { this.db.prepare('UPDATE remote_runner SET last_seen = NULL WHERE id = ?').run(peer.id); this.notify(); }
    }, 3000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  private notify() {
    const signature = JSON.stringify(this.list().map(({last_seen, ...view}) => view));
    if (signature !== this.reported) { this.reported = signature; this.changed(); }
  }
  get connected() { return this.local.connected; }
  get id() { return this.local.id; }
  get engines() { return this.local.engines; }
  private peers() { return this.db.prepare('SELECT * FROM remote_runner').all() as unknown as Peer[]; }
  peer(id: string) { return this.db.prepare('SELECT * FROM remote_runner WHERE id = ?').get(id) as Peer | undefined; }
  owns(id: string) { return !!this.peer(id); }
  private sessionPeer(sessionId: string) { const s = this.store.getSession(sessionId); return s ? this.peer(s.runner_id) : undefined; }
  private online(p: Peer) { return !this.syncing.has(p.id) && !!p.last_seen && Date.now() - Date.parse(p.last_seen) < ALIVE_MS; }
  ready(sessionId: string) { const p = this.sessionPeer(sessionId); return p ? this.online(p) : this.local.connected; }
  canQueue(sessionId: string) { return !!this.sessionPeer(sessionId); }
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
      pending: Number((this.db.prepare('SELECT count(*) AS n FROM remote_command WHERE runner_id = ?').get(p.id) as { n: number }).n), engines: JSON.parse(p.engines) }));
  }
  register(address: string) {
    try {
      if (typeof address !== 'string' || remoteLocation(`${address}:/`)?.address !== address) throw new Error();
    } catch { throw new HttpError(400, '호스트 또는 사용자@호스트 형식으로 입력하세요'); }
    if (this.peers().some(p => p.address === address)) throw new HttpError(409, '이미 등록된 러너입니다');
    const id = `remote-${randomUUID()}`, token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO remote_runner (id, address, token_hash) VALUES (?, ?, ?)').run(id, address, hash(token));
    this.notify();
    return { runner: this.list().find(p => p.id === id)!, token };
  }
  rotate(id: string) {
    if (!this.peer(id)) throw new HttpError(404, '등록되지 않은 러너입니다');
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE remote_runner SET token_hash = ?, last_seen = NULL WHERE id = ?').run(hash(token), id);
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
  handle(cmd: HubToRunner) {
    if (cmd.type === 'auth') throw new Error('unexpected auth command');
    const peer = this.sessionPeer(cmd.sessionId);
    if (!peer) { this.local.handle(cmd); return; }
    if (cmd.type === 'start') {
      const location = remoteLocation(cmd.cwd);
      if (!location || (location.address !== peer.address && this.forPath(cmd.cwd)?.id !== peer.id)) throw new Error('원격 작업 경로와 러너가 일치하지 않습니다');
      cmd = { ...cmd, cwd: location.path, skillsHome: undefined };
    }
    if (cmd.type === 'start' || (cmd.type === 'send' && cmd.skills?.length)) {
      const files = this.skills.list().flatMap(s => s.files.map(f => ({ name: s.name, ...this.skills.readFile(s.name, f.path) })));
      if (Buffer.byteLength(JSON.stringify(files)) > 4 * 1024 * 1024) throw new HttpError(413, '원격 전송할 데스크 스킬은 합계 4 MiB 이하여야 합니다');
      cmd = { ...cmd, skillFiles: files };
    }
    this.db.prepare('INSERT INTO remote_command (runner_id, session_id, kind, payload) VALUES (?, ?, ?, ?)')
      .run(peer.id, cmd.sessionId, cmd.type, JSON.stringify(cmd));
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
  exchange(id: string, input: RemoteExchange): RemoteReply {
    const peer = this.peer(id);
    if (!peer) throw new HttpError(404, '등록되지 않은 러너입니다');
    if (!input || input.version !== 1 || typeof input.journalId !== 'string' || input.journalId.length > 100 || !input.journalId
      || !integer(input.commandAck) || input.commandAck > peer.sent_through || !Array.isArray(input.events) || input.events.length > 64
      || typeof input.more !== 'boolean' || !Array.isArray(input.sessions) || !Array.isArray(input.engines)
      || input.engines.some(e => !['claude','codex','agy'].includes(e))) throw new HttpError(400, '원격 러너 교환 형식이 잘못되었습니다');
    if (peer.journal_id && peer.journal_id !== input.journalId) throw new HttpError(409, '러너 전달 DB가 바뀌었습니다. 이전 DB를 복구하거나 새 러너로 등록하세요');
    const snapshot = checkRunnerToHub({ type: 'hello', runnerId: id, host: peer.address, capabilities: { engines: input.engines }, sessions: input.sessions });
    if (typeof snapshot === 'string' || input.sessions.length > 1000 || input.sessions.some(s => !s || typeof s.sessionId !== 'string' || typeof s.busy !== 'boolean' || !Array.isArray(s.approvals) || s.approvals.some(a => !a || typeof a.approvalId !== 'string' || typeof a.toolName !== 'string') || (this.store.getSession(s.sessionId) && this.store.getSession(s.sessionId)?.runner_id !== id))) throw new HttpError(403, '다른 러너의 세션을 보고할 수 없습니다');
    let ack = peer.event_ack, previous = 0;
    for (const item of input.events) {
      const event = checkRunnerToHub(item?.value);
      if (!integer(item?.seq) || item.seq < 1 || item.seq <= previous || typeof event === 'string' || event.type === 'hello'
        || (item.created_at !== undefined && (typeof item.created_at !== 'string' || item.created_at.length > 30 || !Number.isFinite(Date.parse(item.created_at))))
        || (this.store.getSession(event.sessionId)?.runner_id !== id && this.store.getSession(event.sessionId))) throw new HttpError(403, '다른 러너의 이벤트이거나 잘못된 이벤트입니다');
      previous = item.seq;
      if (item.seq <= ack) continue;
      if (item.seq !== ack + 1) throw new HttpError(409, `이벤트 ${ack + 1}부터 다시 보내세요`);
      ack = item.seq;
    }
    const reconcile = !this.online(peer) || peer.sessions !== JSON.stringify(input.sessions) || ack > peer.event_ack;
    this.syncing.add(id);
    this.db.exec('SAVEPOINT remote_exchange');
    try {
      this.db.prepare('DELETE FROM remote_command WHERE runner_id = ? AND seq <= ?').run(id, input.commandAck);
      for (const item of input.events) if (item.seq > peer.event_ack) this.onMessage(item.value, item.created_at);
      this.db.prepare('UPDATE remote_runner SET journal_id = ?, event_ack = ?, last_seen = ?, engines = ?, sessions = ? WHERE id = ?')
        .run(input.journalId, ack, new Date().toISOString(), JSON.stringify(input.engines), JSON.stringify(input.sessions), id);
      if (!input.more) {
        this.syncing.delete(id);
        const combined = new Map(input.sessions.map(s => [s.sessionId, s]));
        for (const pending of this.pendingWork(id)) combined.set(pending.sessionId, { ...pending, ...combined.get(pending.sessionId), busy: true });
        if (reconcile) this.onSnapshot([...combined.values()], id);
      }
      let bytes = 0;
      const commands = !input.more ? (this.db.prepare('SELECT seq, payload FROM remote_command WHERE runner_id = ? ORDER BY seq LIMIT 16').all(id) as unknown as { seq: number; payload: string }[])
        .filter(r => { bytes += Buffer.byteLength(r.payload); return bytes <= 8 * 1024 * 1024; })
        .map(r => ({ seq: r.seq, value: JSON.parse(r.payload) as HubToRunner })) : [];
      if (commands.length) this.db.prepare('UPDATE remote_runner SET sent_through = max(sent_through, ?) WHERE id = ?').run(commands.at(-1)!.seq, id);
      this.db.exec('RELEASE remote_exchange');
      this.notify();
      return { eventAck: ack, commands };
    } catch (e) { this.db.exec('ROLLBACK TO remote_exchange; RELEASE remote_exchange'); throw e; }
    finally { if (!input.more) this.syncing.delete(id); }
  }
}
