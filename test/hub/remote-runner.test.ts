import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { RemoteJournal } from '../../hub/src/runner/remote-journal.ts';
import { RemoteAgent } from '../../hub/src/runner/remote-agent.ts';
import type { RunnerPort } from '../../hub/src/runner/client.ts';
import type { StartOptions } from '../../hub/src/runner/engine.ts';
import type { HubToRunner, RunnerToHub } from '../../shared/protocol.ts';
import type { RemoteExchange } from '../../shared/remote.ts';
import { remoteLocation } from '../../shared/remote.ts';

function setup() {
  const dir=mkdtempSync(join(tmpdir(),'desk-remote-'));
  const store=new Store(join(dir,'hub.db'));
  let localSay!: (m:RunnerToHub)=>void;
  const localSent:HubToRunner[]=[];
  const local:RunnerPort={connected:true,id:'local-test',engines:new Set(['codex']),has:()=>true,handle:m=>{localSent.push(m);}};
  const skills=new SkillStore(join(dir,'hub-skills'));
  skills.create('parent','fixture');
  skills.writeFile('parent','SKILL.md','---\nname: parent\ndescription: fixture\n---\nUse #child when needed.');
  skills.create('child','child fixture');
  const makeHub=()=>new Hub(store,{skills,runner:onMessage=>{localSay=onMessage;return local;},graceMs:60_000});
  const hub=makeHub();
  const registered=hub.remotes.register('moohnam@ws20');
  store.database.prepare('UPDATE remote_runner SET skill_snapshot=1 WHERE id=?').run(registered.runner.id);
  const journal=new RemoteJournal(join(dir,'runner.db'));
  const starts:StartOptions[]=[],sent:string[]=[];
  const agent=new RemoteAgent(journal,registered.runner.id,join(dir,'remote-skills'),opts=>{
    starts.push(opts);opts.emit({type:'engine_session',sessionId:opts.sessionId,engineSessionId:'engine-'+starts.length});
    opts.emit({type:'busy',sessionId:opts.sessionId,busy:true});
    return {send:text=>{sent.push(text);opts.emit({type:'busy',sessionId:opts.sessionId,busy:true});},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval:()=>{},close:()=>{}};
  });
  function request():RemoteExchange {
    const events=journal.events();
    return {version:1,journalId:journal.id,commandAck:journal.commandAck,events,more:journal.lastEvent>(events.at(-1)?.seq??journal.eventAck),sessions:agent.runner.snapshot(),engines:['codex'],skillSnapshot:true};
  }
  function exchange(target=hub) {
    const input=request();
    const reply=target.atomic(()=>target.remotes.exchange(registered.runner.id,input));
    journal.acknowledge(reply.eventAck,input.events.at(-1)?.seq??journal.eventAck);
    journal.receive(reply.commands);agent.pump();return reply;
  }
  function finish() { starts.at(-1)!.emit({type:'busy',sessionId:starts.at(-1)!.sessionId,busy:false}); }
  function cleanup() { for(const s of agent.runner.snapshot())agent.runner.handle({type:'close',sessionId:s.sessionId});hub.remotes.close();journal.close();store.database.close();rmSync(dir,{recursive:true,force:true}); }
  return {hub,store,dir,skills,makeHub,registered,journal,starts,sent,agent,localSent,localSay:(m:RunnerToHub)=>localSay(m),request,exchange,finish,cleanup};
}

test('remote paths identify a machine and directory without shell evaluation',()=>{
  assert.deepEqual(remoteLocation('moohnam@ws20:~/project'),{address:'moohnam@ws20',path:'~/project'});
  assert.deepEqual(remoteLocation('ws20:~/project'),{address:'ws20',path:'~/project'});
  assert.deepEqual(remoteLocation('ws20:/srv/project'),{address:'ws20',path:'/srv/project'});
  assert.equal(remoteLocation('/local/project'),null);
  assert.equal(remoteLocation('relative/path'),null);
  assert.equal(remoteLocation('./ws20:~/project'),null);
  assert.equal(remoteLocation('../ws20:~/project'),null);
  assert.equal(remoteLocation('~/ws20:~/project'),null);
  assert.throws(()=>remoteLocation('-o@host:/tmp'));
  assert.throws(()=>remoteLocation('-o:/tmp'));
  assert.throws(()=>remoteLocation('user@host:relative'));
  assert.throws(()=>remoteLocation('ws20:relative'));
});

