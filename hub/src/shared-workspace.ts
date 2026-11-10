import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Hub } from './hub.ts';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import { readBody } from './body.ts';
import { workspaceApi, workspaceRoute, type WorkspaceResult } from './workspace-api.ts';
import type { WorkspaceOperation } from '../../shared/workspace.ts';
import type { HubMessage } from '../../shared/api.ts';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function operation(input: unknown): WorkspaceOperation {
  const v = input as WorkspaceOperation;
  if (!v || typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(v.id)
    || typeof v.method !== 'string' || v.method === 'GET' || typeof v.path !== 'string'
    || !workspaceRoute(v.method, v.path) || !v.body || typeof v.body !== 'object' || Array.isArray(v.body)) {
    throw new HttpError(400, '잘못된 공유 작업 명령입니다');
  }
  return { id: v.id, method: v.method, path: v.path, body: v.body };
}
export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** One canonical workspace, many separately revocable hub credentials. */
export class SharedWorkspace {
  readonly id: string;
  private db: DatabaseSync;
  private owner?: Hub;
  private get hub() { if (!this.owner) throw new Error('작업공간 실행 프로세스가 필요합니다'); return this.owner; }
  private streams = new Map<ServerResponse, string>();
  constructor(hub: Hub | undefined, store?: Store) {
    this.owner = hub; this.db = (hub?.store ?? store!).database;
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_identity (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS workspace_peer (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workspace_receipt (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);`);
    if (!this.db.prepare('SELECT id FROM workspace_identity').get()) this.db.prepare('INSERT INTO workspace_identity VALUES (?)').run(randomUUID());
    this.id = (this.db.prepare('SELECT id FROM workspace_identity').get() as { id: string }).id;
  }
  peers() { return this.db.prepare('SELECT id,name,revoked FROM workspace_peer').all(); }
  grant(name: string) {
    if (!name?.trim() || name.length > 100) throw new HttpError(400, '허브 이름이 필요합니다');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO workspace_peer(id,name,token_hash) VALUES (?,?,?)').run(id,name.trim(),digest(token));
    return { id, token, workspace_id: this.id };
  }
  revoke(id: string) {
    this.db.prepare('UPDATE workspace_peer SET revoked=1 WHERE id=?').run(id);
    for (const [res, peer] of this.streams) if (peer === id) res.end();
  }
  authenticate(token: string | undefined) {
    if (!token || token.length > 256) throw new HttpError(401, '공유 작업공간 연결 토큰이 필요합니다');
    const supplied = Buffer.from(digest(token));
    const peer = (this.db.prepare('SELECT id,token_hash FROM workspace_peer WHERE revoked=0').all() as {id:string;token_hash:string}[])
      .find(p=>timingSafeEqual(supplied,Buffer.from(p.token_hash)));
    if (!peer) throw new HttpError(401, '공유 작업공간 연결 권한이 없거나 취소되었습니다');
    return peer.id;
  }
  execute(peer: string, input: unknown): WorkspaceResult {
    const op = operation(input), hash = digest(canonical(op));
    return this.hub.atomic(() => {
      // Authentication may precede a slow request body. Check revocation again in
      // the transaction that accepts the operation, including receipt replays.
      if (!this.db.prepare('SELECT id FROM workspace_peer WHERE id=? AND revoked=0').get(peer)) throw new HttpError(401, '공유 작업공간 연결 권한이 없거나 취소되었습니다');
      const held = this.db.prepare('SELECT digest,result FROM workspace_receipt WHERE id=?').get(op.id) as {digest:string;result:string}|undefined;
      if (held) {
        if (held.digest !== hash) throw new HttpError(409, '같은 명령 ID의 내용이 바뀌었습니다');
        return JSON.parse(held.result);
      }
      let result: WorkspaceResult;
      try { result = this.hub.atomic(()=>workspaceApi(this.hub,op.method,new URL(op.path,'http://workspace'),op.body)); }
      catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        result = {status:e.status,body:{error:e.message}};
      }
      this.db.prepare('INSERT INTO workspace_receipt VALUES (?,?,?,?,?)').run(op.id,peer,hash,JSON.stringify(result),new Date().toISOString());
      return result;
    });
  }
  read(path: string) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 10000) throw new HttpError(400,'잘못된 조회 경로입니다');
    const url = new URL(path,'http://workspace');
    if (url.pathname === '/state') return {...this.hub.state(),client:{local:false}};
    if (url.pathname === '/skills') return this.hub.skills.list();
    if (url.pathname === '/channels') return [];
    if (url.pathname === '/runners') return this.hub.remotes.list();
    if (url.pathname === '/usage') throw new HttpError(409,'공유 러너의 사용량 조회는 지원하지 않습니다');
    return workspaceApi(this.hub,'GET',url).body;
  }
  server() {
    const server = createServer(async(req,res)=>{
      try {
        // Only machine-to-machine requests; never cookie/local-IP authorization.
        if (req.headers.origin) throw new HttpError(403,'허브를 통해 연결하세요');
        const peer = this.authenticate(req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]);
        const url = new URL(req.url ?? '/', 'http://workspace');
        if (req.method === 'GET' && url.pathname === '/v1/identity') return json(res,200,{version:1,workspace_id:this.id});
        if (req.headers['x-workspace-id'] !== this.id) return json(res,409,{code:'workspace_mismatch',error:'연결 대상 작업공간이 바뀌었습니다. 연결 설정을 확인하세요'});
        if (req.method === 'GET' && url.pathname === '/v1/read') return json(res,200,this.read(url.searchParams.get('path')!));
        if (req.method === 'POST' && url.pathname === '/v1/operation') {
          const result = this.execute(peer,await readBody(req));
          return json(res,result.status,result.body);
        }
        if (req.method === 'GET' && url.pathname === '/v1/stream') {
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(': connected\n\n');
          const write = (m:HubMessage)=>{ if (res.writableLength > 1024*1024) res.destroy(); else res.write(`data: ${JSON.stringify(m)}\n\n`); };
          const ping = setInterval(()=>{
            try { this.authenticate(req.headers.authorization?.slice(7)); res.write(': ping\n\n'); }
            catch { res.end(); }
          },5000);
          this.streams.set(res,peer);this.hub.bus.on('message',write);
          res.on('close',()=>{clearInterval(ping);this.streams.delete(res);this.hub.bus.off('message',write);});
          return;
        }
        throw new HttpError(404,'지원하지 않는 공유 API입니다');
      } catch(e) { json(res,e instanceof HttpError?e.status:500,{error:e instanceof HttpError?e.message:'공유 작업공간 처리에 실패했습니다'}); }
    });
    server.on('close',()=>{for(const res of this.streams.keys())res.end();});
    return server;
  }
}
