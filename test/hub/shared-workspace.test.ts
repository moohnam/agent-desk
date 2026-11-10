import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request, type Server } from 'node:http';
import { SharedRuntime } from '../../hub/src/runner/shared-runtime.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import type { StartOptions } from '../../hub/src/runner/engine.ts';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const listen=(server:Server,port=0)=>new Promise<string>(r=>server.listen(port,'127.0.0.1',()=>r(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const stop=(server:Server)=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});
const wait=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+9000;while(!await check()){if(Date.now()>end)throw Error('wait timeout');await delay(30);}};

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'desk-workspace-'));const project=join(dir,'project');mkdirSync(project);
 const starts:StartOptions[]=[],sends:string[]=[],approved:string[]=[];let interrupts=0;
 const runtime=new SharedRuntime(join(dir,'runner'),'shared@worker',{start:o=>{starts.push(o);o.emit({type:'engine_session',sessionId:o.sessionId,engineSessionId:'fixture'});o.emit({type:'busy',sessionId:o.sessionId,busy:true});return {
  send:text=>{sends.push(text);o.emit({type:'busy',sessionId:o.sessionId,busy:true});},resolveApproval:id=>{approved.push(id);},interrupt:async()=>{interrupts++;},setMode:async()=>{},setModel:async()=>{},close:()=>{},
 };}});
 const finish=(text:string)=>{const o=starts.at(-1)!;o.emit({type:'event',sessionId:o.sessionId,event:{kind:'assistant',text}});o.emit({type:'busy',sessionId:o.sessionId,busy:false});runtime.exchange();};
 return {dir,project,runtime,starts,sends,approved,finish,interrupts:()=>interrupts,close:()=>{runtime.close();rmSync(dir,{recursive:true,force:true});}};
}