test('a host-only project path selects its registered account and pins it across new registrations',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:ws20:${t.dir} #codex start`);
    const project=t.store.getProject(task.project_id)!;
    assert.equal(project.root_path,`moohnam@ws20:${t.dir}`);
    assert.equal(t.store.latestSession(task.id)!.runner_id,t.registered.runner.id);
    assert.equal(t.localSent.length,0);
    t.exchange();t.exchange();assert.equal(t.starts[0].cwd,t.dir);
    t.finish();t.exchange();
    t.hub.remotes.register('another@ws20');
    const next=t.hub.compose('@remote #new #codex same registered account');
    assert.equal(t.store.latestSession(next.id)!.runner_id,t.registered.runner.id);
    t.exchange();assert.equal(t.starts.length,2);assert.equal(t.localSent.length,0);
    const explicit=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex explicit`);
    assert.equal(explicit.project_id,project.id);
    assert.equal(t.store.listProjects().length,1);
  }finally{t.cleanup();}
});

test('unknown, malformed and ambiguous host paths never start work locally',()=>{
  const t=setup();try{
    assert.throws(()=>t.hub.compose(`@unknown:missing-host:${t.dir} #codex start`),/먼저 등록/);
    assert.throws(()=>t.hub.compose('@bad:ws20:relative #codex start'),/원격 경로/);
    const other=t.hub.remotes.register('another@ws20').runner;
    // An online peer must not win over another account merely because that one is offline.
    t.store.database.prepare('UPDATE remote_runner SET last_seen=? WHERE id=?').run(new Date().toISOString(),t.registered.runner.id);
    assert.throws(()=>t.hub.compose(`@ambiguous:ws20:${t.dir} #codex start`),/러너가 여러 개/);
    assert.throws(()=>t.hub.compose(`@wrong:unknown@ws20:${t.dir} #codex start`),/먼저 등록/);
    assert.equal(t.store.listProjects().length,0);assert.equal(t.store.listTasks().length,0);
    assert.equal(t.localSent.length,0);
    const task=t.hub.compose(`@explicit:another@ws20:${t.dir} #codex start`);
    assert.equal(t.store.latestSession(task.id)!.runner_id,other.id);
    assert.equal(t.localSent.length,0);
  }finally{t.cleanup();}
});

test('runner registration and direct project creation accept host-only addresses',()=>{
  const t=setup();try{
    const peer=t.hub.remotes.register('build-server').runner;
    const project=t.hub.createProject('host-only',`build-server:${t.dir}`);
    assert.equal(project.root_path,`build-server:${t.dir}`);
    const task=t.hub.compose('@host-only #codex start');
    assert.equal(t.store.latestSession(task.id)!.runner_id,peer.id);
    const reply=t.hub.atomic(()=>t.hub.remotes.exchange(peer.id,{version:1,journalId:'bare-host-fixture',commandAck:0,events:[],more:false,sessions:[],engines:['codex']}));
    assert.equal(reply.commands[0].value.type,'start');
    if(reply.commands[0].value.type==='start')assert.equal(reply.commands[0].value.cwd,t.dir);
    const another=t.hub.remotes.register('another@build-server').runner;
    const next=t.hub.compose('@host-only #new #codex still the named runner');
    assert.equal(t.store.latestSession(next.id)!.runner_id,peer.id);
    const named=t.hub.compose(`@named:build-server:${t.dir} #codex exact name`);
    assert.equal(t.store.latestSession(named.id)!.runner_id,peer.id);
    const account=t.hub.compose(`@account:another@build-server:${t.dir} #codex explicit account`);
    assert.equal(t.store.latestSession(account.id)!.runner_id,another.id);
    assert.throws(()=>t.hub.compose(`@wrong-account:unknown@build-server:${t.dir} #codex start`),/먼저 등록/);
    assert.equal(t.localSent.length,0);
    const aliasProject=t.hub.createProject('alias-api',`ws20:${t.dir}`);
    assert.equal(aliasProject.root_path,`moohnam@ws20:${t.dir}`);
  }finally{t.cleanup();}
});

