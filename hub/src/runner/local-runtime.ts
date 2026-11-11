import { hostname } from 'node:os';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { REQUEST_TOOL } from '../../../shared/compose.ts';
import { PROTOCOL_VERSION, type RunnerToHub } from '../../../shared/protocol.ts';
import { Store } from '../db.ts';
import { Hub } from '../hub.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { SkillStore } from '../skills.ts';
import { RunnerClient, type RunnerClientOptions, type RunnerFactory, type RunnerPort } from './client.ts';

export type LocalTakeover = {runner: RunnerClient; hello: Extract<RunnerToHub,{type:'hello'}>};

/** Verify the first authenticated hello before any runner event reaches Hub or the DB owner changes. */
export function verifyLocalTakeover(db: DatabaseSync, hello: LocalTakeover['hello']) {
  if (hello.protocolVersion !== PROTOCOL_VERSION || hello.runnerId !== `local-${hostname()}` || hello.host !== hostname())
    throw new Error('기존 로컬 러너 ID 또는 프로토콜이 일치하지 않습니다');
  const stored = db.prepare("SELECT id,runner_id,status FROM session WHERE source='app' AND runner_id LIKE 'local-%'")
    .all() as {id:string;runner_id:string;status:string}[];
  const byId = new Map(stored.map(s => [s.id,s]));
  const live = new Set<string>(), approvals = new Set<string>();
  for (const session of hello.sessions) {
    if (live.has(session.sessionId) || byId.get(session.sessionId)?.runner_id !== hello.runnerId)
      throw new Error('러너 hello에 원본 DB와 다른 세션이 있습니다');
    live.add(session.sessionId);
    for (const approval of session.approvals) {
      if (approvals.has(approval.approvalId)) throw new Error('러너 hello에 중복된 승인이 있습니다');
      approvals.add(approval.approvalId);
    }
  }
  if (stored.some(s => (s.status === 'running' || s.status === 'waiting')
    && (s.runner_id !== hello.runnerId || !live.has(s.id))))
    throw new Error('진행 중인 로컬 세션이 기존 러너 hello에 없습니다');
  const pending = db.prepare("SELECT a.id FROM approval a JOIN session s ON s.id=a.session_id WHERE a.status='pending' AND a.tool_name<>? AND s.source='app' AND s.runner_id LIKE 'local-%'")
    .all(REQUEST_TOOL) as {id:string}[];
  if (pending.some(a => !approvals.has(a.id))) throw new Error('미처리 승인이 기존 러너 hello에 없습니다');
}

/** The local authority uses the existing task DB and the existing, independently living daemon. */
export class LocalRuntime {
  readonly hub!: Hub;
  readonly workspace!: SharedWorkspace;
  private readonly runner!: RunnerPort;
  private closed = false;
  private activated = false;
  private readonly takeoverRunnerId?:string;
  private takeoverCallbacks?: {onMessage:(message:RunnerToHub)=>void;onConnection:(connected:boolean)=>void};

