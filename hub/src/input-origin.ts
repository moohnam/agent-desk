import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { HubIdentity } from './ssh-authority.ts';
import { HttpError } from './errors.ts';
/** Server-assigned provenance. Never deserialize it from a user's operation body. */
export class InputOrigin {
  private scope=new AsyncLocalStorage<HubIdentity|undefined>();private db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS input_origin(id TEXT PRIMARY KEY,author TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_origin(session_id TEXT PRIMARY KEY,author TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revoked_run(session_id TEXT PRIMARY KEY);`);}
  stopping(session:string){return !!this.db.prepare('SELECT 1 FROM revoked_run WHERE session_id=?').get(session);}
  stop(session:string){this.db.prepare('INSERT OR IGNORE INTO revoked_run VALUES(?)').run(session);}
  stopped(session:string){return Number(this.db.prepare('DELETE FROM revoked_run WHERE session_id=?').run(session).changes)>0;}
  current(){return this.scope.getStore();}
  with<T>(author:HubIdentity|undefined,work:()=>T){return this.scope.run(author,work);}
  remember(id:string){const author=this.current();this.db.prepare('INSERT OR IGNORE INTO input_origin VALUES(?,?)').run(id,JSON.stringify(author ?? null));}
  has(id:string){return !!this.db.prepare('SELECT 1 FROM input_origin WHERE id=?').get(id);}
  queued(id:string){const row=this.db.prepare('SELECT author FROM input_origin WHERE id=?').get(id) as {author:string}|undefined;return row?(JSON.parse(row.author) as HubIdentity|null) ?? undefined:undefined;}
  run(session:string){const row=this.db.prepare('SELECT author FROM run_origin WHERE session_id=?').get(session) as {author:string}|undefined;return row?(JSON.parse(row.author) as HubIdentity|null) ?? undefined:undefined;}
  assertAllowed(author=this.current()){
    if(author&&!this.db.prepare('SELECT 1 FROM workspace_peer WHERE id=? AND revoked=0').get(author.peerId))throw new HttpError(403,'요청한 허브의 연결 권한이 취소되었습니다');
  }
  claim(session:string){this.assertAllowed();const author=this.current();if(author)this.db.prepare('INSERT OR REPLACE INTO run_origin VALUES(?,?)').run(session,JSON.stringify(author));else this.db.prepare('DELETE FROM run_origin WHERE session_id=?').run(session);}
  restore<T>(id:string,work:()=>T){const author=this.queued(id);this.assertAllowed(author);return this.with(author,work);}
  runs(peer:string){return (this.db.prepare('SELECT session_id FROM run_origin WHERE json_extract(author,\'$.peerId\')=?').all(peer) as {session_id:string}[]).map(x=>x.session_id);}
}