test('remote project starts on its registered runner; skills and session owner stay remote',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex #parent start`);
    assert.equal(t.localSent.length,0);
    const session=t.store.latestSession(task.id)!;
    assert.equal(session.runner_id,t.registered.runner.id);
    assert.equal(t.hub.taskView(t.store.getTask(task.id)!).delivery_pending,1);
    t.exchange();assert.equal(t.starts.length,1);assert.equal(t.starts[0].cwd,t.dir);
    assert.notEqual(t.starts[0].skillsHome,t.skills.home);
    assert.ok(t.starts[0].skillSnapshotHome);
    assert.ok(new SkillStore(t.starts[0].skillSnapshotHome).get('child'));
    t.exchange();assert.equal(t.hub.remotes.list()[0].pending,0);
    assert.equal(t.store.latestSession(task.id)!.engine_session_id,'engine-1');
  }finally{t.cleanup();}
});

test('remote command keeps the accepted skill version while delivery waits',()=>{
  const t=setup();try{
    t.skills.writeFile('child','scripts/run.sh','#!/bin/sh\necho one\n',true);
    t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex #parent start`);
    t.skills.writeFile('child','scripts/run.sh','#!/bin/sh\necho two\n',true);
    const command=t.exchange().commands.find(item=>item.value.type==='start')?.value;
    assert.equal(command?.type,'start');
    if(command?.type==='start')assert.match(command.skillSnapshot?.files.find(f=>f.name==='child'&&f.path==='scripts/run.sh')?.content??'',/echo one/);
    assert.ok(t.starts[0].skillSnapshotHome);
    assert.match(readFileSync(join(t.starts[0].skillSnapshotHome!,'skills','child','scripts','run.sh'),'utf8'),/echo one/);
  }finally{t.cleanup();}
});

test('an old remote runner accepts plain work but cannot receive pinned skill commands',()=>{
  const t=setup();try{
    const old=t.hub.remotes.register('old@ws20');
    const plain=t.hub.compose(`@old:old@ws20:${t.dir} #codex plain`);
    assert.equal(t.store.latestSession(plain.id)?.runner_id,old.runner.id);
    assert.throws(()=>t.hub.compose(`@old:old@ws20:${t.dir} #codex #parent pinned`),/고정 스킬 버전/);
    assert.equal(t.store.listTasks().filter(task=>task.project_id===plain.project_id).length,1);
    const pinned=t.hub.compose(`@new:moohnam@ws20:${t.dir} #codex #parent pinned`);
    const oldExchange={...t.request(),skillSnapshot:false};
    const reply=t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,oldExchange));
    assert.deepEqual(reply.commands,[]);
    assert.equal(t.hub.remotes.pendingFor(t.store.latestSession(pinned.id)!.id),1);
    assert.throws(()=>t.hub.sendMessage(pinned.id,'#parent next'),/고정 스킬 버전/);
    t.exchange();
    assert.equal(t.starts.length,1);
  }finally{t.cleanup();}
});

test('a queued skill input stays queued across an old remote exchange and drains after an upgrade',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex plain`);
    t.exchange();t.exchange();
    t.hub.sendMessage(task.id,'#parent queued');
    assert.equal(t.store.queued({taskId:task.id}).length,1);
    t.finish();
    const input={...t.request(),skillSnapshot:false};
    const old=t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,input));
    assert.deepEqual(old.commands,[]);
    assert.equal(t.store.queued({taskId:task.id}).length,1);
    t.exchange();
    assert.equal(t.store.queued({taskId:task.id}).length,0);
    t.exchange();
    assert.deepEqual(t.sent,['queued']);
  }finally{t.cleanup();}
});

test('remote Codex skill steering preserves the message and leaves skill paths to the remote adapter',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex initial`);
    t.exchange();t.exchange();
    assert.equal(t.agent.runner.snapshot()[0].busy,true);
    t.hub.sendMessage(task.id,'#parent 이어서 진행 #now');
    const command=t.exchange().commands.find(c=>c.value.type==='send')!.value;
    assert.equal(command.type,'send');
    if(command.type!=='send')throw new Error('expected send command');
    assert.equal(command.text,'이어서 진행');
    assert.deepEqual(command.skills,['parent']);
    assert.equal(command.steer,true);
    assert.ok(!command.text.includes(t.skills.home));
    assert.ok(!command.text.includes('[데스크 스킬]'));
    assert.deepEqual(t.sent,['이어서 진행']);
    assert.equal(t.localSent.length,0);
  }finally{t.cleanup();}
});

