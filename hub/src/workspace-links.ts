import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { SharedWorkspaceView, WorkspaceOperation } from '../../shared/workspace.ts';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import { canonical, digest, json, operation } from './shared-workspace.ts';
import { readBody } from './body.ts';

type Link = { id:string; name:string; url:string; workspace_id:string; token:string };
type Delivery = { id:string; link_id:string; digest:string; payload:string; result:string|null; status:number|null };
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
  private flushing = new Map<string,Promise<void>>();
  private timer:NodeJS.Timeout;
  private stopped = false;
  private requests = new Map<AbortController,string>();
  constructor(store:Store) {
    this.db=store.database;
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_link(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,workspace_id TEXT NOT NULL UNIQUE,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_delivery(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,link_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,status INTEGER);
      CREATE TABLE IF NOT EXISTS workspace_view_index(seq INTEGER PRIMARY KEY AUTOINCREMENT,link_id TEXT NOT NULL UNIQUE);
      INSERT INTO workspace_view_index(link_id) SELECT id FROM workspace_link l WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index v WHERE v.link_id=l.id);
      CREATE INDEX IF NOT EXISTS workspace_delivery_pending ON workspace_delivery(link_id,status,seq);`);
    this.timer=setInterval(()=>{for(const link of this.rows())void this.flush(link.id);},1500);this.timer.unref();
  }
  async close() { this.stopped=true;clearInterval(this.timer);for(const c of this.requests.keys())c.abort();await Promise.all(this.flushing.values()); }
  private rows() {return this.db.prepare('SELECT * FROM workspace_link').all() as Link[];}
  private link(id:string) {const link=this.db.prepare('SELECT * FROM workspace_link WHERE id=?').get(id) as Link|undefined;if(!link)throw new HttpError(404,'공유 작업공간 연결이 없습니다');return link;}
  list():SharedWorkspaceView[] {return this.rows().map(({token,...link})=>({...link,view_index:Number((this.db.prepare('SELECT seq FROM workspace_view_index WHERE link_id=?').get(link.id) as {seq:number}).seq),pending:Number((this.db.prepare('SELECT count(*) n FROM workspace_delivery WHERE link_id=? AND status IS NULL').get(link.id) as {n:number}).n)}));}
  private async request(link:Link,path:string,init:RequestInit={},stream=false):Promise<{status:number;body:any}|{response:Response;release:()=>void}> {
    if(this.stopped)throw new Error('종료 중입니다');
    const controller=new AbortController();this.requests.set(controller,link.id);
    const timer=setTimeout(()=>controller.abort(),3000);
    try {
      const response=await fetch(new URL(path,link.url),{...init,redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${link.token}`,'x-workspace-id':link.workspace_id},signal:controller.signal});
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
    if(id&&this.link(id).workspace_id!==link.workspace_id)throw new HttpError(409,'기존 연결을 다른 작업공간으로 바꿀 수 없습니다');
    if(this.rows().some(l=>l.workspace_id===link.workspace_id&&l.id!==id))throw new HttpError(409,'이미 연결한 공유 작업공간입니다');
    this.db.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,token=excluded.token').run(link.id,link.name,link.url,link.workspace_id,link.token);
    this.db.prepare('INSERT INTO workspace_view_index(link_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index WHERE link_id=?)').run(link.id,link.id);
    return this.list().find(l=>l.id===link.id)!;
  }
  remove(id:string) {
    this.link(id);
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
  private result(id:string) {return this.db.prepare('SELECT * FROM workspace_delivery WHERE id=?').get(id) as Delivery|undefined;}
  enqueue(id:string,input:unknown) {
    this.link(id);const op=operation(input),hash=digest(canonical(op));const old=this.result(op.id);
    if(old&&(old.digest!==hash||old.link_id!==id))throw new HttpError(409,'같은 명령 ID의 내용 또는 대상이 바뀌었습니다');
    if(!old){
      const pending=this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))),0) bytes FROM workspace_delivery WHERE status IS NULL').get() as {n:number;bytes:number};
      if(pending.n>=1000||pending.bytes+Buffer.byteLength(JSON.stringify(op))>32*1024*1024)throw new HttpError(429,'미전달 입력 한도에 도달했습니다. 연결 복구 후 다시 보내세요');
      this.db.prepare('INSERT INTO workspace_delivery(id,link_id,digest,payload) VALUES(?,?,?,?)').run(op.id,id,hash,JSON.stringify(op));
    }
    return op.id;
  }
  flush(id:string):Promise<void> {
    const old=this.flushing.get(id);if(old)return old;
    const pending=(async()=>{
      for(const row of this.db.prepare('SELECT * FROM workspace_delivery WHERE link_id=? AND status IS NULL ORDER BY seq LIMIT 32').all(id) as Delivery[]){
        if(this.stopped)break;
        try {
          const r=await this.request(this.link(id),'/v1/operation',{method:'POST',body:row.payload});
          if(this.stopped)break;
          if(!('status' in r)||r.status>=500||r.status===401||r.status===403||(r.status===409&&r.body?.code==='workspace_mismatch'))break;
          const op=JSON.parse(row.payload) as WorkspaceOperation;
          // Drop prompts and secret answers once delivery is confirmed. Keep the receipt and digest.
          this.db.prepare('UPDATE workspace_delivery SET status=?,result=?,payload=? WHERE id=?').run(r.status,JSON.stringify(r.body),r.status<400?JSON.stringify({id:op.id,method:op.method,path:op.path}):row.payload,row.id);
        }catch{break;}
      }
    })().finally(()=>this.flushing.delete(id));
    this.flushing.set(id,pending);return pending;
  }
  async proxy(id:string,path:string,req:IncomingMessage,res:ServerResponse) {
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
      if(r.response.body){const stream=Readable.fromWeb(r.response.body as never);stream.on('error',()=>res.destroy());stream.pipe(res);}
      else {release();res.end();}return;
    }
    if(req.method==='GET'||req.method==='HEAD') {
      const r=await this.request(link,`/v1/read?path=${encodeURIComponent(path)}`);
      if('status' in r)return json(res,r.status,r.body);return;
    }
    const requestId=req.headers['x-desk-operation-id'];
    const op={id:typeof requestId==='string'?requestId:randomUUID(),method:req.method!,path,body:(await readBody(req))??{}};
    this.enqueue(id,op);await this.flush(id);
    const held=this.result(op.id)!;
    if(held.status!==null)return json(res,held.status,JSON.parse(held.result!));
    return json(res,202,{shared_pending:true,operation_id:op.id});
  }
}
