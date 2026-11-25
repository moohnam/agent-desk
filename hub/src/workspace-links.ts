import { signRequest, toolFields } from './request-proof.ts';
import { MAX_PROMPT_TEMPLATES_BODY } from './prompt-templates.ts';
import { enrollmentCall, requestEnrollment, sshLogin } from './ssh-client.ts';
import { agentPublicKeys, validatePublicKey } from './ssh-signature.ts';
import { readSse } from './sse-reader.ts';
import type { EngineUsage, HubMessage } from '../../shared/api.ts';
import { isNoteInput, needsDefaultInstructions, NOTE_CUT_ROUTE, workspaceRoute } from './workspace-api.ts';
import { checkUsageReading, checkUsageTargets, type UsageReading, type UsageTarget } from '../../shared/runner-usage.ts';
import type { UsageQuery } from './runner/usage-probe.ts';
import { DEFAULT_INSTRUCTIONS } from './instruction-store.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { SharedWorkspaceView, WorkspaceOperation, SshConnectRequest, WorkspaceConnectRequest, OutgoingConnectRequest } from '../../shared/workspace.ts';
import type { Store } from './db.ts';
import { HttpError } from './errors.ts';
import { canonical, digest, json, operation, connectorUserInput } from './shared-workspace.ts';
import { executeConnectorJob, type ConnectorAuthority, type ConnectorPolicy } from './connector-authority.ts';
import { connectorInputScopes, type ConnectorScope } from '../../shared/connector-tags.ts';
import type { ConnectorJob } from './connector-broker.ts';
import { readBody } from './body.ts';
import { DocumentPermissionError, TemporaryFiles } from './shared-files.ts';
import type { LinkTarget } from './open.ts';
import { isAbsolute, resolve } from 'node:path';
import { closeRequestBroker } from './request-broker.ts';
import type { SkillStore } from './skills.ts';
import { collectSkillBundle, collectSkillVersion, EMPTY_SKILL_BUNDLE, type SkillBundle } from './shared-skill-sync.ts';
import { parseComposeTarget, RESERVED_TAGS } from '../../shared/compose.ts';
import { hasScheduledReply, scheduledReplyHint, scheduledReplyInstant } from '../../shared/scheduled-reply.ts';

type Link = { id:string; name:string; url:string; workspace_id:string; token:string; publicKey?:string };
const usageAccessDenied = (reply?: { status: number; body: any }) => reply?.status === 401 || reply?.status === 403
  || (reply?.status === 409 && reply.body?.code === 'workspace_mismatch');