test('offline input is retained, output replayed once, and later turns keep their order',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex start`);
    t.exchange();t.exchange();
    t.store.database.prepare('UPDATE remote_runner SET last_seen=NULL').run();
    const receipt:{queued_id?:string}={};
    t.hub.sendMessage(task.id,'second',false,receipt);t.hub.sendMessage(task.id,'third');
    assert.ok(receipt.queued_id);assert.equal(t.store.queued().length,2);
    t.starts[0].emit({type:'event',sessionId:t.starts[0].sessionId,event:{kind:'assistant',text:'offline result'}});
    t.finish();
    const input=t.request();
    // Lose the HTTP response after the hub commits, then retry the identical request.
    t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,input));
    t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,input));
    assert.equal(t.store.listEvents(task.id).filter(e=>e.kind==='assistant').length,1);
    assert.equal(t.store.queued().length,1,'an unacknowledged send still counts as busy');
    t.exchange();assert.deepEqual(t.sent,['second']);
    t.exchange();t.finish();t.exchange();assert.deepEqual(t.sent,['second','third']);
    assert.equal(t.starts.length,1,'same surviving session, not a new CLI process');
  }finally{t.cleanup();}
});

test('a hub restart preserves commands and never marks another runner session lost',()=>{
  const t=setup();let next:Hub|undefined;try{
    const localTask=t.hub.compose(`@local:${t.dir} #codex local`);
    const remoteTask=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex remote`);
    t.hub.remotes.close();next=t.makeHub();
    t.exchange(next);t.exchange(next);
    assert.equal(t.starts.length,1);
    assert.equal(t.store.getTask(localTask.id)!.status,'running');
    t.localSay({type:'hello',runnerId:'local-test',host:'test',capabilities:{engines:['codex'],close:true},sessions:[]});
    assert.equal(t.store.getTask(remoteTask.id)!.status,'running');
    assert.equal(t.store.getTask(localTask.id)!.status,'error');
  }finally{next?.remotes.close();t.cleanup();}
});

test('a missing remote session settles its running question while pending starts stay protected',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);t.exchange();t.exchange();
    const asker=t.hub.external.attachExternal({title:'asker',summary:'question',cwd:t.dir});
    const question=t.hub.requests.request({to:task.id,text:'status?',fromTaskId:asker.id});
    t.hub.resolveApproval(question.approval_id!,true);
    t.exchange();t.exchange();
    assert.equal(t.store.getRequest(question.id)?.status,'running');
    const missing={...t.request(),sessions:[]};
    t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,missing));
    assert.equal(t.store.getRequest(question.id)?.status,'failed');
    assert.equal(t.store.getTask(task.id)?.status,'error');
    const pending=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex second`);
    const beforeStart={...t.request(),sessions:[]};
    t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,beforeStart));
    assert.equal(t.store.getTask(pending.id)?.status,'running');
  }finally{t.cleanup();}
});