test('two ordinary hub APIs share one runner: history, commands, approvals, offline input and restart',async()=>{
 const f=fixture(),authority=f.runtime.workspace.server();const runnerUrl=await listen(authority);const port=Number(new URL(runnerUrl).port);
 const gateways:{store:Store;hub:Hub;server:Server;url:string;id:string;dir:string}[]=[];
 const make=async(name:string,existing?:string)=>{
  const dir=existing??join(f.dir,name);const store=new Store(join(dir,'hub.db'));
  const hub=new Hub(store,{skills:new SkillStore(join(dir,'skills')),runner:()=>({connected:true,id:name,engines:new Set(),has:()=>false,handle:()=>{throw Error('must never execute in gateway');}})});
  const server=createHttpServer(hub,new Access(join(dir,'access-token'),4317),join(dir,'uploads'));const url=await listen(server);
  let id:string;
  if(existing){const list=await fetch(url+'/api/workspaces').then(r=>r.json()) as any[];id=list[0].id;}
  else {const credential=f.runtime.workspace.grant(name);const response=await fetch(url+'/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,url:runnerUrl,token:credential.token})});assert.equal(response.status,201);id=((await response.json()) as any).id;}
  const gateway={dir,store,hub,server,url,id};gateways.push(gateway);return gateway;
 };
 const api=async(g:Awaited<ReturnType<typeof make>>,path:string,method='GET',body?:unknown,opId=randomUUID())=>{
  const r=await fetch(`${g.url}/api/workspaces/${g.id}${path}`,{method,headers:{'content-type':'application/json','x-desk-operation-id':opId},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};
 };
 const closeGateway=async(g:typeof gateways[number])=>{await stop(g.server);await delay(40);g.hub.remotes.close();g.store.database.close();gateways.splice(gateways.indexOf(g),1);};
 let streamController:AbortController|undefined;
 try {
  const a=await make('a');let b=await make('b');
  assert.equal((await api(a,'/compose','POST',{text:'@bad:worker:relative #claude invalid'})).status,400);
  const task=(await api(a,'/compose','POST',{text:`@test:shared@worker:${f.project} #claude #ask initial`})).body;
  assert.ok(task.id);await wait(()=>f.starts.length===1);
  assert.equal((await api(b,'/state')).body.tasks[0].id,task.id);
  assert.deepEqual((await api(a,'/state')).body.projects,(await api(b,'/state')).body.projects);
  assert.equal(a.store.listTasks().length,0);assert.equal(b.store.listTasks().length,0);
  streamController=new AbortController();const stream=await fetch(`${b.url}/api/workspaces/${b.id}/stream`,{signal:streamController.signal});assert.equal(stream.status,200);
  let seen='';const reading=(async()=>{try{for await(const chunk of stream.body! as any)seen+=new TextDecoder().decode(chunk);}catch{}})();
  const first=randomUUID();await api(a,`/tasks/${task.id}/messages`,'POST',{text:'a-message'},first);
  await api(b,`/tasks/${task.id}/messages`,'POST',{text:'b-message'});
  await api(b,`/tasks/${task.id}/messages`,'POST',{text:'a-message'},first);
  assert.equal((await api(a,'/state')).body.tasks[0].queued.length,2);
  assert.equal((await api(a,`/tasks/${task.id}/messages`,'POST',{text:'changed'},first)).status,409);
  f.finish('first');await wait(()=>f.sends.length===1);f.finish('second');await wait(()=>f.sends.length===2);f.finish('third');
  assert.deepEqual(f.sends,['a-message','b-message']);
  await wait(()=>seen.includes('b-message'));streamController.abort();await reading;
  assert.deepEqual((await api(a,`/tasks/${task.id}/events`)).body,(await api(b,`/tasks/${task.id}/events`)).body);
  f.starts[0].emit({type:'approval_request',sessionId:f.starts[0].sessionId,approvalId:'one-approval',toolName:'Bash',input:{command:'true'}});f.runtime.exchange();
  const race=await Promise.all([api(a,'/approvals/one-approval','POST',{allow:true}),api(b,'/approvals/one-approval','POST',{allow:false})]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,404]);await wait(()=>f.approved.length===1);
  await api(b,`/tasks/${task.id}/interrupt`,'POST');await wait(()=>f.interrupts()===1);
  const originalB=b.dir;await closeGateway(b);f.finish('while-b-absent');b=await make('b',originalB);
  assert.ok((await api(b,`/tasks/${task.id}/events`)).body.events.some((e:any)=>e.payload.text==='while-b-absent'));
  await stop(authority);
  const offlineId=randomUUID();const pending=await api(b,`/tasks/${task.id}/messages`,'POST',{text:'offline-message'},offlineId);
  assert.equal(pending.status,202);assert.equal(pending.body.shared_pending,true);
  assert.equal((await api(b,'/deliveries')).body.filter((r:any)=>r.status===null).length,1);
  await closeGateway(b);b=await make('b',originalB);await listen(authority,port);
  await wait(()=>f.sends.includes('offline-message'));assert.equal(f.sends.filter(x=>x==='offline-message').length,1);
  assert.equal(f.starts.length,1);
  assert.equal((await api(b,`/delivery/${offlineId}`)).body.status,202);
  const list=await fetch(b.url+'/api/workspaces').then(r=>r.json()) as any[];assert.ok(!JSON.stringify(list).includes('token'));
  assert.equal((await api(a,'/access')).status,404);assert.equal((await api(a,'/skills','POST',{name:'x'})).status,400);
  const implicit=(await api(a,'/compose','POST',{text:`@implicit:${f.project} #claude runner-local-path`}));
  assert.equal(implicit.status,201);assert.equal(implicit.body.runner_id,task.runner_id);
  await wait(()=>f.starts.some(o=>o.prompt==='runner-local-path'));assert.equal(f.starts.find(o=>o.prompt==='runner-local-path')!.cwd,f.project);
  const home=await api(a,'/compose','POST',{text:'@home:~/ #claude runner-home-path'});assert.equal(home.status,201);
  await wait(()=>f.starts.some(o=>o.prompt==='runner-home-path'));assert.equal(f.starts.find(o=>o.prompt==='runner-home-path')!.cwd,homedir());
 }finally{streamController?.abort();for(const g of [...gateways])await closeGateway(g);await stop(authority);f.close();}
});

test('a committed command with a lost response retries once; permissions and workspace identity are scoped',async()=>{
 const f=fixture();const authority=f.runtime.workspace.server();const url=await listen(authority);
 const peer=f.runtime.workspace.grant('hub');const store=new Store(join(f.dir,'gateway.db'));let links=new WorkspaceLinks(store);
 try{
  const link=await links.attach({name:'runner',url,token:peer.token});
  const id=randomUUID();const op={id,method:'POST',path:'/compose',body:{text:`@one:shared@worker:${f.project} #claude once`}};
  // Process the operation as if the response was lost before the gateway could record it.
  f.runtime.workspace.execute(peer.id,op);
  links.enqueue(link.id,op);await links.flush(link.id);f.runtime.exchange();assert.equal(f.starts.length,1);
  assert.equal(f.runtime.hub.store.listTasks().length,1);
  assert.ok(!(store.database.prepare('SELECT payload FROM workspace_delivery WHERE id=?').get(id) as {payload:string}).payload.includes('once'));
  await links.close();links=new WorkspaceLinks(store);links.enqueue(link.id,op);await links.flush(link.id);assert.equal(f.runtime.hub.store.listTasks().length,1);
  assert.throws(()=>links.enqueue(link.id,{...op,body:{text:'different'}}),/내용/);
  assert.equal((await fetch(url+'/v1/read?path=/state')).status,401);
  assert.equal((await fetch(url+'/v1/read?path=/state',{headers:{authorization:`Bearer ${peer.token}`,'x-workspace-id':'wrong'}})).status,409);
  assert.equal((await fetch(url+'/v1/read?path=/state',{headers:{authorization:`Bearer ${peer.token}`,'x-workspace-id':f.runtime.workspace.id,origin:'http://evil'}})).status,403);
  const admin=new Store(join(f.dir,'runner','workspace.db'));new SharedWorkspace(undefined,admin).revoke(peer.id);admin.database.close();
  assert.equal((await fetch(url+'/v1/identity',{headers:{authorization:`Bearer ${peer.token}`}})).status,401);
  links.enqueue(link.id,{...op,id:randomUUID(),body:{text:'@one next'}});await links.flush(link.id);assert.equal(links.list()[0].pending,1);
  assert.throws(()=>links.remove(link.id),/미전달/);
 }finally{await links.close();store.database.close();await stop(authority);f.close();}
});

test('invalid queued input is rejected without blocking later input; only one runtime owns a workspace',async()=>{
 const f=fixture(),server=f.runtime.workspace.server();const url=await listen(server);
 const store=new Store(join(f.dir,'gateway.db')),links=new WorkspaceLinks(store);
 try{
  assert.throws(()=>new SharedRuntime(join(f.dir,'runner'),'shared@worker'),/이미 실행/);
  const peer=f.runtime.workspace.grant('hub'),link=await links.attach({name:'runner',url,token:peer.token});
  const rejected=randomUUID();links.enqueue(link.id,{id:rejected,method:'POST',path:'/compose',body:{text:123}});
  links.enqueue(link.id,{id:randomUUID(),method:'POST',path:'/compose',body:{text:`@ok:shared@worker:${f.project} #claude valid`}});
  await links.flush(link.id);f.runtime.exchange();
  assert.equal(links.deliveries(link.id).find(r=>r.id===rejected)!.status,400);
  assert.equal(f.starts.length,1);assert.equal(links.list()[0].pending,0);
  const failed=randomUUID();links.enqueue(link.id,{id:failed,method:'POST',path:'/compose',body:{text:'@missing retained-failed-input'}});await links.flush(link.id);
  assert.equal(links.deliveries(link.id).find(r=>r.id===failed)!.text,'@missing retained-failed-input');
  const credential=f.runtime.workspace.grant('stream');
  const stream=await fetch(url+'/v1/stream',{headers:{authorization:`Bearer ${credential.token}`,'x-workspace-id':f.runtime.workspace.id}});
  const reader=stream.body!.getReader();await reader.read();f.runtime.workspace.revoke(credential.id);
  assert.equal((await reader.read()).done,true);
 }finally{await links.close();store.database.close();await stop(server);f.close();}
});

test('the shipped shared CLI starts without a model turn and accepts independently granted hub credentials',async()=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {readFileSync}=await import('node:fs');const {createServer}=await import('node:net');
 const run=promisify(execFile);const dir=mkdtempSync(join(tmpdir(),'desk-shared-cli-'));
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
 const script=new URL('../../hub/src/runner/shared.ts',import.meta.url).pathname;
 const env={...process.env,AGENT_DESK_SHARED_DIR:dir,AGENT_DESK_SHARED_ADDRESS:'test@worker',AGENT_DESK_SHARED_PORT:String(port)};
 const processChild=spawn(process.execPath,[script],{env,stdio:['ignore','pipe','pipe']});let output='';processChild.stdout.on('data',b=>output+=b.toString());
 const exit=new Promise<void>(r=>processChild.once('exit',()=>r()));
 try{
  await wait(()=>output.includes('공유 러너:'));
  const tokens:string[]=[];
  for(const name of ['a','b']){
   const file=join(dir,name+'.token');const response=await run(process.execPath,[script,'grant',name,file],{env});
   tokens.push(readFileSync(file,'utf8').trim());assert.ok(!response.stdout.includes(tokens.at(-1)!));
  }
  const replies=await Promise.all(tokens.map(token=>fetch(`http://127.0.0.1:${port}/v1/identity`,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.json() as Promise<any>)));
  assert.equal(replies[0].workspace_id,replies[1].workspace_id);
  const state=await fetch(`http://127.0.0.1:${port}/v1/read?path=/state`,{headers:{authorization:`Bearer ${tokens[0]}`,'x-workspace-id':replies[0].workspace_id}}).then(r=>r.json() as Promise<any>);
  assert.equal(state.tasks.length,0);assert.equal(state.runner.connected,true);
 }finally{processChild.kill('SIGTERM');await exit;rmSync(dir,{recursive:true,force:true});}
});

test('shared task creation preserves the standard default approval mode',()=>{
 const f=fixture();try{
  const peer=f.runtime.workspace.grant('api');
  const project=f.runtime.workspace.execute(peer.id,{id:randomUUID(),method:'POST',path:'/projects',body:{name:'standard',root_path:`shared@worker:${f.project}`}}).body;
  const result=f.runtime.workspace.execute(peer.id,{id:randomUUID(),method:'POST',path:'/tasks',body:{project_id:project.id,prompt:'mode test',permission_mode:'default'}});
  assert.equal(result.status,201);f.runtime.exchange();assert.equal(f.starts[0].permissionMode,'default');
 }finally{f.close();}
});

test('shutdown leaves an undispatched start for exactly one execution after runtime restart',()=>{
 const f=fixture();let restarted:SharedRuntime|undefined;let starts=0,closes=0;
 try{
  const peer=f.runtime.workspace.grant('shutdown');
  const op={id:randomUUID(),method:'POST',path:'/compose',body:{text:`@pending:shared@worker:${f.project} #claude restart safely`}};
  f.runtime.workspace.execute(peer.id,op);
  assert.equal(f.starts.length,0);
  f.runtime.close();f.runtime.exchange();f.runtime.close();
  assert.equal(f.starts.length,0);assert.equal(f.runtime.agent.runner.snapshot().length,0);
  restarted=new SharedRuntime(join(f.dir,'runner'),'shared@worker',{start:o=>{
   starts++;o.emit({type:'busy',sessionId:o.sessionId,busy:true});
   return {send:()=>{},close:()=>{closes++;},resolveApproval:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{}};
  }});
  assert.equal(starts,1);
  restarted.workspace.execute(peer.id,op);restarted.exchange();assert.equal(starts,1);
  restarted.close();assert.equal(closes,1);assert.equal(restarted.agent.runner.snapshot().length,0);
 }finally{restarted?.close();f.close();}
});

test('runtime restart reports the interrupted turn and resumes queued input once in order',()=>{
 const f=fixture();let restarted:SharedRuntime|undefined;
 const resumed:StartOptions[]=[],sent:string[]=[];
 try{
  const peer=f.runtime.workspace.grant('restart');
  const execute=(path:string,body:Record<string,unknown>)=>f.runtime.workspace.execute(peer.id,{id:randomUUID(),method:'POST',path,body});
  const task=execute('/compose',{text:`@restart:shared@worker:${f.project} #claude interrupted-current-turn`}).body;
  f.runtime.exchange();
  execute(`/tasks/${task.id}/messages`,{text:'queued-first'});
  execute(`/tasks/${task.id}/messages`,{text:'queued-second'});
  assert.deepEqual(f.runtime.hub.store.queued().map(q=>q.text),['queued-first','queued-second']);
  f.runtime.close();
  restarted=new SharedRuntime(join(f.dir,'runner'),'shared@worker',{start:o=>{
   resumed.push(o);o.emit({type:'busy',sessionId:o.sessionId,busy:true});
   return {send:text=>{sent.push(text);o.emit({type:'busy',sessionId:o.sessionId,busy:true});},close:()=>{},resolveApproval:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{}};
  }});
  assert.equal(resumed.length,1);assert.equal(resumed[0].prompt,'queued-first');assert.equal(resumed[0].resume,'fixture');
  assert.deepEqual(restarted.hub.store.queued().map(q=>q.text),['queued-second']);
  const statuses=restarted.hub.store.listEvents(task.id).filter(e=>e.kind==='status').map(e=>e.payload as {state?:string;detail?:{reason?:string}});
  assert.ok(statuses.some(p=>p.state==='error'&&p.detail?.reason==='runner_shutdown'));
  assert.ok(!statuses.some(p=>p.state==='queue_dropped'));
  restarted.exchange();assert.equal(resumed.length,1);assert.deepEqual(sent,[]);
  resumed[0].emit({type:'busy',sessionId:resumed[0].sessionId,busy:false});restarted.exchange();
  assert.deepEqual(sent,['queued-second']);assert.equal(restarted.hub.store.queued().length,0);
  restarted.exchange();assert.equal(resumed.length,1);assert.deepEqual(sent,['queued-second']);
  assert.equal(f.starts.length,1);assert.equal(f.starts[0].prompt,'interrupted-current-turn');
 }finally{restarted?.close();f.close();}
});

test('failed runtime initialization releases its workspace lease for a corrected retry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'desk-workspace-init-'));let runtime:SharedRuntime|undefined;
 try{
  assert.throws(()=>new SharedRuntime(dir,'invalid/address'),/호스트/);
  runtime=new SharedRuntime(dir,'shared@worker');
  assert.equal(runtime.hub.remotes.list()[0].address,'shared@worker');
 }finally{runtime?.close();rmSync(dir,{recursive:true,force:true});}
});