type Delivery = { id:string; link_id:string; digest:string; payload:string; prepared_payload:string|null; result:string|null; status:number|null };
type Outgoing = OutgoingConnectRequest & {
  link_id: string; link_binding: string; remote_id: string; workspace_id: string; url: string; key: string;
};
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
  instructions?: () => string;
  connectorAuthority?: ConnectorAuthority;
  private db:DatabaseSync;
  private sshSessions=new Map<string,{key:string;token:string;expires:number}>();
  private sshLogins=new Map<string,Promise<{token:string;expires:number}>>();
  private skills?:SkillStore;
  get database() {return this.db;}
  private flushing = new Map<string,Promise<void>>();
  private syncing = new Map<string,Promise<void>>();
  private connectorPolling = new Map<string,Promise<void>>();
  private lastSync = new Map<string,number>();
  private sourceCache?:{at:number;versions:Map<string,SkillBundle>};
  private readonly startingEnrollment = new Set<string>();
  private enrollmentPoll?: Promise<void>;
  private enrollmentNext = 0;
  private timer:NodeJS.Timeout;
  private stopped = false;
  private requests = new Map<AbortController,string>();
  private usageCache = new Map<string, { targets?: UsageTarget[]; values: Map<string, EngineUsage> }>();
  private files = new TemporaryFiles();
  constructor(store:Store,skills?:SkillStore) {
    this.db=store.database;
    this.skills=skills;
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_link(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,workspace_id TEXT NOT NULL UNIQUE,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_ssh_outgoing(id TEXT PRIMARY KEY,link_id TEXT NOT NULL,link_binding TEXT NOT NULL,url TEXT NOT NULL,
        workspace_id TEXT NOT NULL,name TEXT NOT NULL,key TEXT NOT NULL,remote_id TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_ssh_link(link_id TEXT PRIMARY KEY,public_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_delivery(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,link_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,prepared_payload TEXT,result TEXT,status INTEGER);
      CREATE TABLE IF NOT EXISTS workspace_view_index(seq INTEGER PRIMARY KEY AUTOINCREMENT,link_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS remote_legacy(runner_id TEXT PRIMARY KEY,link_id TEXT NOT NULL,address TEXT NOT NULL,fingerprint TEXT NOT NULL,legacy_json TEXT NOT NULL);
      INSERT INTO workspace_view_index(link_id) SELECT id FROM workspace_link l WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index v WHERE v.link_id=l.id);
      CREATE TABLE IF NOT EXISTS workspace_delivery_attempt (id TEXT PRIMARY KEY, accepted_at TEXT, attempted_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, failure TEXT, failed_at TEXT, completed_at TEXT, unsent_attempts INTEGER);
      CREATE INDEX IF NOT EXISTS workspace_delivery_pending ON workspace_delivery(link_id,status,seq);`);
    if(!(this.db.prepare('PRAGMA table_info(remote_legacy)').all() as {name:string}[]).some(c=>c.name==='link_id'))
      this.db.exec('ALTER TABLE remote_legacy ADD COLUMN link_id TEXT; UPDATE remote_legacy SET link_id=runner_id WHERE link_id IS NULL');
    if(!(this.db.prepare('PRAGMA table_info(workspace_delivery)').all() as {name:string}[]).some(c=>c.name==='prepared_payload'))
      this.db.exec('ALTER TABLE workspace_delivery ADD COLUMN prepared_payload TEXT');
    if(!(this.db.prepare('PRAGMA table_info(workspace_delivery_attempt)').all() as {name:string}[]).some(c=>c.name==='unsent_attempts'))
      this.db.exec('ALTER TABLE workspace_delivery_attempt ADD COLUMN unsent_attempts INTEGER');
    this.timer=setInterval(()=>{for(const link of this.rows()){
      void this.flush(link.id);
      void this.pollConnectors(link.id);
      if(Date.now()-(this.lastSync.get(link.id)??0)>15_000)void this.syncSkills(link.id);
    }
      if (!this.enrollmentPoll && Date.now() >= this.enrollmentNext) {
        this.enrollmentNext = Date.now()+6000;
        this.enrollmentPoll = this.pollEnrollment().catch(()=>{}).finally(()=>{ this.enrollmentPoll=undefined; });
      }
    },1500);this.timer.unref();
  }
  async close() { this.stopped=true;clearInterval(this.timer);await closeRequestBroker(this);for(const c of this.requests.keys())c.abort();await Promise.all([...this.flushing.values(),...this.syncing.values(),...this.connectorPolling.values()]);await this.enrollmentPoll;await this.files.close(); }
  private rows() {return (this.db.prepare('SELECT * FROM workspace_link').all() as Link[]).map(l=>this.withSsh(l));}
  private withSsh(link:Link){const key=this.db.prepare('SELECT public_key FROM workspace_ssh_link WHERE link_id=?').get(link.id) as {public_key:string}|undefined;return {...link,...(key?{publicKey:key.public_key}:{})};}
  private link(id:string) {const link=this.db.prepare('SELECT * FROM workspace_link WHERE id=?').get(id) as Link|undefined;if(!link)throw new HttpError(404,'공유 작업공간 연결이 없습니다');return this.withSsh(link);}
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
  private async connectionToken(link:Link, signal:AbortSignal) {
    if(!link.publicKey)return link.token;
    const key=JSON.stringify([link.url,link.workspace_id,link.publicKey]);
    const cached=this.sshSessions.get(link.id);
    if(cached?.key===key&&cached.expires>Date.now()+60_000)return cached.token;
    let pending=this.sshLogins.get(key);
    if(!pending){pending=sshLogin(link.url,link.workspace_id,link.publicKey,signal);this.sshLogins.set(key,pending);}
    try{const session=await pending;this.sshSessions.set(link.id,{key,...session});return session.token;}
    finally{if(this.sshLogins.get(key)===pending)this.sshLogins.delete(key);}
  }
  async manageSsh(id:string,method:string,body?:unknown,target?:string){
    const path='/v1/ssh/peers'+(target?'/'+encodeURIComponent(target):'');
    return this.request(this.link(id),path,{method,...(body?{body:JSON.stringify(body)}:{})},false,20000);
  }
  async incomingSshRequests(): Promise<WorkspaceConnectRequest[]> {
    const incoming = await Promise.all(this.rows().filter(link => link.publicKey).map(async link => {
      try {
        const reply = await this.request(link,'/v1/ssh/requests');
        if ('status' in reply && reply.status===200 && Array.isArray(reply.body))
          return (reply.body as SshConnectRequest[]).map(item=>({...item,linkId:link.id,workspaceName:link.name}));
      } catch { /* An offline or older runner has no requests to show here. */ }
      return [];
    }));
    return incoming.flat();
  }

  decideSshRequest(linkId:string, requestId:string, approve:boolean) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(requestId)) throw new HttpError(400,'잘못된 연결 요청입니다');
    return this.request(this.link(linkId),'/v1/ssh/requests/'+requestId,{method:'POST',body:JSON.stringify({approve})});
  }

  outgoingSshRequests(): OutgoingConnectRequest[] {
    return (this.db.prepare('SELECT id,name,status,expires FROM workspace_ssh_outgoing ORDER BY expires').all() as unknown as OutgoingConnectRequest[]);
  }

  async startSshRequest(input: { name?:unknown; ownerName?:unknown; hubName?:unknown; url?:unknown; workspaceId?:unknown; publicKey?:unknown; linkId?:unknown }) {
    const name = typeof input.name==='string' ? input.name.trim() : '';
    const ownerName = typeof input.ownerName==='string' ? input.ownerName.trim() : '';
    const hubName = typeof input.hubName==='string' ? input.hubName.trim() : '';
    const workspaceId = input.workspaceId;
    if (!hubName || hubName.length>100 || !name || !ownerName || name.length>100 || ownerName.length>100 ||
        typeof workspaceId!=='string' || !/^[a-f0-9-]{36}$/.test(workspaceId))
      throw new HttpError(400,'작업공간 ID와 허브 이름, 소유자 표시 이름을 입력하세요');
    const url = address(input.url);
    const keys = await agentPublicKeys();
    const key = input.publicKey===undefined && keys.length===1 ? keys[0].key : keys.find(k=>k.key===input.publicKey)?.key;
    if (!key) throw new HttpError(400,'이 허브의 ssh-agent에 등록된 공개키를 선택하세요');
    const existing = this.rows().find(link=>link.workspace_id===workspaceId);
    if (input.linkId!==undefined && (!existing || existing.id!==input.linkId || existing.url!==url))
      throw new HttpError(409,'기존 연결 주소 또는 작업공간이 바뀌었습니다');
    if (existing && input.linkId!==existing.id) throw new HttpError(409,'기존 작업공간의 연결 갱신을 이용하세요');
    if (existing?.publicKey) throw new HttpError(409,'이미 SSH 공개키로 연결된 작업공간입니다');
    const linked = existing?.id ?? '';
    const binding = this.linkBinding(existing);
    const pending = this.db.prepare("SELECT id FROM workspace_ssh_outgoing WHERE workspace_id=? AND link_binding=? AND status IN ('pending','approved') AND expires>?")
      .get(workspaceId,binding,Date.now());
    if (pending) return this.outgoingSshRequests().find(item=>item.id===pending.id)!;
    if (this.startingEnrollment.has(workspaceId)) throw new HttpError(409,'같은 작업공간으로 이미 연결 요청을 보내고 있습니다');
    if (existing && this.db.prepare('SELECT 1 FROM workspace_delivery WHERE link_id=? AND status IS NULL LIMIT 1').get(existing.id))
      throw new HttpError(409,'기존 인증으로 보낸 미전달 입력이 있어 자동 전환할 수 없습니다. 전달 내역에서 원문을 확인하세요');
    if (this.db.prepare('SELECT count(*) AS n FROM workspace_ssh_outgoing').get()!.n as number >= 32)
      throw new HttpError(429,'대기 중인 연결 요청이 많습니다');
    this.startingEnrollment.add(workspaceId);
    try {
      const remoteId = await requestEnrollment(url,workspaceId,{name:hubName,ownerName,publicKey:key});
      if (this.stopped) throw new HttpError(503,'허브가 종료 중입니다');
      if (binding!==this.linkBinding(this.rows().find(link=>link.workspace_id===workspaceId)))
        throw new HttpError(409,'요청을 보내는 동안 기존 연결이 변경됐습니다');
      if (this.db.prepare('SELECT count(*) AS n FROM workspace_ssh_outgoing').get()!.n as number >= 32)
        throw new HttpError(429,'대기 중인 연결 요청이 많습니다');
      const item = { id:randomUUID(), name, status:'pending' as const, expires:Date.now()+15*60_000 };
      this.db.prepare('INSERT INTO workspace_ssh_outgoing VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(item.id,linked,binding,url,workspaceId,name,key,remoteId,item.status,item.expires);
      return item;
    } finally { this.startingEnrollment.delete(workspaceId); }
  }

  private linkBinding(link:Link|undefined) {
    return link ? digest(canonical(link)) : '';
  }

  private async pollEnrollment() {
    this.db.prepare('DELETE FROM workspace_ssh_outgoing WHERE expires<?').run(Date.now()-60_000);
    const pending=this.db.prepare("SELECT * FROM workspace_ssh_outgoing WHERE status IN ('pending','approved')").all() as unknown as Outgoing[];
    await Promise.all(pending.map(async item=>{
      const finish=(status:OutgoingConnectRequest['status'])=>this.db.prepare('UPDATE workspace_ssh_outgoing SET status=? WHERE id=?').run(status,item.id);
      if (item.expires<=Date.now()) { finish('expired');return; }
      const controller=new AbortController();
      this.requests.set(controller,item.link_id);
      try {
        const result=await enrollmentCall(item.url,'status',{id:item.remote_id},controller.signal);
        if (this.stopped) return;
        if (result.status==='rejected' || result.status==='expired') { finish(result.status); return; }
        if (result.status!=='approved') return;
        if (item.status!=='approved') finish('approved');
        const current=this.rows().find(link=>link.workspace_id===item.workspace_id);
        if (current?.publicKey===item.key && current.url===item.url) { finish('connected'); return; }
        const stillExpected=()=> {
          const link=this.rows().find(link=>link.workspace_id===item.workspace_id);
          return !this.stopped && this.linkBinding(link)===item.link_binding;
        };
        if (!stillExpected()) { finish('expired');return; }
        await this.attach({name:item.name,url:item.url,workspaceId:item.workspace_id,publicKey:item.key},item.link_id||undefined,stillExpected);
        finish('connected');
      } catch { /* Retry after the runner is reachable or pending deliveries have drained. */ }
      finally { this.requests.delete(controller); }
    }));
  }

  private async request(link:Link,path:string,init:RequestInit={},stream=false,timeoutMs=3000,preserveErrorStatus=false):Promise<{status:number;body:any}|{response:Response;release:()=>void;signal:AbortSignal}> {
    if(this.stopped)throw new Error('종료 중입니다');
    const controller=new AbortController();this.requests.set(controller,link.id);
    const timer=setTimeout(()=>controller.abort(),link.publicKey?Math.max(timeoutMs,20000):timeoutMs);
    try {
      const response=await fetch(new URL(path,link.url),{...init,redirect:'error',headers:{'content-type':'application/json',...init.headers,authorization:`Bearer ${await this.connectionToken(link,controller.signal)}`,'x-workspace-id':link.workspace_id},signal:init.signal ? AbortSignal.any([controller.signal,init.signal]) : controller.signal});
      if(response.status===401)this.sshSessions.delete(link.id);
      if(stream){clearTimeout(timer);return {response,signal:controller.signal,release:()=>{controller.abort();this.requests.delete(controller);}};}
      const body=await response.json().catch(error=>{if(!preserveErrorStatus||response.ok)throw error;return null;});
      return {status:response.status,body};
    } catch(e) { controller.abort();this.requests.delete(controller);throw e; }
    finally {clearTimeout(timer);if(!stream)this.requests.delete(controller);}
  }
  async attach(input:{name?:unknown;url?:unknown;token?:unknown;publicKey?:unknown;workspaceId?:unknown},id?:string,unchanged?:()=>boolean) {
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new HttpError(400,'작업공간 이름이 필요합니다');
    const ssh=input.publicKey!==undefined;
    if(ssh&&(typeof input.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(input.workspaceId)))throw new HttpError(400,'설치 시 확인한 작업공간 ID가 필요합니다');
    if(!ssh&&(typeof input.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(input.token)))throw new HttpError(400,'연결 토큰이 필요합니다');
    const key=ssh?(await validatePublicKey(input.publicKey)).key:undefined;
    const link:Link={id:id??randomUUID(),name:input.name.trim(),url:address(input.url),token:ssh?'':input.token as string,workspace_id:ssh?input.workspaceId as string:'',...(key?{publicKey:key}:{})};
    const reply=await this.request(link,'/v1/identity');
    if(!('status' in reply)||reply.status!==200||reply.body.version!==1||typeof reply.body.workspace_id!=='string')throw new HttpError(409,'공유 러너 연결을 확인하지 못했습니다');
    if(key && reply.body.workspace_id!==link.workspace_id)throw new HttpError(409,'설치 시 확인한 작업공간과 다릅니다');
    link.workspace_id=reply.body.workspace_id;
    const legacy=this.legacy(link.id);
    if(legacy.some(row=>!(reply.body.migration?.runner_id===row.runner_id&&reply.body.migration?.address===row.address
      &&reply.body.migration?.fingerprint===row.fingerprint)
      &&!reply.body.merges?.some((m:{old_runner_id:string;fingerprint:string})=>m.old_runner_id===row.runner_id&&m.fingerprint===row.fingerprint)))
      throw new HttpError(409,'이관한 원격 작업공간의 신원이 일치하지 않습니다');
    if(id&&this.db.prepare('SELECT 1 FROM workspace_link WHERE id=?').get(id)&&this.link(id).workspace_id!==link.workspace_id)throw new HttpError(409,'기존 연결을 다른 작업공간으로 바꿀 수 없습니다');
    if(this.rows().some(l=>l.workspace_id===link.workspace_id&&l.id!==id))throw new HttpError(409,'이미 연결한 공유 작업공간입니다');
    if (unchanged && !unchanged()) throw new HttpError(409,'대기하는 동안 기존 연결이 변경되었습니다');
    const previous=this.rows().find(row=>row.id===id);
    if(previous && previous.publicKey!==key && this.db.prepare('SELECT 1 FROM workspace_delivery WHERE link_id=? AND status IS NULL LIMIT 1').get(link.id))throw new HttpError(409,'미전달 입력이 있어 인증 키를 바꿀 수 없습니다. 기존 입력을 먼저 처리하세요');
    this.db.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,token=excluded.token').run(link.id,link.name,link.url,link.workspace_id,link.token);
    if(key)this.db.prepare('INSERT OR REPLACE INTO workspace_ssh_link VALUES(?,?)').run(link.id,key);
    else this.db.prepare('DELETE FROM workspace_ssh_link WHERE link_id=?').run(link.id);
    this.db.prepare('INSERT INTO workspace_view_index(link_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM workspace_view_index WHERE link_id=?)').run(link.id,link.id);
    if(previous&&(previous.url!==link.url||previous.token!==link.token||previous.publicKey!==link.publicKey)) {
      this.usageCache.delete(link.id);
      for(const [controller,source] of this.requests)if(source===id)controller.abort();
    }
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
  /** Read source metadata directly; never queue a copy action or download its contents. */
  async documentPath(id: string, task: string, href: string, approvedPath?: string) {
    const link = this.link(id), identity = await this.request(link, '/v1/identity');
    if (!('status' in identity) || identity.status !== 200 || identity.body.capabilities?.file_path !== 1)
      throw new HttpError(409, '원본 경로를 복사하려면 해당 러너를 업데이트해야 합니다');
    const reply = await this.request(link, '/v1/file-path?' + new URLSearchParams({ task_id: task, href, ...(approvedPath ? { approved_path: approvedPath } : {}) }));
    if (!('status' in reply)) throw new HttpError(502, '원본 경로 응답을 받지 못했습니다');
    if (reply.status !== 200) throw new HttpError(reply.status, reply.status === 404 ? '원본 문서나 작업을 찾을 수 없습니다' : '원본 경로를 확인하지 못했습니다. 문서 접근 권한과 러너 연결을 확인해 주세요');
    const path = reply.body?.path;
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f]/.test(path))
      throw new HttpError(502, '러너가 올바른 원본 절대 경로를 반환하지 않았습니다');
    return path;
  }

  /** A bounded preview transfer; the runner must enforce the document-directory boundary. */
  async previewFile(id:string, taskId:string, href:string, base:string|undefined, receive:(r:Response)=>Promise<string>, approvedPath?:string) {
    const link=this.link(id);
    const identity=await this.request(link,'/v1/identity');
    if(!('status' in identity)||identity.status!==200||identity.body.capabilities?.file_preview!==1)
      throw new HttpError(409,'문서 미리보기를 사용하려면 해당 러너를 업데이트해야 합니다');
    if(approvedPath!==undefined&&identity.body.capabilities?.file_permission!==1)
      throw new HttpError(409,'파일별 문서 허용을 사용하려면 해당 러너를 업데이트해야 합니다');
    const reply=await this.request(link,'/v1/file?'+new URLSearchParams({task_id:taskId,href,...(base?{base}:{}),...(approvedPath!==undefined?{approved_path:approvedPath}:{})}),{},true);
    if(!('response' in reply))throw new HttpError(502,'파일 응답을 받지 못했습니다');
    const timer=setTimeout(reply.release,30_000);
    try {
      if(!reply.response.ok) {
        const status=reply.response.status;
        // Only a small typed permission response may cross the runner boundary; never its free-form error.
        if(status===403&&reply.response.headers.get('content-type')?.includes('application/json')&&reply.response.body) {
          const reader=reply.response.body.getReader();let size=0;const chunks:Uint8Array[]=[];let permission:unknown;
          try {
            while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16*1024){await reader.cancel();break;}chunks.push(part.value);}
            if(size<=16*1024)permission=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          }catch{/* Malformed, excessive or interrupted errors remain a generic denial. */}
          finally{reader.releaseLock();}
          const details=permission as {code?:unknown;path?:unknown}|undefined;
          if(details?.code==='document_permission_required'&&typeof details.path==='string'&&isAbsolute(details.path)&&details.path.length<=4096&&!/[\x00-\x1f]/.test(details.path))
            throw new DocumentPermissionError(details.path);
        }
        // Do not display arbitrary runner error bodies.
        const reason=status===403?'문서 경로가 허용 범위 밖이거나 읽기 권한이 없습니다'
          :status===404?'문서 파일이나 작업을 찾을 수 없습니다'
          :status===413?'문서 파일은 50 MB까지 가져올 수 있습니다'
          :`문서 파일을 가져오지 못했습니다 (HTTP ${status})`;
        throw new HttpError(status,reason);
      }
      return await receive(reply.response);
    } finally { clearTimeout(timer);reply.release(); }
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
    const link = this.link(id);
    if(this.legacy(id).length)throw new HttpError(409,'이관한 원격 원본 연결은 제거할 수 없습니다');
    if(this.flushing.has(id)||this.list().find(l=>l.id===id)!.pending)throw new HttpError(409,'전달 중이거나 미전달 입력이 있어 연결을 제거할 수 없습니다');
    this.db.prepare('DELETE FROM workspace_delivery WHERE link_id=?').run(id);
    this.db.prepare('DELETE FROM workspace_link WHERE id=?').run(id);
    this.db.prepare('DELETE FROM workspace_ssh_link WHERE link_id=?').run(id);
    this.sshSessions.delete(id);
    this.usageCache.delete(id);
    this.connectorAuthority?.revokeWorkspace(link.workspace_id);
    for(const [controller,link] of this.requests)if(link===id)controller.abort();
  }
  deliveries(id:string) {
    this.link(id);
    return (this.db.prepare('SELECT id,payload,status,result FROM workspace_delivery WHERE link_id=? AND (status IS NULL OR status>=400) ORDER BY seq DESC LIMIT 100').all(id) as {id:string;payload:string;status:number|null;result:string|null}[])
      .map(r=>{const op=JSON.parse(r.payload);return {id:r.id,status:r.status,method:op.method,path:op.path,
        text:r.status!==null&&r.status>=400&&typeof op.body?.text==='string'?op.body.text:undefined,
        error:r.result?JSON.parse(r.result).error:undefined};});
  }
  async read(id:string,path:string,timeout?:number,signal?:AbortSignal) {
    const usage = /^\/runner-usage(?:\?|$)/.test(path);
    const reply=await this.request(this.link(id),`/v1/read?path=${encodeURIComponent(path)}`,{signal},false,timeout,usage);
    if(!('status' in reply))throw new Error('작업공간 응답 형식이 잘못되었습니다');
    return reply;
  }
  async runnerUsageTargets(id: string, signal?: AbortSignal): Promise<UsageTarget[]> {
    const link = this.link(id);
    const cache = this.runnerUsageCache(id);
    const response = await this.read(id, '/runner-usage', undefined, signal).catch(() => undefined);
    if (!this.sameUsageLink(link)) return [];
    if (usageAccessDenied(response)) { this.usageCache.delete(id); return []; }
    if (signal?.aborted || this.usageCache.get(id) !== cache) return [];
    if (response?.status === 200 && checkUsageTargets(response.body)) {
      const targets = response.body.map(({ id, label }) => ({ id, label }));
      cache.targets = targets;
      return targets;
    }
    if (response && response.status < 500) return [];
    return cache.targets ?? [];
  }
  async runnerUsage(id: string, query: UsageQuery, signal?: AbortSignal): Promise<UsageReading> {
    const link = this.link(id);
    const cache = this.runnerUsageCache(id);
    const params = new URLSearchParams({ runner: query.runner, engine: query.engine, refresh: query.refresh ? '1' : '0' });
    const response = await this.read(id, '/runner-usage?' + params, 41_000, signal).catch(() => undefined);
    if (!this.sameUsageLink(link)) return { status: 'offline' };
    if (usageAccessDenied(response)) {
      this.usageCache.delete(id);
      return { status: 'error', message: '작업공간 연결 권한을 확인하세요.' };
    }
    if (signal?.aborted || this.usageCache.get(id) !== cache) return { status: 'offline' };
    const key = `${query.runner}/${query.engine}`;
    if (response?.status === 200 && checkUsageReading(response.body, query.engine)) {
      const reading = response.body;
      if (reading.value) cache.values.set(key, reading.value);
      else if (reading.status === 'unsupported') cache.values.delete(key);
      else return { ...reading, value: cache.values.get(key) };
      return reading;
    }
    if (response && response.status < 500) {
      cache.values.delete(key);
      if (response.status === 404) return { status: 'unsupported' };
      return { status: 'error', message: '작업공간 연결 권한 또는 러너 설정을 확인하세요.' };
    }
    return { status: 'offline', value: cache.values.get(key) };
  }
  private sameUsageLink(before: Link) {
    const current = this.rows().find(link => link.id === before.id);
    return current?.url === before.url && current.token === before.token && current.publicKey === before.publicKey;
  }
  private runnerUsageCache(id: string) {
    let cache = this.usageCache.get(id);
    if (!cache) this.usageCache.set(id, cache = { values: new Map() });
    return cache;
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
    const rpc=body as {params?:{name?:string;arguments?:Record<string,unknown>}};
    const name=rpc?.params?.name;
    const proof=(name==='desk_request'||name==='desk_reply'||name==='desk_settings') && signRequest(req.headers?.['x-desk-session'],toolFields(name,rpc.params?.arguments??{}));
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    try {
      const response=await fetch(new URL('/v1/mcp',link.url),{method:req.method,redirect:'error',
        headers:{'content-type':'application/json',authorization:`Bearer ${await this.connectionToken(link,controller.signal)}`,'x-workspace-id':link.workspace_id,...(proof && {'x-desk-request-proof':proof})},
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
    try {
      const reply=await this.request(this.link(id),'/v1/skills/manifest');
      if('status' in reply&&reply.status===200&&reply.body?.hashes&&typeof reply.body.hashes==='object')return true;
      if('status' in reply&&reply.status===404)return false;
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
  /** The authenticated gateway drains only jobs assigned to its own workspace peer. */
  pollConnectors(id: string): Promise<void> {
    const active = this.connectorPolling.get(id); if (active) return active;
    if (!this.connectorAuthority || this.stopped) return Promise.resolve();
    const authority = this.connectorAuthority;
    const work = (async () => {
      const link = this.link(id);
      const polled = await this.request(link, '/v1/connectors/poll');
      if (!('status' in polled) || polled.status !== 200 || !Array.isArray(polled.body) || polled.body.length > 32) return;
      for (const job of polled.body as ConnectorJob[]) {
        if (this.stopped) break;
        if (!job || typeof job.callId !== 'string' || !job.context || job.context.workspaceId !== link.workspace_id
          || !Number.isSafeInteger(job.expiresAt) || job.expiresAt <= Date.now()) continue;
        const completion = await executeConnectorJob(authority, job);
        if (this.stopped || job.expiresAt <= Date.now()) continue;
        const completed = await this.request(link, '/v1/connectors/complete', { method: 'POST', body: JSON.stringify({ callId: job.callId, completion }) });
        if ('status' in completed && completed.status === 200)
          await this.request(link, '/v1/connectors/ack', { method: 'POST', body: JSON.stringify({ callIds: [job.callId] }) });
      }
    })().catch(() => { /* The next peer-scoped poll retries the same call IDs; no account fallback. */ })
      .finally(() => this.connectorPolling.delete(id));
    this.connectorPolling.set(id, work); return work;
  }
  enqueue(id:string,input:unknown) {
    const link = this.link(id);const op=operation(input),hash=digest(canonical(op));const old=this.result(op.id);
    if('__desk_instructions' in op.body||'__desk_skill_ref' in op.body||'__desk_skill_bundle' in op.body||'__desk_connector_grant' in op.body||'__desk_connector_selection' in op.body||'__desk_connector_identity' in op.body||'__desk_schedule_accepted_at' in op.body)
      throw new HttpError(400,'내부 지침·스킬 필드는 작업공간 연결에서만 설정합니다');
    if(old&&(old.digest!==hash||old.link_id!==id))throw new HttpError(409,'같은 명령 ID의 내용 또는 대상이 바뀌었습니다');
    if(!old){
      const enrollment=this.db.prepare("SELECT 1 FROM workspace_ssh_outgoing WHERE link_id=? AND link_binding=? AND status IN ('pending','approved') AND expires>?")
        .get(id,this.linkBinding(link),Date.now());
      if (this.startingEnrollment.has(link.workspace_id)||enrollment)
        throw new HttpError(409,'SSH 연결 요청을 처리 중입니다. 연결이 갱신된 뒤 다시 보내세요');
      const literalNote = isNoteInput(op.method, op.path, op.body);
      const text=typeof op.body.text==='string'?op.body.text:typeof op.body.prompt==='string'?op.body.prompt:undefined;
      const path = op.path.split('?')[0];
      if (!literalNote && text && op.method === 'POST' && (path === '/compose' || path === '/tasks' || /^\/(?:tasks|channels)\/[^/]+\/messages$/.test(path))
        && hasScheduledReply(path === '/compose' ? parseComposeTarget(text).text : text))
        throw new HttpError(400, scheduledReplyHint);
      const bundle=!literalNote&&text&&this.skills&&this.needsSkillSnapshot(text)
        ? collectSkillBundle(this.skills,text)??EMPTY_SKILL_BUNDLE:null;
      const prepared=bundle?JSON.stringify(bundle):'';
      const preparedOp: WorkspaceOperation = needsDefaultInstructions(op.method, op.path, op.body)
        ? {...op, body: {...op.body, __desk_instructions: this.instructions?.()}} : {...op, body: {...op.body}};
      if (op.method === 'POST' && /^\/tasks\/[^/]+\/scheduled-replies$/.test(path)) {
        const acceptedAt = Date.now();
        const instant = scheduledReplyInstant(op.body.scheduled_at);
        if (!Number.isFinite(instant)) throw new HttpError(400,'예약 시각 형식이 잘못되었습니다');
        if (instant <= acceptedAt) throw new HttpError(400,'예약 시각이 지났습니다. 새로운 시각으로 예약해 주세요');
        preparedOp.body.__desk_schedule_accepted_at = acceptedAt;
      }
      this.db.exec('SAVEPOINT connector_enqueue');
      try {
      if (!literalNote && connectorUserInput(op.method, op.path)) {
        if(this.connectorAuthority)preparedOp.body.__desk_connector_identity=this.connectorAuthority.identity();
        const scopes=connectorInputScopes(op.method,op.path,op.body);
        if (scopes.length) {
          if (!this.connectorAuthority) throw new HttpError(409,'외부 연결을 사용할 수 없습니다. 허브 연결 설정을 확인하세요');
          preparedOp.body.__desk_connector_selection={scopes,policy:this.connectorAuthority.select(scopes),hubId:this.connectorAuthority.hubId};
        }
      }
      const payload = JSON.stringify(preparedOp);
      const pending=this.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))+coalesce(length(CAST(prepared_payload AS BLOB)),0)),0) bytes FROM workspace_delivery WHERE status IS NULL').get() as {n:number;bytes:number};
      if(pending.n>=1000||pending.bytes+Buffer.byteLength(payload)+Buffer.byteLength(prepared)>32*1024*1024)
        throw new HttpError(429,'미전달 입력 한도에 도달했습니다. 연결 복구 후 다시 보내세요');
      this.db.prepare('INSERT INTO workspace_delivery(id,link_id,digest,payload,prepared_payload) VALUES(?,?,?,?,?)')
        .run(op.id,id,hash,payload,prepared);
      this.db.prepare('INSERT OR IGNORE INTO workspace_delivery_attempt(id,accepted_at,unsent_attempts) VALUES(?,?,0)').run(op.id,new Date().toISOString());
      this.db.exec('RELEASE connector_enqueue');
      } catch (error) { this.db.exec('ROLLBACK TO connector_enqueue; RELEASE connector_enqueue'); throw error; }
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
        const attempt=this.db.prepare('SELECT attempts,unsent_attempts FROM workspace_delivery_attempt WHERE id=?').get(row.id) as {attempts:number;unsent_attempts:number|null};
        // Older gateways increment attempts but cannot mark their attempts as unsent.
        const mayHaveSent=attempt.unsent_attempts!==attempt.attempts;
        const failure=(value:string)=>this.db.prepare('UPDATE workspace_delivery_attempt SET failure=?,failed_at=? WHERE id=?').run(value,new Date().toISOString(),row.id);
        this.db.prepare('UPDATE workspace_delivery_attempt SET attempted_at=?,attempts=attempts+1,unsent_attempts=? WHERE id=?')
          .run(new Date().toISOString(),mayHaveSent?null:attempt.attempts+1,row.id);
        if(this.stopped)break;
        try {
          const op=JSON.parse(row.payload) as WorkspaceOperation;
          const complete = (status: number, body: unknown) => {
            this.db.prepare('UPDATE workspace_delivery_attempt SET completed_at=? WHERE id=?').run(new Date().toISOString(),row.id);
            // Drop prompts and secret answers once delivery is confirmed. Keep the receipt and digest.
            this.db.prepare('UPDATE workspace_delivery SET status=?,result=?,payload=?,prepared_payload=NULL WHERE id=?')
              .run(status,JSON.stringify(body),status<400?JSON.stringify({id:op.id,method:op.method,path:op.path}):row.payload,row.id);
          };
          const receipt = async () => {
            const reply = await this.request(this.link(id), '/v1/receipts/' + encodeURIComponent(op.id));
            if (this.stopped) return 'unavailable';
            if ('status' in reply && reply.status === 200 && Number.isInteger(reply.body?.status) && reply.body.status >= 200 && reply.body.status < 500) {
              complete(reply.body.status, reply.body.body);
              return 'recorded';
            }
            if ('status' in reply && reply.status === 404 && (!mayHaveSent || reply.body?.code === 'receipt_not_found' || reply.body?.error === '처리 기록이 없습니다')) return 'missing';
            failure('receipt_unavailable');
            return 'unavailable';
          };
          const unsupported = async (feature: string, error: string) => {
            const state = await receipt();
            if (state === 'missing') complete(409,{code:'unsupported_feature',feature,error});
            return state !== 'unavailable';
          };
          const literalNote = isNoteInput(op.method, op.path, op.body);
          const codeReview = workspaceRoute(op.method, op.path) === 'POST /tasks/:id/messages' && op.body.code_review === true;
          if (literalNote || op.body.note_context !== undefined || codeReview) {
            const identity = await this.request(this.link(id), '/v1/identity');
            if (!('status' in identity) || identity.status !== 200) { failure(codeReview?'code_review_capability_unavailable':'notes_capability_unavailable'); break; }
            if (codeReview && identity.body?.capabilities?.code_review_messages !== 1) {
              if (!await unsupported('code_review_messages','공유 러너가 코드 검토 전송을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내 주세요')) break;
              continue;
            }
            if ((literalNote || op.body.note_context !== undefined) && identity.body?.capabilities?.notes !== 1) {
              if (!await unsupported('notes','공유 러너가 메모를 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내주세요')) break;
              continue;
            }
            if (workspaceRoute(op.method, op.path) === NOTE_CUT_ROUTE && identity.body?.capabilities?.note_cut !== 1) {
              if (!await unsupported('note_cut','공유 러너가 메모 잘라내기를 지원하지 않습니다. 러너를 업데이트한 뒤 다시 시도해 주세요')) break;
              continue;
            }
          }
          const selection=op.body.__desk_connector_selection as {scopes:ConnectorScope[];policy:ConnectorPolicy[];hubId:string}|undefined;
          let connectorGrant = op.body.__desk_connector_grant as { expiresAt?: number; inputScoped?:true;capability?:string } | null | undefined;
          if(connectorGrant&&!connectorGrant.inputScoped) {
            // Do not rewrite an operation already committed before a lost response.
            const state=await receipt();
            if(state==='unavailable')break;
            if(state==='recorded')continue;
            if(connectorInputScopes(op.method,op.path,op.body).length) {
              complete(409,{error:'업데이트 전 입력의 권한은 자동 승계하지 않습니다. 내용을 확인하고 태그와 함께 다시 보내세요'});
              continue;
            }
            if(connectorGrant.capability)this.connectorAuthority?.revoke(connectorGrant.capability);
            delete op.body.__desk_connector_grant;connectorGrant=undefined;
            if(this.connectorAuthority)op.body.__desk_connector_identity=this.connectorAuthority.identity();
            this.db.prepare('UPDATE workspace_delivery SET payload=? WHERE id=?').run(JSON.stringify(op),row.id);
          }
          if (connectorGrant && (!Number.isSafeInteger(connectorGrant.expiresAt) || connectorGrant.expiresAt! <= Date.now())) {
            // A lost response must not turn an already committed input into an expiry error.
            const state=await receipt();
            if(state==='unavailable')break;
            if(state==='missing')complete(409,{error:'대기 중 외부 연결 허가가 만료되었습니다. 현재 연결을 확인하고 입력을 다시 보내주세요'});
            continue;
          }
          if (selection || op.body.__desk_connector_grant) {
            const identity = await this.request(this.link(id), '/v1/identity');
            if (!('status' in identity) || identity.status !== 200) { failure('connector_capability_unavailable'); break; }
            if (identity.body?.capabilities?.connectors !== 1 || ((selection || connectorGrant?.inputScoped) && identity.body?.capabilities?.connector_tags !== 1)) {
              if (!await unsupported('connectors','공유 러너가 요청별 외부 연결을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내주세요')) break;
              continue;
            }
            if (selection) {
              try {
                if (!this.connectorAuthority || selection.hubId!==this.connectorAuthority.hubId) throw new HttpError(409,'권한을 선택한 허브가 바뀌었습니다. 원래 허브에서 다시 요청하세요');
                this.db.exec('SAVEPOINT connector_prepare');
                try {
                  op.body.__desk_connector_grant=this.connectorAuthority.issue({workspaceId:this.link(id).workspace_id,requestId:op.id,scopes:selection.scopes,expectedPolicy:selection.policy});
                  delete op.body.__desk_connector_selection;
                  this.db.prepare('UPDATE workspace_delivery SET payload=? WHERE id=?').run(JSON.stringify(op),row.id);
                  this.db.exec('RELEASE connector_prepare');
                } catch(error) {this.db.exec('ROLLBACK TO connector_prepare; RELEASE connector_prepare');throw error;}
              } catch (error) {
                if (!(error instanceof HttpError)) throw error;
                this.db.prepare('UPDATE workspace_delivery SET status=?,result=?,prepared_payload=NULL WHERE id=?').run(error.status,JSON.stringify({error:error.message}),row.id);
                continue;
              }
            }
          }
          if (needsDefaultInstructions(op.method, op.path, op.body) && op.body.__desk_instructions !== undefined && op.body.__desk_instructions !== DEFAULT_INSTRUCTIONS) {
            const identity = await this.request(this.link(id), '/v1/identity');
            if (!('status' in identity) || identity.status !== 200) { failure('instructions_capability_unavailable'); break; }
            if (identity.body?.capabilities?.instructions !== 1) {
              if (!await unsupported('instructions','공유 러너가 사용자 지침을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내주세요')) break;
              continue;
            }
          }
          const text=typeof op.body.text==='string'?op.body.text:typeof op.body.prompt==='string'?op.body.prompt:undefined;
          if(!literalNote&&this.skills&&text&&this.needsSkillSnapshot(text)&&!row.prepared_payload){
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
              if (!await unsupported('skill_snapshots','공유 러너가 스킬 스냅샷을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내세요')) break;
              continue;
            }
          }
          const ref=bundle?{version:bundle.version,selected:bundle.selected,hashes:bundle.hashes,digest:bundle.digest}:null;
          const requestBody=JSON.stringify(ref?{...op,body:{...op.body,__desk_skill_ref:ref}}:op);
          this.db.prepare('UPDATE workspace_delivery_attempt SET unsent_attempts=NULL WHERE id=?').run(row.id);
          let r=await this.request(this.link(id),'/v1/operation',{method:'POST',body:requestBody});
          if(bundle&&'status' in r&&r.status===409&&r.body?.code==='skill_missing'){
            const prepared=await this.request(this.link(id),'/v1/skills/prepare',
              {method:'POST',body:JSON.stringify({op_id:op.id,bundle})},false,10_000);
            if(!('status' in prepared)||prepared.status>=500){failure('skill_prepare_unavailable');break;}
            if(prepared.status!==200)r=prepared;
            else r=await this.request(this.link(id),'/v1/operation',{method:'POST',body:requestBody});
          }
          if(this.stopped)break;
          const requestDenied = 'status' in r && r.status===403 && !!op.body.__desk_connector_grant
            && (r.body?.code==='connector_permission' || r.body?.error==='사용자 입력과 외부 연결 허가가 일치하지 않거나 만료되었습니다'
              || r.body?.error==='입력 태그와 외부 조회 권한 범위가 일치하지 않습니다');
          if(!('status' in r)||r.status>=500||r.status===401||r.status===403&&!requestDenied||(r.status===409&&r.body?.code==='workspace_mismatch')){failure('status' in r?`http_${r.status}`:'invalid_response');break;}
          complete(r.status, r.body);
        }catch(error){failure(error instanceof Error ? error.name : 'request_failed');break;}
      }
    })().finally(()=>this.flushing.delete(id));
    this.flushing.set(id,pending);return pending;
  }
  /** One upstream attempt; the gateway owns reconnects and cancels when the page closes. */
  async stream(id:string,signal:AbortSignal,opened:()=>void,receive:(message:HubMessage)=>void) {
    const reply=await this.request(this.link(id),'/v1/stream',{signal},true);
    if(!('response' in reply))throw new Error('invalid stream');
    try {
      if(!reply.response.ok||!reply.response.body)throw new Error('upstream stream unavailable');
      if(signal.aborted||reply.signal.aborted)return;
      opened();
      await readSse(reply.response.body,data=>{
        if(signal.aborted||reply.signal.aborted)return;
        const message=JSON.parse(data) as HubMessage;
        if(!message||typeof message.type!=='string')throw new Error('invalid stream message');
        receive(message);
      });
    }finally{reply.release();}
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
    const limit = workspaceRoute(req.method!,path) === 'PUT /prompt-templates' ? MAX_PROMPT_TEMPLATES_BODY : undefined;
    const op={id:typeof requestId==='string'?requestId:randomUUID(),method:req.method!,path,body:(suppliedBody??await readBody(req,limit))??{}};
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