test('runner receipts survive restart, duplicates execute once, and ambiguous dispatch is not repeated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-inbox-'));const path=join(dir,'runner.db');
  let journal=new RemoteJournal(path);
  const command:HubToRunner={type:'start',sessionId:'fixture',engine:'codex',cwd:dir,prompt:'start',permissionMode:'default'};
  try{
    journal.receive([{seq:1,value:command}]);const id=journal.id;journal.close();journal=new RemoteJournal(path);
    assert.equal(journal.id,id);assert.equal(journal.commandAck,1);
    let starts=0;
    const make=()=>new RemoteAgent(journal,'remote-test',join(dir,'skills'),()=>{starts++;return {send:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval:()=>{},close:()=>{}};});
    let agent=make();agent.pump();journal.receive([{seq:1,value:command}]);agent.pump();assert.equal(starts,1);
    journal.receive([{seq:2,value:{...command,sessionId:'ambiguous'}}]);journal.dispatching(2);
    journal.close();journal=new RemoteJournal(path);agent=make();agent.pump();assert.equal(starts,1);
    assert.ok(journal.events().some(e=>e.value.type==='event'&&JSON.stringify(e.value).includes('자동 재실행하지 않았습니다')));
    journal.bind('https://hub.example/','runner-a');assert.throws(()=>journal.bind('https://hub.example/','runner-b'));
  }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('runner credentials and event/snapshot ownership are isolated; gaps and changed journals are refused',()=>{
  const t=setup();try{
    const a=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex remote`);
    const b=t.hub.compose(`@local:${t.dir} #codex local`);
    assert.ok(t.hub.remotes.accepts(t.registered.runner.id,t.registered.token));
    assert.ok(!t.hub.remotes.accepts(t.registered.runner.id,'wrong'));
    const sid=t.store.latestSession(b.id)!.id;
    const bad={...t.request(),events:[{seq:1,value:{type:'busy' as const,sessionId:sid,busy:false}}]};
    assert.throws(()=>t.hub.remotes.exchange(t.registered.runner.id,bad),/다른/);
    const own=t.store.latestSession(a.id)!.id;
    assert.throws(()=>t.hub.remotes.exchange(t.registered.runner.id,{...t.request(),events:[{seq:2,value:{type:'busy',sessionId:own,busy:false}}]}),/이벤트 1/);
    t.exchange();assert.throws(()=>t.hub.remotes.exchange(t.registered.runner.id,{...t.request(),journalId:'new-db'}),/DB가 바뀌었/);
    assert.throws(()=>t.hub.remotes.exchange(t.registered.runner.id,{...t.request(),commandAck:999}),/형식/);
  }finally{t.cleanup();}
});

