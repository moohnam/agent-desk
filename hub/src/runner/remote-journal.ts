// Disk-backed inbox/outbox. Receipt means committed, not executed. Ambiguous dispatch is never replayed.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Sequenced } from '../../../shared/remote.ts';
import type { HubToRunner, RunnerToHub } from '../../../shared/protocol.ts';
import { checkHubToRunner } from '../../../shared/protocol.ts';

export class RemoteJournal {
  private db: DatabaseSync;
  readonly id: string;
  private claimed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL, digest TEXT, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT);`);
    if (!(this.db.prepare('PRAGMA table_info(outbox)').all() as {name:string}[]).some(c=>c.name==='created_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN created_at TEXT');
    if (!(this.db.prepare('PRAGMA table_info(inbox)').all() as {name:string}[]).some(c=>c.name==='digest')) this.db.exec('ALTER TABLE inbox ADD COLUMN digest TEXT');
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('id', ?)").run(randomUUID());
    this.id = this.get('id')!;
  }
  claim() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.get('lease');
      if (lease) {
        const old = JSON.parse(lease) as { host: string; pid: number };
        if (old.host !== hostname()) throw new Error('이 전달 DB는 다른 머신에서 사용 중입니다');
        let alive = true;
        try { process.kill(old.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive=false; }
        if (alive) throw new Error('이 전달 DB를 사용하는 원격 러너가 이미 실행 중입니다');
      }
      this.set('lease', JSON.stringify({host:hostname(),pid:process.pid}));
      this.db.exec('COMMIT'); this.claimed=true;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() {
    if (this.claimed) this.db.prepare("DELETE FROM meta WHERE key='lease'").run();
    this.db.close();
  }
  private get(key: string) { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  private set(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  bind(hub: string, runnerId: string) {
    const binding = JSON.stringify([hub,runnerId]);
    if (this.get('binding') && this.get('binding') !== binding) throw new Error('전달 DB는 다른 허브·러너에 연결할 수 없습니다. 별도 DB를 사용하세요');
    this.set('binding', binding);
  }
  /** A migrated workspace keeps the original journal and its acknowledged sequence. */
  assertRunner(runnerId: string) {
    const binding=this.get('binding');
    if (!binding) throw new Error('기존 원격 전달 DB의 연결 기록이 없습니다');
    let id: string;
    try { id=(JSON.parse(binding) as [string,string])[1]; }
    catch { throw new Error('원격 전달 DB 연결 기록이 손상되었습니다'); }
    if (id!==runnerId) throw new Error('원격 전달 DB의 러너 ID가 이관 대상과 다릅니다');
  }
  get commandAck() { return Number(this.get('commandAck') ?? 0); }
  get eventAck() { return Number(this.get('eventAck') ?? 0); }
  get hasUndeliveredCommands() {
    return !!this.db.prepare("SELECT 1 FROM inbox WHERE state IN ('pending','dispatching') LIMIT 1").get();
  }
  /** Reject an old copy with the same journal UUID but missing acknowledged history. */
  assertTransferState(eventAck:number,sentThrough:number) {
    if(!Number.isSafeInteger(eventAck)||eventAck<0||!Number.isSafeInteger(sentThrough)||sentThrough<0)
      throw new Error('원본 원격 확인 번호가 잘못되었습니다');
    // A lost command reply can leave retained commands on the source, but without a
    // per-runner historical command index a lower copied ACK cannot be proved complete.
    if(this.commandAck!==sentThrough)throw new Error('원격 전달 DB의 명령 확인 번호가 원본과 다릅니다. 기존 러너의 교환을 먼저 완료하세요');
    if(this.eventAck>eventAck||this.lastEvent<eventAck)
      throw new Error('원격 전달 DB에 원본 허브가 확인한 출력 이력이 없습니다');
    if(this.eventAck<eventAck){
      const rows=this.db.prepare('SELECT count(*) n,min(seq) first,max(seq) last FROM outbox WHERE seq>? AND seq<=?')
        .get(this.eventAck,eventAck) as {n:number;first:number|null;last:number|null};
      if(rows.n!==eventAck-this.eventAck||rows.first!==this.eventAck+1||rows.last!==eventAck)
        throw new Error('원격 전달 DB에서 원본 허브가 확인한 출력 일부를 다시 보낼 수 없습니다');
    }
  }
  receive(commands: Sequenced<HubToRunner>[]) {
    if (!Array.isArray(commands) || commands.length > 16) throw new Error('invalid remote command batch');
    const ack = this.commandAck;
    let previous = 0;
    for (const c of commands) {
      if (!Number.isSafeInteger(c.seq) || c.seq < 1 || c.seq <= previous || !c.value || c.value.type === 'auth') throw new Error('invalid command sequence');
      const value = c.value;
      const checked = checkHubToRunner(value.type === 'start' ? {...value, cwd: value.cwd?.startsWith('~/') ? '/remote-home' : value.cwd} : value);
      if (typeof checked === 'string') throw new Error(`invalid remote command: ${checked}`);
      previous = c.seq;
      const old = this.db.prepare('SELECT payload,digest FROM inbox WHERE seq=?').get(c.seq) as { payload: string; digest: string | null } | undefined;
      const digest = createHash('sha256').update(JSON.stringify(c.value)).digest('hex');
      if (old && (old.digest ?? createHash('sha256').update(old.payload).digest('hex')) !== digest) throw new Error('command changed during retransmission');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of commands) if (c.seq > ack) {
        const payload = JSON.stringify(c.value);
        this.db.prepare('INSERT OR IGNORE INTO inbox (seq,payload,digest) VALUES (?,?,?)').run(c.seq,payload,createHash('sha256').update(payload).digest('hex'));
      }
      this.set('commandAck', String(Math.max(ack, commands.at(-1)?.seq ?? 0)));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  next(): Sequenced<HubToRunner> | undefined {
    const r = this.db.prepare("SELECT seq,payload FROM inbox WHERE state='pending' ORDER BY seq LIMIT 1").get() as { seq:number;payload:string } | undefined;
    return r ? { seq:r.seq,value:JSON.parse(r.payload) } : undefined;
  }
  dispatching(seq: number) { this.db.prepare("UPDATE inbox SET state='dispatching' WHERE seq=? AND state='pending'").run(seq); }
  dispatched(seq: number) {
    // Retain a small deduplication record, not another copy of the prompt and skill tree forever.
    this.db.prepare("UPDATE inbox SET state='dispatched', payload='{}' WHERE seq=?").run(seq);
  }
  recoverAmbiguous() {
    const rows = this.db.prepare("SELECT seq,payload FROM inbox WHERE state='dispatching'").all() as unknown as {seq:number;payload:string}[];
    for (const r of rows) {
      const cmd = JSON.parse(r.payload) as Exclude<HubToRunner,{type:'auth'}>;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.emit({type:'event',sessionId:cmd.sessionId,event:{kind:'status',state:'error',detail:{message:`명령 ${r.seq} 전달 도중 러너가 종료되어 실행 여부를 확정할 수 없습니다. 자동 재실행하지 않았습니다.`,command_id:r.seq}}});
        this.db.prepare("UPDATE inbox SET state='uncertain' WHERE seq=?").run(r.seq);
        this.db.exec('COMMIT');
      } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return rows.length;
  }
  emit(message: RunnerToHub) {
    this.db.prepare('INSERT INTO outbox (payload,created_at) VALUES (?,?)').run(JSON.stringify(message),new Date().toISOString());
  }
  events(): Sequenced<RunnerToHub>[] {
    // Bound each HTTP batch by bytes too; a single large user question must still fit the hub limit.
    const rows = this.db.prepare('SELECT seq,payload,created_at FROM outbox ORDER BY seq LIMIT 64').all() as unknown as {seq:number;payload:string;created_at:string}[];
    let bytes=0;
    return rows.filter(r => { bytes += Buffer.byteLength(r.payload); return bytes <= 1024*1024; }).map(r=>({seq:r.seq,value:JSON.parse(r.payload),created_at:r.created_at ?? undefined}));
  }
  get lastEvent() { return Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='outbox'").get() as {seq:number}|undefined)?.seq ?? 0); }
  acknowledge(ack: number, sentThrough: number) {
    if (!Number.isSafeInteger(ack) || ack < this.eventAck || ack > sentThrough) throw new Error('invalid event acknowledgement');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM outbox WHERE seq<=?').run(ack); this.set('eventAck',String(ack)); this.db.exec('COMMIT'); }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