  constructor(dbPath: string, opts: { runner?: RunnerFactory; skills?: SkillStore; graceMs?: number; takeover?: LocalTakeover } = {}) {
    const store = new Store(dbPath);
    let runner: RunnerPort | undefined;
    let claimed = false;
    let alreadyActivated = false;
    try {
      this.takeoverRunnerId=opts.takeover?.hello.runnerId;
      const db = store.database;
      db.exec(`CREATE TABLE IF NOT EXISTS local_authority (
        id INTEGER PRIMARY KEY CHECK (id=1), host TEXT NOT NULL, pid INTEGER NOT NULL,
        activated_at TEXT NOT NULL);`);
      db.exec('BEGIN IMMEDIATE');
      try {
        const owner = db.prepare('SELECT host,pid,activated_at FROM local_authority WHERE id=1').get() as {host:string;pid:number;activated_at:string}|undefined;
        alreadyActivated = !!owner?.activated_at;
        if (owner?.pid) {
          let alive = owner.host !== hostname();
          if (!alive) {
            try { process.kill(owner.pid, 0); alive = true; }
            catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          }
          if (alive) throw new Error('로컬 작업공간을 소유한 프로세스가 이미 실행 중입니다');
        }
        if (!alreadyActivated) {
          // Initial cutover is explicitly offline. Subsequent authority restarts may reconnect to
          // sessions which its daemon kept alive, so this check is only for the first activation.
          const active = db.prepare("SELECT count(*) AS n FROM session WHERE source='app' AND status IN ('running','waiting')").get() as {n:number};
          const approvals = db.prepare("SELECT count(*) AS n FROM approval WHERE status='pending'").get() as {n:number};
          if (opts.takeover) {
            if (!opts.takeover.runner.connected || opts.takeover.runner.id !== opts.takeover.hello.runnerId)
              throw new Error('기존 4318 러너 연결이 끊겼습니다');
            verifyLocalTakeover(db,opts.takeover.hello);
          } else if (active.n || approvals.n) throw new Error('기존 세션 또는 승인이 진행 중입니다. 모두 끝난 뒤 로컬 작업공간을 전환하세요');
        }
        db.prepare('INSERT INTO local_authority(id,host,pid,activated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host,pid=excluded.pid').run(hostname(),process.pid,owner?.activated_at??'');
        db.exec('COMMIT');
        claimed = true;
        this.activated = alreadyActivated;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      this.hub = new Hub(store, {skills:opts.skills,graceMs:opts.graceMs,runner: (onMessage,onConnection) => {
        if (opts.takeover) {
          runner=opts.takeover.runner;
          this.takeoverCallbacks={onMessage,onConnection};
        } else runner = (opts.runner ?? ((message,connection) => new RunnerClient(message,connection)))(onMessage,onConnection);
        return runner;
      }});
      this.runner = runner!;
      this.workspace = new SharedWorkspace(this.hub,undefined,{localAuthority:true});
      if (opts.takeover) opts.takeover.runner.handoff(this.takeoverCallbacks!.onMessage,this.takeoverCallbacks!.onConnection,opts.takeover.hello);
    } catch (error) {
      this.hub?.dispose();
      if (runner && 'close' in runner && typeof runner.close === 'function') runner.close();
      if (claimed) {
        if (alreadyActivated) store.database.prepare('UPDATE local_authority SET pid=0 WHERE id=1 AND host=? AND pid=?').run(hostname(),process.pid);
        else store.database.prepare("DELETE FROM local_authority WHERE id=1 AND host=? AND pid=? AND activated_at=''").run(hostname(),process.pid);
      }
      store.database.close();
      throw error;
    }
  }

  /** First successful listen commits the mode switch. A failed first listen leaves legacy usable. */
  activate() {
    if (this.closed) throw new Error('종료된 로컬 작업공간은 활성화할 수 없습니다');
    if (this.activated) return;
    if(this.takeoverRunnerId&&(!this.runner.connected||this.runner.id!==this.takeoverRunnerId))
      throw new Error('기존 4318 러너 연결이 활성화 전에 끊겼습니다');
    const changed=this.hub.store.database.prepare("UPDATE local_authority SET activated_at=? WHERE id=1 AND host=? AND pid=? AND activated_at=''")
      .run(new Date().toISOString(),hostname(),process.pid).changes;
    if(changed!==1)throw new Error('로컬 작업공간 소유권이 바뀌어 활성화하지 못했습니다');
    this.activated=true;
  }

  server(): Server {
    const server=this.workspace.server();
    server.on('listening',()=>{
      try{this.activate();}
      catch(error){server.close();this.close();server.emit('error',error);}
    });
    server.on('error',()=>this.close());
    return server;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.hub.dispose();
    if ('close' in this.runner && typeof this.runner.close === 'function') this.runner.close();
    if (this.activated) this.hub.store.database.prepare('UPDATE local_authority SET pid=0 WHERE id=1 AND host=? AND pid=?').run(hostname(),process.pid);
    else this.hub.store.database.prepare("DELETE FROM local_authority WHERE id=1 AND host=? AND pid=? AND activated_at=''").run(hostname(),process.pid);
    this.hub.store.database.close();
  }
}

/** One authenticated connection: validate hello synchronously, then give that socket to Hub. */
export async function connectLocalTakeover(dbPath:string, opts:{timeoutMs?:number;client?:RunnerClientOptions;skills?:SkillStore;graceMs?:number}={}) {
  const source=new DatabaseSync(dbPath,{readOnly:true});
  let sourceOpen=true;
  const closeSource=()=>{if(sourceOpen){sourceOpen=false;source.close();}};
  return await new Promise<LocalRuntime>((resolve,reject)=>{
    let finished=false;
    let runner:RunnerClient|undefined;
    const timer=setTimeout(()=>fail(new Error('기존 4318 러너의 인증된 hello를 받지 못했습니다')),opts.timeoutMs??5000);
    const fail=(error:unknown)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);runner?.close();closeSource();reject(error);
    };
    try {
      runner=new RunnerClient(message=>{
        if(finished)return;
        if(message.type!=='hello'){fail(new Error('기존 러너가 hello보다 앞서 이벤트를 보냈습니다'));return;}
        try {
          verifyLocalTakeover(source,message);
          closeSource();
          const runtime=new LocalRuntime(dbPath,{takeover:{runner:runner!,hello:message},skills:opts.skills,graceMs:opts.graceMs});
          finished=true;clearTimeout(timer);resolve(runtime);
        }catch(error){fail(error);}
      },()=>{},{...opts.client,spawnIfMissing:false,onError:fail});
    } catch(error) {fail(error);}
  });
}