test('HTTP runner token cannot manage the desk; a real remote process keeps running through failed exchanges', {timeout:25000}, async()=>{
  const { createHttpServer }=await import('../../hub/src/http.ts');
  const { HttpError }=await import('../../hub/src/errors.ts');
  const { spawn }=await import('node:child_process');
  const { once }=await import('node:events');
  const { writeFileSync,readFileSync,existsSync }=await import('node:fs');
  const { resolve }=await import('node:path');
  const t=setup();
  let blocked=false;
  const original=t.hub.remotes.exchange.bind(t.hub.remotes);
  t.hub.remotes.exchange=(id,input)=>{if(blocked)throw new HttpError(503,'simulated offline');return original(id,input);};
  const access={isLocal:()=>false,hostAllowed:()=>true,matches:()=>false,identify:()=>null} as unknown as import('../../hub/src/access.ts').Access;
  const server=createHttpServer(t.hub,access,t.dir);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const peer=t.registered.runner.id;
  const tokenFile=join(t.dir,'remote-token'), capture=join(t.dir,'cli.jsonl'),release=join(t.dir,'release');
  const cli=join(t.dir,'fake-codex');
  writeFileSync(tokenFile,t.registered.token,{mode:0o600});
  writeFileSync(cli,`#!/usr/bin/env node
import {appendFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
const write=m=>console.log(JSON.stringify(m));
let count=0;
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);appendFileSync(process.env.TEST_CAPTURE,line+'\\n');if(r.id==null)continue;
 const result=r.method.startsWith('thread/')?{thread:{id:'remote-cli-thread'}}:r.method==='turn/start'?{turn:{id:'turn-'+(++count)}}:{};
 write({id:r.id,result});
 if(r.method==='turn/start'){
   const id=result.turn.id, text=r.params.input.filter(i=>i.type==='text').map(i=>i.text).join(' ');
   const timer=setInterval(()=>{if(!existsSync(process.env.TEST_RELEASE))return;clearInterval(timer);
     write({method:'item/completed',params:{threadId:'remote-cli-thread',item:{type:'agentMessage',text:'finished '+text}}});
     write({method:'turn/completed',params:{threadId:'remote-cli-thread',turn:{id,status:'completed'}}});
   },20);
 }
}
`,{mode:0o755});
  let errors='';
  const child=spawn(process.execPath,[resolve('hub/src/runner/remote.ts')],{cwd:t.dir,env:{...process.env,
    AGENT_DESK_HUB_URL:base,AGENT_DESK_RUNNER_ID:peer,AGENT_DESK_REMOTE_TOKEN_FILE:tokenFile,
    AGENT_DESK_REMOTE_DB:join(t.dir,'process.db'),AGENT_DESK_DB:join(t.dir,'unused.db'),
    AGENT_DESK_SKILLS_HOME:join(t.dir,'process-skills'),CODEX_BIN:cli,TEST_CAPTURE:capture,TEST_RELEASE:release},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',b=>{errors+=b.toString();});
  const wait=async(check:()=>boolean)=>{const until=Date.now()+9000;while(!check()){assert.equal(child.exitCode,null,errors);if(Date.now()>until)throw Error('remote process timeout: '+errors);await new Promise(r=>setTimeout(r,40));}};
  try{
    const auth={authorization:`Bearer ${t.registered.token}`,'content-type':'application/json'};
    assert.equal((await fetch(base+'/api/state',{headers:auth})).status,401);
    assert.equal((await fetch(base+`/api/runners/${peer}/exchange`,{method:'POST',headers:{...auth,authorization:'Bearer wrong'},body:'{}'})).status,401);
    assert.equal((await fetch(base+`/api/runners/other/exchange`,{method:'POST',headers:auth,body:'{}'})).status,401);
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);
    await wait(()=>existsSync(capture)&&readFileSync(capture,'utf8').includes('turn/start'));
    blocked=true;t.store.database.prepare('UPDATE remote_runner SET last_seen=NULL').run();
    t.hub.sendMessage(task.id,'second');assert.equal(t.store.queued().length,1);
    writeFileSync(release,'finish');
    await new Promise(r=>setTimeout(r,1300));
    assert.equal(t.store.listEvents(task.id).filter(e=>e.kind==='assistant').length,0,'offline result is not yet at hub');
    blocked=false;
    await wait(()=>t.store.listEvents(task.id).filter(e=>e.kind==='assistant').length===2);
    const text=t.store.listEvents(task.id).filter(e=>e.kind==='assistant').map(e=>(e.payload as {text:string}).text);
    assert.deepEqual(text,['finished first','finished second']);
    const calls=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.filter(r=>r.method==='thread/start').length,1);
    assert.equal(calls.filter(r=>r.method==='turn/start').length,2);
    const rotated=t.hub.remotes.rotate(peer);
    writeFileSync(tokenFile,rotated.token,{mode:0o600});
    await wait(()=>t.hub.remotes.list()[0].connected);
    assert.equal(readFileSync(capture,'utf8').split('thread/start').length-1,1,'token reload does not restart the CLI');
  }finally{
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([once(child,'exit'),new Promise(r=>{timer=setTimeout(r,11000);})]);
    clearTimeout(timer);
    if(child.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections();server.close();t.cleanup();
  }
});

test('deleting an offline task cancels its pending start; token rotation preserves the delivery DB binding',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex never start`);
    t.hub.deleteTask(task.id);t.exchange();assert.equal(t.starts.length,0);
    const changed=t.hub.remotes.rotate(t.registered.runner.id);
    assert.equal(t.hub.remotes.accepts(t.registered.runner.id,t.registered.token),false);
    assert.equal(t.hub.remotes.accepts(t.registered.runner.id,changed.token),true);
    t.exchange();assert.equal(t.starts.length,0);
  }finally{t.cleanup();}
});

test('one process owns a runner journal and invalid commands are not receipted',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-lease-')),path=join(dir,'state.db');
  const a=new RemoteJournal(path),b=new RemoteJournal(path);
  try{
    a.claim();assert.throws(()=>b.claim(),/이미 실행/);
    assert.throws(()=>b.receive([{seq:1,value:{type:'send',sessionId:'x',text:42} as unknown as HubToRunner}]));
    assert.equal(b.commandAck,0);
  }finally{b.close();a.close();rmSync(dir,{recursive:true,force:true});}
});

test('multi-page offline reports finish before new commands are sent and preserve source timestamps',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);t.exchange();t.exchange();
    t.store.database.prepare('UPDATE remote_runner SET last_seen=NULL').run();
    t.hub.sendMessage(task.id,'after backlog');
    for(let i=0;i<100;i++)t.starts[0].emit({type:'event',sessionId:t.starts[0].sessionId,event:{kind:'assistant',text:'report '+i}});
    t.finish();
    const input=t.request();assert.equal(input.more,true);input.events[0].created_at='2026-11-08T00:00:00.000Z';
    const reply=t.hub.atomic(()=>t.hub.remotes.exchange(t.registered.runner.id,input));
    assert.equal(reply.commands.length,0);assert.equal(t.store.queued().length,1);
    t.journal.acknowledge(reply.eventAck,input.events.at(-1)!.seq);
    assert.equal(t.store.listEvents(task.id).find(e=>e.kind==='assistant')!.ts,'2026-11-08T00:00:00.000Z');
    t.exchange();assert.deepEqual(t.sent,['after backlog']);
    assert.equal(t.store.listEvents(task.id).filter(e=>e.kind==='assistant').length,100);
  }finally{t.cleanup();}
});

test('a failed outbox commit rolls back the accepted message and task together',()=>{
  const t=setup();try{
    t.store.database.exec("CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON remote_command BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
    assert.throws(()=>t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`),/test disk failure/);
    assert.equal(t.store.listTasks().length,0);assert.equal(t.store.listProjects().length,0);
    assert.equal(t.hub.busy.size,0);
    t.store.database.exec('DROP TRIGGER fail_delivery');
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);t.exchange();t.exchange();t.finish();t.exchange();
    const count=t.store.listEvents(task.id).length;
    t.store.database.exec("CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON remote_command BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
    assert.throws(()=>t.hub.sendMessage(task.id,'must not vanish'),/test disk failure/);
    assert.equal(t.store.listEvents(task.id).length,count);
  }finally{t.cleanup();}
});

