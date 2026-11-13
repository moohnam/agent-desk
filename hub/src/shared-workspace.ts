import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Hub } from './hub.ts';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import { readBody } from './body.ts';
import { localAuthorityRoute, workspaceApi, workspaceRoute, type WorkspaceResult } from './workspace-api.ts';
import type { WorkspaceOperation } from '../../shared/workspace.ts';
import { applySkillBundle, ensureSharedSkillTables, listPeerSkills, peerSkillManifest, peerSkillStore, removeAbsentSkills, restoreSkillBundle, syncSkillVersion, type SkillBundle, type SkillReference } from './shared-skill-sync.ts';
import type { HubMessage } from '../../shared/api.ts';
import { sendWorkspaceFile } from './shared-files.ts';
import { handleMcp } from './mcp.ts';
import { linkTarget } from './open.ts';
import { remoteLocation } from '../../shared/remote.ts';
import { handleWorkspaceBroker } from './request-broker.ts';

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
  private localAuthority: boolean;
  private get hub() { if (!this.owner) throw new Error('작업공간 실행 프로세스가 필요합니다'); return this.owner; }
  private streams = new Map<ServerResponse, string>();
  private files = new Map<ServerResponse, string>();
  constructor(hub: Hub | undefined, store?: Store, opts: {localAuthority?:boolean} = {}) {
    this.owner = hub; this.db = (hub?.store ?? store!).database;
    this.localAuthority = opts.localAuthority === true;
    ensureSharedSkillTables(this.db);
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
    for (const [res, peer] of this.files) if (peer === id) res.destroy();
  }
  authenticate(token: string | undefined) {
    if (!token || token.length > 256) throw new HttpError(401, '공유 작업공간 연결 토큰이 필요합니다');
    const supplied = Buffer.from(digest(token));
    const peer = (this.db.prepare('SELECT id,token_hash FROM workspace_peer WHERE revoked=0').all() as {id:string;token_hash:string}[])
      .find(p=>timingSafeEqual(supplied,Buffer.from(p.token_hash)));
    if (!peer) throw new HttpError(401, '공유 작업공간 연결 권한이 없거나 취소되었습니다');
    return peer.id;
  }
  private assertPeer(peer:string) {
    if(!this.db.prepare('SELECT 1 FROM workspace_peer WHERE id=? AND revoked=0').get(peer))
      throw new HttpError(401,'공유 작업공간 연결 권한이 없거나 취소되었습니다');
  }
  execute(peer: string, input: unknown): WorkspaceResult {
    const op = operation(input), hash = digest(canonical(op));
    if (!this.localAuthority && localAuthorityRoute(op.method,op.path)) throw new HttpError(400,'공유 작업공간에서 지원하지 않는 요청입니다');
    this.assertPeer(peer);
    const prior = this.db.prepare('SELECT digest,result FROM workspace_receipt WHERE id=?').get(op.id) as {digest:string;result:string}|undefined;
    if (prior) {
      if (prior.digest !== hash) throw new HttpError(409,'같은 명령 ID의 내용이 바뀌었습니다');
      return JSON.parse(prior.result);
    }
    if(op.body.__desk_skill_bundle!==undefined)
      applySkillBundle(this.db,this.hub.skills,peer,op.id,op.body.__desk_skill_bundle as SkillBundle);
    const snapshot=op.body.__desk_skill_ref
      ? restoreSkillBundle(this.hub.skills,peer,op.body.__desk_skill_ref as SkillReference)
      : op.body.__desk_skill_bundle as SkillBundle|undefined;
    if(op.body.__desk_skill_ref && !snapshot)
      return {status:409,body:{code:'skill_missing',error:'스킬 버전이 없거나 지문이 다릅니다. 준비 파일을 보내야 합니다'}};
    return this.hub.atomic(() => {
      // Authentication may precede a slow request body. Check revocation again in
      // the transaction that accepts the operation, including receipt replays.
      this.assertPeer(peer);
      const held = this.db.prepare('SELECT digest,result FROM workspace_receipt WHERE id=?').get(op.id) as {digest:string;result:string}|undefined;
      if (held) {
        if (held.digest !== hash) throw new HttpError(409, '같은 명령 ID의 내용이 바뀌었습니다');
        return JSON.parse(held.result);
      }
      let result: WorkspaceResult;
      try { result = this.hub.atomic(()=>snapshot
        ? this.hub.withSkillSnapshot(snapshot,
          () => workspaceApi(this.hub,op.method,new URL(op.path,'http://workspace'),op.body))
        : workspaceApi(this.hub,op.method,new URL(op.path,'http://workspace'),op.body)); }
      catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        result = {status:e.status,body:{error:e.message}};
      }
      this.db.prepare('INSERT INTO workspace_receipt VALUES (?,?,?,?,?)').run(op.id,peer,hash,JSON.stringify(result),new Date().toISOString());
      this.db.prepare('DELETE FROM shared_skill_prepare WHERE peer_id=? AND op_id=?').run(peer,op.id);
      return result;
    });
  }
  read(path: string, peer?: string) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 10000) throw new HttpError(400,'잘못된 조회 경로입니다');
    const url = new URL(path,'http://workspace');
    if (!this.localAuthority && localAuthorityRoute('GET',url.pathname)) throw new HttpError(404,'공유 작업공간에서 지원하지 않는 조회입니다');
    if (this.localAuthority && url.pathname === '/open-target') {
      const href=url.searchParams.get('href');
      if(!href)throw new HttpError(400,'href is required');
      const taskId=url.searchParams.get('task_id');
      const cwd=taskId?this.hub.cwdOf(taskId):undefined;
      if(cwd && remoteLocation(cwd) && !/^(akb|lectern):/i.test(href))throw new HttpError(409,'원격 머신의 파일입니다. 해당 머신에서 이 경로를 열어 주세요');
      return linkTarget(href,cwd);
    }
    if (url.pathname === '/state') return {...this.hub.state(),client:{local:false}};
    if (url.pathname === '/skills') return peer&&!this.localAuthority?listPeerSkills(this.db,this.hub.skills,peer):this.hub.skills.list();
    if (peer && !this.localAuthority && url.pathname.startsWith('/skills/')) {
      const file=url.pathname.endsWith('/file');
      const name=decodeURIComponent(url.pathname.slice('/skills/'.length,file? -'/file'.length:undefined));
      const store=peerSkillStore(this.db,this.hub.skills,peer,name);
      return file
        ? store.readFile(name,url.searchParams.get('path')??'')
        : store.get(name);
    }
    if (url.pathname === '/channels' && !this.localAuthority) return [];
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
        if (req.method === 'GET' && url.pathname === '/v1/identity') {
          const migrated=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_import'").get()
            ? this.db.prepare("SELECT runner_id,address,fingerprint FROM remote_import WHERE activated_at IS NOT NULL LIMIT 1").get() as
              {runner_id:string;address:string;fingerprint:string}|undefined
            : undefined;
          const merges=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_merge'").get()
            ? this.db.prepare('SELECT old_runner_id,target_runner_id,fingerprint FROM remote_merge WHERE activated_at IS NOT NULL').all()
            : [];
          return json(res,200,{version:1,workspace_id:this.id,capabilities:{skill_snapshots:1,file_preview:1},...(migrated&&{migration:migrated}),merges});
        }
        if (req.headers['x-workspace-id'] !== this.id) return json(res,409,{code:'workspace_mismatch',error:'연결 대상 작업공간이 바뀌었습니다. 연결 설정을 확인하세요'});
        if (req.method === 'GET' && url.pathname === '/v1/skills/manifest')
          return json(res,200,{hashes:peerSkillManifest(this.db,this.hub.skills,peer)});
        if (req.method === 'POST' && url.pathname === '/v1/skills/sync') {
          const input=await readBody(req,8*1024*1024) as {bundle?:SkillBundle;names?:string[]};
          this.assertPeer(peer);
          if (input?.bundle) syncSkillVersion(this.db,this.hub.skills,peer,input.bundle);
          else if (input?.names) removeAbsentSkills(this.db,this.hub.skills,peer,input.names);
          else throw new HttpError(400,'동기화할 스킬 내용 또는 명단이 없습니다');
          return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && url.pathname === '/v1/skills/prepare') {
          const input=await readBody(req,8*1024*1024) as {op_id?:string;bundle?:SkillBundle};
          this.assertPeer(peer);
          if(!input?.op_id||!input.bundle)throw new HttpError(400,'스킬 준비 명령 ID와 내용이 필요합니다');
          applySkillBundle(this.db,this.hub.skills,peer,input.op_id,input.bundle);
          return json(res,200,{ok:true});
        }
        if (req.method === 'POST' && url.pathname.startsWith('/v1/broker/')) {
          const action=url.pathname.slice('/v1/broker/'.length);
          if(!/^[a-z-]+$/.test(action))throw new HttpError(404,'지원하지 않는 broker 요청입니다');
          const body=await readBody(req);
          const result=this.hub.atomic(()=>{this.assertPeer(peer);return handleWorkspaceBroker(this.hub,action,body as Record<string,unknown> ?? {});});
          return json(res,result.status,result.body);
        }
        if (url.pathname === '/v1/mcp') return await handleMcp(this.hub,req,res,()=>this.assertPeer(peer));
        if (this.localAuthority && req.method === 'POST' && url.pathname.startsWith('/v1/runner-exchange/')) {
          const runnerId=decodeURIComponent(url.pathname.slice('/v1/runner-exchange/'.length));
          if (!this.hub.remotes.accepts(runnerId,req.headers['x-runner-token'])) throw new HttpError(401,'이 러너의 연결 토큰이 필요합니다');
          const body=await readBody(req);
          return json(res,200,this.hub.atomic(()=>{this.assertPeer(peer);
            if(!this.hub.remotes.accepts(runnerId,req.headers['x-runner-token']))throw new HttpError(401,'이 러너의 연결 토큰이 필요합니다');
            return this.hub.remotes.exchange(runnerId,body as import('../../shared/remote.ts').RemoteExchange); }));
        }
        if (this.localAuthority && req.method === 'POST' && url.pathname.startsWith('/v1/channel-ingest/')) {
          const channelId=decodeURIComponent(url.pathname.slice('/v1/channel-ingest/'.length));
          if (!this.hub.channels.acceptsToken(channelId,req.headers['x-channel-token'] as string|undefined)) throw new HttpError(401,'이 채널의 입력 토큰이 필요합니다');
          const body=await readBody(req) as Record<string,unknown>;
          this.assertPeer(peer);
          if(!this.hub.channels.acceptsToken(channelId,req.headers['x-channel-token'] as string|undefined))throw new HttpError(401,'이 채널의 연결 토큰이 필요합니다');
          return json(res,200,this.hub.channels.ingest(channelId,body?.entries===undefined?body:body.entries));
        }
        if (this.localAuthority && req.method === 'POST' && url.pathname.startsWith('/v1/channel-refresh/')) {
          const channelId=decodeURIComponent(url.pathname.slice('/v1/channel-refresh/'.length));
          return json(res,200,await this.hub.channels.refresh(channelId));
        }
        if (req.method === 'GET' && url.pathname === '/v1/file') {
          this.files.set(res,peer);
          const ping=setInterval(()=>{
            try {this.authenticate(req.headers.authorization?.slice(7));}
            catch {res.destroy();}
          },5000);
          ping.unref();
          res.on('close',()=>{clearInterval(ping);this.files.delete(res);});
          return await sendWorkspaceFile(this.hub, url.searchParams.get('task_id') ?? '', url.searchParams.get('href') ?? '', res, url.searchParams.get('base') ?? undefined);
        }
        if (req.method === 'GET' && url.pathname === '/v1/read') return json(res,200,this.read(url.searchParams.get('path')!,peer));
        if (req.method === 'POST' && url.pathname === '/v1/operation') {
          const result = this.execute(peer,await readBody(req,8*1024*1024));
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
      } catch(e) { if (res.headersSent) res.destroy(); else json(res,e instanceof HttpError?e.status:500,{error:e instanceof HttpError?e.message:'공유 작업공간 처리에 실패했습니다'}); }
    });
    server.on('close',()=>{for(const res of this.streams.keys())res.end();for(const res of this.files.keys())res.destroy();});
    return server;
  }
}
