import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {CodexSubagents} from '../../hub/src/runner/codex-subagents.ts';
import {AgySubagents} from '../../hub/src/runner/agy-subagents.ts';
import {AgyChildren} from '../../hub/src/runner/agy-children.ts';
import {Store} from '../../hub/src/db.ts';
import {Subagents} from '../../hub/src/subagents.ts';
import {RemoteRunners} from '../../hub/src/runner/remote-hub.ts';
import {Runner} from '../../hub/src/runner/runner.ts';
import {subagentTracker} from '../../hub/src/runner/claude.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function sink(){
 const store=new Store(':memory:');store.database.exec('PRAGMA foreign_keys = OFF');
 const sub=new Subagents(store,()=>{}),session={id:'synthetic-session',task_id:'synthetic-task'} as any;
 return {store,emit:(m:any)=>{if(m.type==='subagent')sub.report(session,m.subagent);if(m.type==='subagent_event')sub.event(session,m.subagentId,m.event);},
 texts:(id='agent:child')=>sub.events(session.task_id,session.id,id).events.map(e=>(e.payload as any).text),
 status:(id='agent:child')=>sub.list(session.task_id).find(s=>s.id===id)?.status,close:()=>store.database.close()};
}
test('Codex retries a failed history page before delivering queued live records',async()=>{
 const s=sink();let fail=true,rejectPage!:(e:Error)=>void;
 const msg=(id:string,text:string)=>({id,type:'agentMessage',text});
 const turn=(id:string,text:string)=>({id,status:'completed',items:[msg(id,text)]});
 const a=new CodexSubagents('synthetic-session',async(method,p)=>{
  if(method==='thread/read')return {thread:{id:'child',status:{type:'active'}}};
  if(!p.cursor)return {data:[turn('t1','first')],nextCursor:'second'};
  if(fail)return new Promise((resolve,reject)=>{rejectPage=reject;});
  return {data:[turn('t2','middle'),turn('t3','latest')],nextCursor:null};
 },s.emit);
 try{
  a.discover({id:'child',status:{type:'active'}},'root');await flush();
  a.notification('item/completed',{threadId:'child',turnId:'t3',item:msg('t3','latest')},'root');
  rejectPage(Error('temporary page failure'));await flush();fail=false;await a.recover('child');
  console.log('actual='+JSON.stringify(s.texts())+' expected=["first","middle","latest"]');
  assert.deepEqual(s.texts(),['first','middle','latest']);
 }finally{a.stop();s.close();}
});
test('Claude persisted links survive actual hub and runner start-option forwarding',()=>{
 const s=sink();let tracker:any,links:any;
 const first=subagentTracker('synthetic-session',s.emit);
 first({type:'system',subtype:'task_started',task_id:'agent:child',tool_use_id:'original',description:'child',prompt:'first prompt',is_backgrounded:true} as any);
 const runner=new Runner('synthetic-runner',s.emit,{start:opts=>{
  links=opts.subagentLinks;tracker=subagentTracker(opts.sessionId,opts.emit,opts.subagentLinks);
  return {send(){},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval(){},close(){}};
 }});
 const local={connected:true,id:'synthetic-runner',engines:new Set(['claude']),has:()=>true,handle:(cmd:any)=>runner.handle(cmd)} as any;
 const remotes=new RemoteRunners(s.store,local,()=>{},()=>{},()=>{},undefined as any,()=>{},()=>{});
 try{
  remotes.handle({type:'start',sessionId:'synthetic-session',engine:'claude',cwd:process.cwd(),prompt:'followup',resume:'synthetic-engine-id'} as any);
  assert.deepEqual(links,[{id:'agent:child',toolUseId:'original'}]);
  tracker({type:'system',subtype:'task_started',task_id:'agent:child',tool_use_id:'followup',description:'child',prompt:'followup prompt'});
  tracker({type:'assistant',parent_tool_use_id:'original',message:{content:[{type:'text',text:'followup answer'}]}});
  console.log('Claude actual='+JSON.stringify(s.texts())+' expected=["first prompt","followup prompt","followup answer"]');
  assert.deepEqual(s.texts(),['first prompt','followup prompt','followup answer']);
 }finally{remotes.close();runner.shutdown();s.close();}
});
test('AGY restores completed native responses in file timestamp order',()=>{
 const s=sink(),dir=mkdtempSync('/tmp/desk15-agy-fixture-');
 const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
 const records=join(dir,parent,'.system_generated');
 mkdirSync(join(records,'subagents'),{recursive:true});mkdirSync(join(records,'messages'));
 writeFileSync(join(records,'subagents',child+'.json'),JSON.stringify({conversationId:child}));
 const first='ffffffff-ffff-4fff-8fff-ffffffffffff.json',second='00000000-0000-4000-8000-000000000000.json';
 const idle=(file:string,text:string)=>writeFileSync(join(records,'messages',file),JSON.stringify({sender:'system',content:`Subagent ${child} has gone idle. This was the subagent's most recent response: ${text}`}));
 idle(first,'first answer');idle(second,'followup answer');
 utimesSync(join(records,'messages',first),1000,1000);utimesSync(join(records,'messages',second),2000,2000);
 const details=new AgySubagents('synthetic-session',s.emit),monitor=new AgyChildren(()=>{},dir,details);
 try{
  monitor.beforePrompt(parent);
  console.log('actual='+JSON.stringify(s.texts('agent:'+child))+' expected=["first answer","followup answer"]');
  assert.deepEqual(s.texts('agent:'+child),['first answer','followup answer']);
 }finally{monitor.reset();details.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('AGY ignores delayed terminal tool calls when tracking child activity',()=>{
 const s=sink(),a=new AgySubagents('synthetic-session',s.emit),dir=mkdtempSync('/tmp/desk15-agy-late-');
 const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
 const records=join(dir,parent,'.system_generated');
 mkdirSync(join(records,'subagents'),{recursive:true});mkdirSync(join(records,'messages'));
 writeFileSync(join(records,'subagents',child+'.json'),JSON.stringify({conversationId:child}));
 const monitor=new AgyChildren(()=>{},dir,a);
 try{
  monitor.beforePrompt(parent);monitor.watch(child);
  writeFileSync(join(records,'messages',parent+'.json'),JSON.stringify({sender:'system',content:`Subagent ${child} has gone idle. This was the subagent's most recent response: done`}));
  assert.equal(monitor.owns(child),false);assert.equal(s.status('agent:'+child),'ended');
  assert.equal(monitor.belongs(child),true);monitor.observeUpdate(child,{sessionUpdate:'tool_call',status:'completed'});
  a.update(child,{sessionUpdate:'tool_call',toolCallId:'tool',name:'read_file',status:'completed',rawOutput:'done'});
  const active=monitor.owns(child);
  console.log('actual='+JSON.stringify({status:s.status('agent:'+child),active})+' expected={"status":"ended","active":false}');
  assert.deepEqual({status:s.status('agent:'+child),active},{status:'ended',active:false});
 }finally{monitor.reset();a.close();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('unchanged Codex discovery preserves recovered notes without another report', async () => {
 const out:any[]=[];
 const a=new CodexSubagents('s',async method=>method==='thread/read'
  ? {thread:{id:'child',status:{type:'idle'}}}
  : {data:[{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',text:'done'}]}],nextCursor:null},m=>out.push(m));
 try {
  const listed={id:'child',parentThreadId:'root',status:{type:'idle'},updatedAt:100};
  a.discover(listed,'root');await a.recover('child');await flush();
  const count=out.length;
  assert.equal(out.filter(m=>m.type==='subagent').at(-1).subagent.detailNote,undefined);
  a.discover(listed,'root');await flush();
  assert.equal(out.length,count);
 } finally {a.stop();}
});