test('an offline answer resolves the known question and an offline reset waits for the surviving session',()=>{
  const t=setup();try{
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);t.exchange();t.exchange();
    const sid=t.starts[0].sessionId;
    t.starts[0].emit({type:'approval_request',sessionId:sid,approvalId:'question-id',toolName:'AskUserQuestion',input:{questions:[{question:'Which?',options:[]}]}});
    t.exchange();t.store.database.prepare('UPDATE remote_runner SET last_seen=NULL').run();
    const receipt:{answered?:boolean}={};t.hub.sendMessage(task.id,'my answer',false,receipt);
    assert.equal(receipt.answered,true);assert.equal(t.store.queued().length,0);
    assert.equal(t.store.getApproval('question-id')!.status,'allowed');
    t.hub.resetContext(task.id,'new context');assert.equal(t.store.queued().length,1);
    assert.equal(t.store.latestSession(task.id)!.id,sid);
    t.exchange();t.exchange();t.finish();t.exchange();
    assert.equal(t.starts.length,2);assert.notEqual(t.starts[1].sessionId,sid);
    assert.equal(t.store.latestSession(task.id)!.runner_id,t.registered.runner.id);
  }finally{t.cleanup();}
});

test('a reply before the pending remote start is received queues behind that first turn',()=>{
  const t=setup();try{
    t.exchange();
    const task=t.hub.compose(`@remote:moohnam@ws20:${t.dir} #codex first`);
    t.hub.sendMessage(task.id,'immediate-follow-up');
    assert.equal(t.store.queued({taskId:task.id}).length,1);
    t.exchange();t.exchange();
    assert.equal(t.starts.length,1);assert.equal(t.sent.length,0);
    t.finish();t.exchange();
    assert.deepEqual(t.sent,['immediate-follow-up']);assert.equal(t.starts.length,1);
  }finally{t.cleanup();}
});