test('pending delivery limit counts UTF-8 bytes for Korean input',async()=>{
 const f=fixture(),server=f.runtime.workspace.server(),url=await listen(server);
 const store=new Store(join(f.dir,'gateway.db')),links=new WorkspaceLinks(store);
 try{
  const peer=f.runtime.workspace.grant('limit'),link=await links.attach({name:'runner',url,token:peer.token});
  const make=()=>({id:randomUUID(),method:'POST',path:'/compose',body:{text:'가'.repeat(600000)}});
  for(let i=0;i<18;i++)links.enqueue(link.id,make());
  const rejected=make();assert.throws(()=>links.enqueue(link.id,rejected),(e:any)=>e.status===429);
  const row=store.database.prepare('SELECT count(*) n,sum(length(CAST(payload AS BLOB))) bytes FROM workspace_delivery').get() as {n:number;bytes:number};
  assert.equal(row.n,18);assert.ok(row.bytes<=32*1024*1024);
  assert.ok(row.bytes+Buffer.byteLength(JSON.stringify(rejected))>32*1024*1024);
 }finally{await links.close();store.database.close();await stop(server);f.close();}
});

test('revoking a peer while its request body is arriving prevents the operation',async()=>{
 const f=fixture(),server=f.runtime.workspace.server(),url=await listen(server);
 try{
  const peer=f.runtime.workspace.grant('slow-body');
  const payload=JSON.stringify({id:randomUUID(),method:'POST',path:'/projects',body:{name:'revoked',root_path:`shared@worker:${f.project}`}});
  const received=new Promise<void>(resolve=>server.once('request',()=>resolve()));
  let req:ReturnType<typeof request>;
  const response=new Promise<{status:number;body:any}>((resolve,reject)=>{
   req=request(url+'/v1/operation',{method:'POST',headers:{authorization:`Bearer ${peer.token}`,'x-workspace-id':f.runtime.workspace.id,'content-type':'application/json'}},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));res.on('error',reject);
   });req.on('error',reject);req.write(payload.slice(0,20));
  });
  await received;f.runtime.workspace.revoke(peer.id);req!.end(payload.slice(20));
  assert.equal((await response).status,401);assert.equal(f.runtime.hub.store.listProjects().length,0);
  assert.equal(f.runtime.hub.store.database.prepare('SELECT count(*) n FROM workspace_receipt').get()!.n,0);
 }finally{await stop(server);f.close();}
});

