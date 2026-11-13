import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { SharedWorkspaceView, WorkspaceOperation } from '../../shared/workspace.ts';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import { canonical, digest, json, operation } from './shared-workspace.ts';
import { readBody } from './body.ts';
import { TemporaryFiles } from './shared-files.ts';
import type { LinkTarget } from './open.ts';
import { resolve } from 'node:path';
import { closeRequestBroker } from './request-broker.ts';
import type { SkillStore } from './skills.ts';
import { collectSkillBundle, collectSkillVersion, EMPTY_SKILL_BUNDLE, type SkillBundle } from './shared-skill-sync.ts';
import { RESERVED_TAGS } from '../../shared/compose.ts';

type Link = { id:string; name:string; url:string; workspace_id:string; token:string };
type Delivery = { id:string; link_id:string; digest:string; payload:string; prepared_payload:string|null; result:string|null; status:number|null };
type Legacy = {runner_id:string;link_id:string;address:string;fingerprint:string;legacy_json:string};
function address(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(400,'공유 러너 주소가 필요합니다');
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400,'올바른 공유 러너 URL을 입력하세요'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new HttpError(400,'경로 없는 HTTPS 주소 또는 localhost SSH 터널 주소를 입력하세요');
  return url.href;
}

/** Each hub keeps its own durable submission queue; only the runner decides task state. */
export class WorkspaceLinks {
  private db:DatabaseSync;
  private skills?:SkillStore;
  get database() {return this.db;}
  private flushing = new Map<string,Promise<void>>();
  private syncing = new Map<string,Promise<void>>();
  private lastSync = new Map<string,number>();
  private sourceCache?:{at:number;versions:Map<string,SkillBundle>};
  private skillCapability = new Map<string,boolean>();
  private timer:NodeJS.Timeout;
  private stopped = false;
  private requests = new Map<AbortController,string>();
  private files = new TemporaryFiles();
  constructor(store:Store,skills?:SkillStore) {
    this.db=store.database;
    this.skills=skills;
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_link(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,workspace_id TEXT NOT NULL UNIQUE,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_delivery(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,link_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,prepared_payload TEXT,result TEXT,status INTEGER);
      CREATE TABLE IF NOT EXISTS workspace_view_index(seq INTEGER PRIMARY KEY AUTOINCREMENT,link_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS remote_legacy(runner_id TEXT PRIMARY KEY,link_id TEXT NOT NULL,address TEXT NOT NULL,fingerprint TEXT NOT NULL,legacy_json TEXT NOT NULL);
      INSERT INTO workspace_view_index(link_id) SELECT id FROM workspace_link l WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index v WHERE v.link_id=l.id);
      CREATE TABLE IF NOT EXISTS workspace_delivery_attempt (id TEXT PRIMARY KEY, accepted_at TEXT, attempted_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, failure TEXT, failed_at TEXT, completed_at TEXT);
      CREATE INDEX IF NOT EXISTS workspace_delivery_pending ON workspace_delivery(link_id,status,seq);`);
    if(!(this.db.prepare('PRAGMA table_info(remote_legacy)').all() as {name:string}[]).some(c=>c.name==='link_id'))
      this.db.exec('ALTER TABLE remote_legacy ADD COLUMN link_id TEXT; UPDATE remote_legacy SET link_id=runner_id WHERE link_id IS NULL');
    if(!(this.db.prepare('PRAGMA table_info(workspace_delivery)').all() as {name:string}[]).some(c=>c.name==='prepared_payload'))
      this.db.exec('ALTER TABLE workspace_delivery ADD COLUMN prepared_payload TEXT');
    this.timer=setInterval(()=>{for(const link of this.rows()){
      void this.flush(link.id);
      if(Date.now()-(this.lastSync.get(link.id)??0)>15_000)void this.syncSkills(link.id);
    }},1500);this.timer.unref();
  }
  async close() { this.stopped=true;clearInterval(this.timer);await closeRequestBroker(this);for(const c of this.requests.keys())c.abort();await Promise.all([...this.flushing.values(),...this.syncing.values()]);await this.files.close(); }
  private rows() {return this.db.prepare('SELECT * FROM workspace_link').all() as Link[];}
  private link(id:string) {const link=this.db.prepare('SELECT * FROM workspace_link WHERE id=?').get(id) as Link|undefined;if(!link)throw new HttpError(404,'공유 작업공간 연결이 없습니다');return link;}
  private legacy(id:string) {return this.db.prepare('SELECT * FROM remote_legacy WHERE link_id=?').all(id) as Legacy[];}
  legacyOwner(kind:'project'|'task'|'approval'|'question',id:string):string|undefined {
    const field=`legacy_${kind}_ids`;
    for(const row of this.db.prepare('SELECT link_id,legacy_json FROM remote_legacy').all() as {link_id:string;legacy_json:string}[])
      if(((JSON.parse(row.legacy_json) as Record<string,string[]>)[field]??[]).includes(id))return row.link_id;
    return undefined;
  }
  remoteOwner(address:string):string|undefined {
    const rows=this.db.prepare('SELECT link_id,address FROM remote_legacy').all() as {link_id:string;address:string}[];
    const exact=rows.find(row=>row.address===address);
    if(exact)return exact.link_id;
    if(!address.includes('@')){
      const candidates=rows.filter(row=>row.address.split('@').at(-1)===address);
      if(candidates.length>1)throw new HttpError(409,'이 호스트에는 이관한 원격 실행 계정이 여러 개입니다');
      return candidates[0]?.link_id;
    }
    return undefined;
  }
  projectOwner(name:string):string|undefined {
    const owners=(this.db.prepare('SELECT link_id,legacy_json FROM remote_legacy').all() as {link_id:string;legacy_json:string}[])
      .filter(row=>Object.values((JSON.parse(row.legacy_json) as {legacy_project_names?:Record<string,string>}).legacy_project_names??{})
        .some(value=>value.toLowerCase()===name.toLowerCase())).map(row=>row.link_id);
    if(owners.length>1)throw new HttpError(409,'같은 이름의 프로젝트가 여러 원격 작업공간에 있습니다');
    return owners[0];
  }
  list():SharedWorkspaceView[] {return this.rows().map(({token,...link})=>({...link,
    route_addresses:this.legacy(link.id).map(row=>row.address),
    ...this.legacy(link.id).reduce((all,row)=>{
      const part=JSON.parse(row.legacy_json) as Record<string,unknown>;
      for(const key of ['legacy_project_ids','legacy_task_ids','legacy_approval_ids','legacy_question_ids','legacy_runner_ids'])
        (all as Record<string,unknown>)[key]=[...((all as Record<string,string[]>)[key]??[]),...((part[key] as string[]|undefined)??[])];
      all.legacy_project_names={...(all.legacy_project_names as Record<string,string>|undefined),...(part.legacy_project_names as Record<string,string>|undefined)};
      return all;
    },{} as Record<string,unknown>),
    view_index:Number((this.db.prepare('SELECT seq FROM workspace_view_index WHERE link_id=?').get(link.id) as {seq:number}).seq),
    pending:Number((this.db.prepare('SELECT count(*) n FROM workspace_delivery WHERE link_id=? AND status IS NULL').get(link.id) as {n:number}).n)}));}
  private async request(link:Link,path:string,init:RequestInit={},stream=false,timeoutMs=3000):Promise<{status:number;body:any}|{response:Response;release:()=>void}> {
    if(this.stopped)throw new Error('종료 중입니다');
    const controller=new AbortController();this.requests.set(controller,link.id);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetch(new URL(path,link.url),{...init,redirect:'error',headers:{'content-type':'application/json',...init.headers,authorization:`Bearer ${link.token}`,'x-workspace-id':link.workspace_id},signal:init.signal ? AbortSignal.any([controller.signal,init.signal]) : controller.signal});
      if(stream){clearTimeout(timer);return {response,release:()=>{controller.abort();this.requests.delete(controller);}};}
      const body=await response.json();
      return {status:response.status,body};
    } catch(e) { controller.abort();this.requests.delete(controller);throw e; }
    finally {clearTimeout(timer);if(!stream)this.requests.delete(controller);}
  }
  async attach(input:{name?:unknown;url?:unknown;token?:unknown},id?:string) {
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(input.token))throw new HttpError(400,'이름과 공유 허브 연결 토큰을 입력하세요');
    const link:Link={id:id??randomUUID(),name:input.name.trim(),url:address(input.url),token:input.token,workspace_id:''};
    const reply=await this.request(link,'/v1/identity');
    if(!('status' in reply)||reply.status!==200||reply.body.version!==1||typeof reply.body.workspace_id!=='string')throw new HttpError(409,'공유 러너 연결을 확인하지 못했습니다');
    link.workspace_id=reply.body.workspace_id;
    this.skillCapability.set(link.id,reply.body.capabilities?.skill_snapshots===1);
    const legacy=this.legacy(link.id);
    if(legacy.some(row=>!(reply.body.migration?.runner_id===row.runner_id&&reply.body.migration?.address===row.address
      &&reply.body.migration?.fingerprint===row.fingerprint)
      &&!reply.body.merges?.some((m:{old_runner_id:string;fingerprint:string})=>m.old_runner_id===row.runner_id&&m.fingerprint===row.fingerprint)))
      throw new HttpError(409,'이관한 원격 작업공간의 신원이 일치하지 않습니다');
    if(id&&this.db.prepare('SELECT 1 FROM workspace_link WHERE id=?').get(id)&&this.link(id).workspace_id!==link.workspace_id)throw new HttpError(409,'기존 연결을 다른 작업공간으로 바꿀 수 없습니다');
    if(this.rows().some(l=>l.workspace_id===link.workspace_id&&l.id!==id))throw new HttpError(409,'이미 연결한 공유 작업공간입니다');
    this.db.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,token=excluded.token').run(link.id,link.name,link.url,link.workspace_id,link.token);
    this.db.prepare('INSERT INTO workspace_view_index(link_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index WHERE link_id=?)').run(link.id,link.id);
    this.sourceCache=undefined;void this.syncSkills(link.id);
    return this.list().find(l=>l.id===link.id)!;
  }
  /** Install link and legacy-ID ownership together, after source commit and target activation. */
  async installMigrated(sourcePath:string,runnerId:string,input:{url:string;token:string}) {
    if(!/^remote-[a-zA-Z0-9-]+$/.test(runnerId)||!/^[A-Za-z0-9_-]{32,256}$/.test(input.token))
      throw new HttpError(400,'이관 러너 ID 또는 연결 토큰 형식이 잘못되었습니다');
    const source=new DatabaseSync(resolve(sourcePath),{readOnly:true});
    let marker:Legacy|undefined;
    try{marker=source.prepare('SELECT runner_id,address,fingerprint,legacy_json FROM remote_migration WHERE runner_id=?').get(runnerId) as Legacy|undefined;}
    finally{source.close();}
    if(!marker)throw new Error('원본 DB에서 완료된 원격 이관 기록을 찾지 못했습니다');
    const link:Link={id:runnerId,name:marker.address,url:address(input.url),token:input.token,workspace_id:''};
    const reply=await this.request(link,'/v1/identity');
    if(!('status' in reply)||reply.status!==200||reply.body.version!==1||typeof reply.body.workspace_id!=='string'
      ||reply.body.migration?.runner_id!==marker.runner_id||reply.body.migration?.address!==marker.address
      ||reply.body.migration?.fingerprint!==marker.fingerprint)throw new Error('활성 원격 작업공간이 원본 이관 기록과 일치하지 않습니다');
    link.workspace_id=reply.body.workspace_id;
    this.skillCapability.set(link.id,reply.body.capabilities?.skill_snapshots===1);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.db.prepare('SELECT * FROM remote_legacy WHERE runner_id=?').get(runnerId) as Legacy|undefined;
      const prior=this.db.prepare('SELECT workspace_id FROM workspace_link WHERE id=?').get(runnerId) as {workspace_id:string}|undefined;
      if(old&&(old.fingerprint!==marker.fingerprint||old.address!==marker.address||old.legacy_json!==marker.legacy_json))
        throw new Error('게이트웨이에 다른 원격 이관 기록이 있습니다');
      if(prior&&prior.workspace_id!==link.workspace_id)throw new Error('기존 러너 연결의 작업공간 ID가 달라졌습니다');
      const duplicate=this.db.prepare('SELECT id FROM workspace_link WHERE workspace_id=? AND id<>?').get(link.workspace_id,runnerId);
      if(duplicate)throw new Error('작업공간 ID가 다른 연결에서 이미 사용 중입니다');
      this.db.prepare('INSERT OR IGNORE INTO remote_legacy VALUES (?,?,?,?,?)').run(marker.runner_id,runnerId,marker.address,marker.fingerprint,marker.legacy_json);
      this.db.prepare('INSERT INTO workspace_link VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,token=excluded.token')
        .run(link.id,link.name,link.url,link.workspace_id,link.token);
      this.db.prepare('INSERT INTO workspace_view_index(link_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index WHERE link_id=?)').run(link.id,link.id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.sourceCache=undefined;void this.syncSkills(link.id);
    return this.list().find(view=>view.id===runnerId)!;
  }
  /** Attach an empty legacy project to an existing shared source without changing its identity. */
  async installMerged(sourcePath:string,oldRunnerId:string,linkId:string) {
    const link=this.link(linkId);
    const source=new DatabaseSync(resolve(sourcePath),{readOnly:true});
    let marker:Omit<Legacy,'link_id'>|undefined;
    try{marker=source.prepare('SELECT runner_id,address,fingerprint,legacy_json FROM remote_migration WHERE runner_id=?').get(oldRunnerId) as Omit<Legacy,'link_id'>|undefined;}
    finally{source.close();}
    if(!marker)throw new Error('원본 DB에서 완료된 기존 원격 이관 기록을 찾지 못했습니다');
    const reply=await this.request(link,'/v1/identity');
    if(!('status' in reply)||reply.status!==200||reply.body.workspace_id!==link.workspace_id
      ||!Array.isArray(reply.body.merges)||!reply.body.merges.some((m:{old_runner_id:string;fingerprint:string})=>
        m.old_runner_id===oldRunnerId&&m.fingerprint===marker!.fingerprint))
      throw new Error('기존 공유 연결의 작업공간 ID 또는 통합 기록이 원본과 다릅니다');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.db.prepare('SELECT * FROM remote_legacy WHERE runner_id=?').get(oldRunnerId) as Legacy|undefined;
      if(old&&(old.link_id!==linkId||old.address!==marker.address||old.fingerprint!==marker.fingerprint||old.legacy_json!==marker.legacy_json))
        throw new Error('게이트웨이에 다른 기존 원격 통합 기록이 있습니다');
      if(!old)this.db.prepare('INSERT INTO remote_legacy VALUES (?,?,?,?,?)')
        .run(oldRunnerId,linkId,marker.address,marker.fingerprint,marker.legacy_json);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.list().find(view=>view.id===linkId)!;
  }
  /** The gateway's default source retains its identity while it is temporarily offline. */
  async configureLocal(url:string,token:string) {
    const id='local-authority';
    const old=this.db.prepare('SELECT 1 FROM workspace_link WHERE id=?').get(id);
    if(old){
      if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new HttpError(400,'로컬 작업공간 토큰 형식이 잘못되었습니다');
      this.db.prepare('UPDATE workspace_link SET url=?,token=? WHERE id=?').run(address(url),token,id);
      this.sourceCache=undefined;void this.syncSkills(id);
    }else await this.attach({name:'local',url,token},id);
    return id;
  }
  async fetchFile(id: string, taskId: string, href: string, signal?: AbortSignal) {
    let reply: Awaited<ReturnType<WorkspaceLinks['request']>>;
    try { reply = await this.request(this.link(id), '/v1/file?' + new URLSearchParams({task_id: taskId, href}), {signal}, true); }
    catch (error) {
      if (signal?.aborted) throw new HttpError(499, '파일 전송이 취소되었습니다');
      throw new HttpError(504, '공유 러너의 파일 응답 시간이 초과되었거나 연결할 수 없습니다');
    }
    if (!('response' in reply)) throw new HttpError(502, '파일 응답을 받지 못했습니다');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reply.release(); }, 60_000);
    try {
      if (!reply.response.ok) {
        // Do not buffer untrusted error bodies; old runners return 404 for this endpoint.
        throw new HttpError(reply.response.status, reply.response.status === 404
          ? '파일이나 작업이 없거나 공유 러너 업데이트가 필요합니다'
          : `공유 러너에서 파일을 가져오지 못했습니다 (HTTP ${reply.response.status})`);
      }
      try { return await this.files.receive(reply.response); }
      catch (error) {
        if (timedOut) throw new HttpError(504, '파일 전송 시간이 초과되었습니다');
        if (signal?.aborted) throw new HttpError(499, '파일 전송이 취소되었습니다');
        throw error;
      }
    } finally { clearTimeout(timer); reply.release(); }
  }
  async discardFile(target: LinkTarget) {
    if(target.kind==='file')await this.files.discard(target.path);
  }
  remove(id:string) {
    this.link(id);
    if(this.legacy(id).length)throw new HttpError(409,'이관한 원격 원본 연결은 제거할 수 없습니다');
    if(this.flushing.has(id)||this.list().find(l=>l.id===id)!.pending)throw new HttpError(409,'전달 중이거나 미전달 입력이 있어 연결을 제거할 수 없습니다');
    this.db.prepare('DELETE FROM workspace_delivery WHERE link_id=?').run(id);
    this.db.prepare('DELETE FROM workspace_link WHERE id=?').run(id);
    for(const [controller,link] of this.requests)if(link===id)controller.abort();
  }
  deliveries(id:string) {
    this.link(id);
    return (this.db.prepare('SELECT id,payload,status,result FROM workspace_delivery WHERE link_id=? AND (status IS NULL OR status>=400) ORDER BY seq DESC LIMIT 100').all(id) as {id:string;payload:string;status:number|null;result:string|null}[])
      .map(r=>{const op=JSON.parse(r.payload);return {id:r.id,status:r.status,method:op.method,path:op.path,
        text:r.status!==null&&r.status>=400&&typeof op.body?.text==='string'?op.body.text:undefined,
        error:r.result?JSON.parse(r.result).error:undefined};});
  }
  async read(id:string,path:string) {
    const reply=await this.request(this.link(id),`/v1/read?path=${encodeURIComponent(path)}`);
    if(!('status' in reply))throw new Error('작업공간 응답 형식이 잘못되었습니다');
    return reply;
  }
  async trustedCall(id:string,path:string,body:unknown,headers:Record<string,string>={}) {
    const reply=await this.request(this.link(id),path,{method:'POST',body:JSON.stringify(body),headers},false,
      path.startsWith('/v1/channel-refresh/')?30_000:10_000);
    if(!('status' in reply))throw new Error('작업공간 응답 형식이 잘못되었습니다');
    return reply;
  }
  async proxyMcp(id:string,req:IncomingMessage,res:ServerResponse,suppliedBody?:unknown) {
    const link=this.link(id);
    const body=suppliedBody??await readBody(req);
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    try {
      const response=await fetch(new URL('/v1/mcp',link.url),{method:req.method,redirect:'error',
        headers:{'content-type':'application/json',authorization:`Bearer ${link.token}`,'x-workspace-id':link.workspace_id},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(610_000)])});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});
      res.end(await response.text());
    } finally { controller.abort(); }
  }
  private result(id:string) {return this.db.prepare('SELECT * FROM workspace_delivery WHERE id=?').get(id) as Delivery|undefined;}
  private needsSkillSnapshot(text:string) {
    return [...text.matchAll(/(?:^|[^\w#])#([a-z0-9][a-z0-9-]{0,63})(?![\w-])/gim)]
      .some(match=>!RESERVED_TAGS.includes(match[1].toLowerCase()));
  }
  private async supportsSkillSnapshots(id:string) {
    if(this.skillCapability.get(id))return true;
    try {
      const reply=await this.request(this.link(id),'/v1/skills/manifest');
      if('status' in reply&&reply.status===200&&reply.body?.hashes&&typeof reply.body.hashes==='object'){
        this.skillCapability.set(id,true);return true;
      }
      if('status' in reply&&reply.status===404){this.skillCapability.set(id,false);return false;}
    } catch { /* The caller retries after the connection returns. */ }
    return null;
  }
  private sourceVersions() {
    if(this.sourceCache&&Date.now()-this.sourceCache.at<15_000)return this.sourceCache.versions;
    const versions=new Map<string,SkillBundle>();
    for(const name of this.skills?.names()??[])versions.set(name,collectSkillVersion(this.skills!,name));
    this.sourceCache={at:Date.now(),versions};
    return versions;
  }
  skillChanged() {
    this.sourceCache=undefined;
    for(const link of this.rows())if(link.id!=='local-authority')void this.syncSkills(link.id,true);
  }
  /** Compare content hashes on connect and periodically, including direct filesystem edits. */
  syncSkills(id:string,refreshSource=false):Promise<void> {
    if(!this.skills||this.stopped||id==='local-authority')return Promise.resolve();
    if(refreshSource)this.sourceCache=undefined;
    const old=this.syncing.get(id);if(old)return refreshSource?old.then(()=>this.syncSkills(id,true)):old;
    this.lastSync.set(id,Date.now());
    const work=(async()=>{
      const link=this.link(id);
      const reply=await this.request(link,'/v1/skills/manifest');
      if(!('status' in reply)||reply.status!==200||!reply.body?.hashes||typeof reply.body.hashes!=='object')return;
      const versions=this.sourceVersions(),names=[...versions.keys()];
      if(names.length>1000)return;
      const remote=reply.body.hashes as Record<string,string>;
      for(const name of names){
        if(this.stopped)break;
        const bundle=versions.get(name)!;
        if(remote[name]===bundle.hashes[name])continue;
        const sent=await this.request(link,'/v1/skills/sync',{method:'POST',body:JSON.stringify({bundle})},false,10_000);
        if(!('status' in sent)||sent.status!==200)break;
      }
      if(!this.stopped && Object.keys(remote).some(name=>!names.includes(name)))
        await this.request(link,'/v1/skills/sync',{method:'POST',body:JSON.stringify({names})},false,10_000);
    })().catch(()=>{/* A disconnected link retries without blocking operations. */})
      .finally(()=>this.syncing.delete(id));
    this.syncing.set(id,work);return work;
  }
  enqueue(id:string,input:unknown) {
    this.link(id);const op=operation(input),hash=digest(canonical(op));const old=this.result(op.id);
    if('__desk_skill_ref' in op.body||'__desk_skill_bundle' in op.body)
      throw new HttpError(400,'스킬 준비 필드는 작업공간 연결에서만 설정합니다');
    if(old&&(old.digest!==hash||old.link_id!==id))throw new HttpError(409,'같은 명령 ID의 내용 또는 대상이 바뀌었습니다');
    if(!old){
      const text=typeof op.body.text==='string'?op.body.text:typeof op.body.prompt==='string'?op.body.prompt:undefined;
      const bundle=text&&this.skills&&this.needsSkillSnapshot(text)
        ? collectSkillBundle(this.skills,text)??EMPTY_SKILL_BUNDLE:null;
      const prepared=bundle?JSON.stringify(bundle):'';
      const pending=this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))+coalesce(length(CAST(prepared_payload AS BLOB)),0)),0) bytes FROM workspace_delivery WHERE status IS NULL').get() as {n:number;bytes:number};
      if(pending.n>=1000||pending.bytes+Buffer.byteLength(JSON.stringify(op))+Buffer.byteLength(prepared)>32*1024*1024)
        throw new HttpError(429,'미전달 입력 한도에 도달했습니다. 연결 복구 후 다시 보내세요');
      this.db.prepare('INSERT INTO workspace_delivery(id,link_id,digest,payload,prepared_payload) VALUES(?,?,?,?,?)')
        .run(op.id,id,hash,JSON.stringify(op),prepared);
    }
    this.db.prepare('INSERT OR IGNORE INTO workspace_delivery_attempt(id,accepted_at) VALUES(?,?)').run(op.id,new Date().toISOString());
    return op.id;
  }
  flush(id:string):Promise<void> {
    const old=this.flushing.get(id);if(old)return old;
    const pending=(async()=>{
      // Pick the next row after each response, including commands accepted during this flush.
      while (!this.stopped) {
        const row=this.db.prepare('SELECT * FROM workspace_delivery WHERE link_id=? AND status IS NULL ORDER BY seq LIMIT 1').get(id) as Delivery|undefined;
        if(!row)break;
        this.db.prepare('INSERT OR IGNORE INTO workspace_delivery_attempt(id) VALUES(?)').run(row.id);
        const failure=(value:string)=>this.db.prepare('UPDATE workspace_delivery_attempt SET failure=?,failed_at=? WHERE id=?').run(value,new Date().toISOString(),row.id);
        this.db.prepare('UPDATE workspace_delivery_attempt SET attempted_at=?,attempts=attempts+1 WHERE id=?').run(new Date().toISOString(),row.id);
        if(this.stopped)break;
        try {
          const op=JSON.parse(row.payload) as WorkspaceOperation;
          const text=typeof op.body.text==='string'?op.body.text:typeof op.body.prompt==='string'?op.body.prompt:undefined;
          if(this.skills&&text&&this.needsSkillSnapshot(text)&&!row.prepared_payload){
            this.db.prepare('UPDATE workspace_delivery SET status=409,result=?,prepared_payload=NULL WHERE id=?')
              .run(JSON.stringify({error:'업데이트 전에 접수한 입력의 스킬 버전을 확인할 수 없습니다. 내용을 확인하고 다시 보내세요'}),row.id);
            continue;
          }
          const saved=row.prepared_payload?JSON.parse(row.prepared_payload):null;
          const bundle=saved?.version===1?saved as SkillBundle:saved?.body?.__desk_skill_bundle as SkillBundle|undefined;
          if(bundle){
            const supported=await this.supportsSkillSnapshots(id);
            if(supported===null){failure('skill_manifest_unavailable');break;}
            if(!supported){
              this.db.prepare('UPDATE workspace_delivery SET status=409,result=?,prepared_payload=NULL WHERE id=?')
                .run(JSON.stringify({error:'공유 러너가 스킬 스냅샷을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내세요'}),row.id);
              continue;
            }
          }
          const ref=bundle?{version:bundle.version,selected:bundle.selected,hashes:bundle.hashes,digest:bundle.digest}:null;
          const requestBody=ref?JSON.stringify({...op,body:{...op.body,__desk_skill_ref:ref}}):row.payload;
          let r=await this.request(this.link(id),'/v1/operation',{method:'POST',body:requestBody});
          if(bundle&&'status' in r&&r.status===409&&r.body?.code==='skill_missing'){
            const prepared=await this.request(this.link(id),'/v1/skills/prepare',
              {method:'POST',body:JSON.stringify({op_id:op.id,bundle})},false,10_000);
            if(!('status' in prepared)||prepared.status>=500){failure('skill_prepare_unavailable');break;}
            if(prepared.status!==200)r=prepared;
            else r=await this.request(this.link(id),'/v1/operation',{method:'POST',body:requestBody});
          }
          if(this.stopped)break;
          if(!('status' in r)||r.status>=500||r.status===401||r.status===403||(r.status===409&&r.body?.code==='workspace_mismatch')){failure('status' in r?`http_${r.status}`:'invalid_response');break;}
          this.db.prepare('UPDATE workspace_delivery_attempt SET completed_at=? WHERE id=?').run(new Date().toISOString(),row.id);
          // Drop prompts and secret answers once delivery is confirmed. Keep the receipt and digest.
          this.db.prepare('UPDATE workspace_delivery SET status=?,result=?,payload=?,prepared_payload=NULL WHERE id=?')
            .run(r.status,JSON.stringify(r.body),r.status<400?JSON.stringify({id:op.id,method:op.method,path:op.path}):row.payload,row.id);
        }catch(error){failure(error instanceof Error ? error.name : 'request_failed');break;}
      }
    })().finally(()=>this.flushing.delete(id));
    this.flushing.set(id,pending);return pending;
  }
  async proxy(id:string,path:string,req:IncomingMessage,res:ServerResponse,onStreamOpen?:()=>void,suppliedBody?:unknown) {
    const link=this.link(id);
    if(req.method==='GET'&&path==='/deliveries')return json(res,200,this.deliveries(id));
    if(req.method==='GET'&&path.startsWith('/delivery/')) {
      const held=this.result(path.slice('/delivery/'.length));
      if(!held||held.link_id!==id)throw new HttpError(404,'전달 기록이 없습니다');
      return json(res,200,{id:held.id,status:held.status,result:held.result?JSON.parse(held.result):null});
    }
    if(req.method==='GET'&&path==='/stream') {
      let release:(()=>void)|undefined;
      res.on('close',()=>release?.());
      const r=await this.request(link,'/v1/stream',{},true);
      if(!('response' in r))throw new Error('invalid stream');
      release=r.release;
      if(res.destroyed){release();return;}
      if(!r.response.ok){release();throw new HttpError(r.response.status,'공유 러너 스트림에 연결하지 못했습니다');}
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      onStreamOpen?.();
      if(r.response.body){const stream=Readable.fromWeb(r.response.body as never);stream.on('error',()=>res.destroy());stream.pipe(res);}
      else {release();res.end();}return;
    }
    if(req.method==='GET'||req.method==='HEAD') {
      const r=await this.request(link,`/v1/read?path=${encodeURIComponent(path)}`);
      if('status' in r)return json(res,r.status,r.body);return;
    }
    const requestId=req.headers['x-desk-operation-id'];
    const op={id:typeof requestId==='string'?requestId:randomUUID(),method:req.method!,path,body:(suppliedBody??await readBody(req))??{}};
    this.enqueue(id,op);
    let timer:NodeJS.Timeout|undefined;
    try { await Promise.race([this.flush(id),new Promise<void>(resolve=>{timer=setTimeout(resolve,3500);})]); }
    finally {if(timer)clearTimeout(timer);}
    const held=this.result(op.id)!;
    if(id==='local-authority'&&path.startsWith('/skills')&&held.status!==null&&held.status<400)
      this.skillChanged();
    if(held.status!==null)return json(res,held.status,JSON.parse(held.result!));
    return json(res,202,{shared_pending:true,operation_id:op.id});
  }
}