test('workspace mismatch preserves queued input until recovery while business conflicts finish',async()=>{
 const f=fixture(),server=f.runtime.workspace.server(),url=await listen(server);
 const store=new Store(join(f.dir,'gateway.db')),links=new WorkspaceLinks(store);
 try{
  const peer=f.runtime.workspace.grant('identity'),link=await links.attach({name:'runner',url,token:peer.token});
  const original={id:randomUUID(),method:'POST',path:'/projects',body:{name:'original',root_path:`shared@worker:${f.project}`}};
  f.runtime.workspace.execute(peer.id,original);
  links.enqueue(link.id,{...original,body:{...original.body,name:'conflicting'}});
  links.enqueue(link.id,{...original,id:randomUUID(),body:{...original.body,name:'after recovery'}});
  store.database.prepare('UPDATE workspace_link SET workspace_id=? WHERE id=?').run('wrong',link.id);
  const response=await fetch(url+'/v1/read?path=/state',{headers:{authorization:`Bearer ${peer.token}`,'x-workspace-id':'wrong'}});
  assert.equal(response.status,409);assert.equal((await response.json() as any).code,'workspace_mismatch');
  await links.flush(link.id);assert.equal(links.list()[0].pending,2);assert.equal(f.runtime.hub.store.listProjects().length,1);
  store.database.prepare('UPDATE workspace_link SET workspace_id=? WHERE id=?').run(f.runtime.workspace.id,link.id);
  await links.flush(link.id);assert.equal(links.list()[0].pending,0);
  assert.equal(links.deliveries(link.id).find(d=>d.id===original.id)!.status,409);
  assert.equal(f.runtime.hub.store.listProjects().length,2);
 }finally{await links.close();store.database.close();await stop(server);f.close();}
});


test('workspace view indices survive restarts without consuming sequence numbers and are never reused',async()=>{
 const store=new Store(':memory:');let links=new WorkspaceLinks(store);
 try {
   store.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run('a','a','http://localhost/','wa','secret');
   for(let i=0;i<10;i++){await links.close();links=new WorkspaceLinks(store);assert.equal(links.list()[0].view_index,1);}
   store.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run('b','b','http://localhost/','wb','secret');
   await links.close();links=new WorkspaceLinks(store);assert.equal(links.list().find(l=>l.id==='b')!.view_index,2);
   links.remove('a');store.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run('c','c','http://localhost/','wc','secret');
   await links.close();links=new WorkspaceLinks(store);assert.equal(links.list().find(l=>l.id==='c')!.view_index,3);
 }finally{await links.close();store.database.close();}
});
