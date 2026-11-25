import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hub} from '../../hub/src/hub.ts';
import {Store} from '../../hub/src/db.ts';
import {Runner} from '../../hub/src/runner/runner.ts';
import {SkillStore} from '../../hub/src/skills.ts';
import type {RunnerMessageListener,RunnerPort} from '../../hub/src/runner/client.ts';
import type {HubToRunner,RunnerToHub} from '../../shared/protocol.ts';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'desk-approval-reconnect-'));
 let hub!:Hub,store!:Store,receive!:RunnerMessageListener,online=false,drop=false,throwWrite=false,dropAck=false;
 const emitters=new Map<string,(m:RunnerToHub)=>void>();
 const resolved:Extract<HubToRunner,{type:'approval_result'}>[]=[];
 const sent:HubToRunner[]=[];
 const runner=new Runner('fixture',m=>{if(online&&!(dropAck&&m.type==='event'&&m.event.kind==='status'&&m.event.state==='request_receipt'&&m.event.detail?.phase==='approval_resolved'))receive(m);},{receiptPath:join(dir,'receipts.db'),start:o=>{
  emitters.set(o.sessionId,o.emit);
  return {send(){},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},close(){},resolveApproval(id,allow,message,answers){resolved.push({type:'approval_result',sessionId:o.sessionId,approvalId:id,allow,message,answers});}};
 }});
 const port:RunnerPort={get connected(){return online;},id:'fixture',engines:new Set(['agy']),has:id=>online&&runner.snapshot().some(s=>s.sessionId===id),handle(cmd){
  sent.push(cmd);
  if(cmd.type==='approval_result'){
   // A separate DB connection must see the decision before transport observes it.
   const reader=new Store(join(dir,'desk.db'));try{assert.ok(reader.approvalDelivery(cmd.approvalId,cmd.sessionId));}finally{reader.database.close();}
   if(throwWrite){online=false;throw new Error('disconnected during write');}
   if(drop){online=false;return;}
  }
  runner.handle(cmd);
 }};
 const open=()=>{store=new Store(join(dir,'desk.db'));hub=new Hub(store,{skills:new SkillStore(join(dir,'skills')),graceMs:5,runner:listener=>{receive=listener;return port;}});};
 open();
 const hello=(atomic=false)=>{online=true;const report=()=>receive({type:'hello',runnerId:'fixture',host:'test',capabilities:{engines:['agy']},sessions:structuredClone(runner.snapshot())});if(atomic)hub.atomic(report);else report();};
 hello();const task=hub.compose(`@fixture:${dir} #agy test`),sessionId=store!.latestSession(task.id)!.id;
 const emit=(m:RunnerToHub)=>emitters.get(sessionId)!(m);
 emit({type:'busy',sessionId,busy:true});
 return {get hub(){return hub!;},get store(){return store!;},taskId:task.id,sessionId,runner,resolved,sent,hello,emit,
  ask(id:string){emit({type:'approval_request',sessionId,approvalId:id,toolName:'write_file',input:{path:'fixture-only'}});},
  restart(){online=false;hub.dispose();store.database.close();open();},
  drop(value=true){drop=value;},throwWrite(value=true){throwWrite=value;},dropAck(value=true){dropAck=value;},disconnect(){online=false;},
  close(){online=false;runner.shutdown();hub.dispose();store.database.close();rmSync(dir,{recursive:true,force:true});}};
}

test('late first runner report preserves the same pending approval and restores legacy false denials',async t=>{
 const f=fixture();t.after(()=>f.close());f.ask('approval');f.restart();
 await new Promise(r=>setTimeout(r,20));
 assert.equal(f.store.getApproval('approval')?.status,'pending');assert.equal(f.store.getTask(f.taskId)?.status,'waiting');
 assert.equal(f.store.listEvents(f.taskId).filter(e=>(e.payload as any).detail?.reason==='session_lost').length,0);
 // Simulate an older hub's startup-only denial with no user decision event.
 f.store.setApprovalStatus('approval','denied');f.hello();
 assert.equal(f.store.getApproval('approval')?.status,'pending');assert.equal(f.hub.state().approvals.length,1);
 assert.equal(f.hub.state().approvals[0].id,'approval');
});

for(const throws of [false,true])test(`decision survives a lost write and hub restart; runner consumes once (throw=${throws})`,t=>{
 const f=fixture();t.after(()=>f.close());f.ask('approval');
 if(throws)f.throwWrite();else f.drop();
 f.hub.resolveApproval('approval',true,'approved in fixture');
 assert.equal(f.store.getApproval('approval')?.status,'allowed');assert.equal(f.resolved.length,0);
 assert.ok(f.store.approvalDelivery('approval',f.sessionId));
 f.restart();f.drop(false);f.throwWrite(false);f.hello();
 assert.equal(f.resolved.length,1);assert.equal(f.resolved[0].message,'approved in fixture');
 assert.equal(f.store.approvalDelivery('approval',f.sessionId),undefined);
 // Duplicate transport delivery cannot execute the adapter twice.
 f.runner.handle(f.resolved[0]);f.hello();assert.equal(f.resolved.length,1);
 assert.equal(f.store.listEvents(f.taskId).filter(e=>e.kind==='approval'&&(e.payload as any).decision==='allowed').length,1);
});

test('lost acknowledgement is cleaned by authoritative snapshot without executing again',t=>{
 const f=fixture();t.after(()=>f.close());f.ask('approval');f.dropAck();f.hub.resolveApproval('approval',false,'no');
 assert.equal(f.resolved.length,1);assert.ok(f.store.approvalDelivery('approval',f.sessionId));
 f.restart();f.dropAck(false);f.hello();assert.equal(f.resolved.length,1);
 assert.equal(f.store.approvalDelivery('approval',f.sessionId),undefined);
});

for(const endsFirst of [false,true])test(`one and last approval expiry settle according to actual turn state (ended=${endsFirst})`,t=>{
 const f=fixture();t.after(()=>f.close());f.ask('one');f.ask('two');
 if(endsFirst)f.emit({type:'busy',sessionId:f.sessionId,busy:false});
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'one',reason:'expired'});
 assert.equal(f.store.getTask(f.taskId)?.status,'waiting');assert.equal(f.hub.state().approvals.length,1);
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'two',reason:'expired'});
 assert.equal(f.store.getTask(f.taskId)?.status,endsFirst?'done':'running');assert.equal(f.hub.state().approvals.length,0);
 f.emit({type:'busy',sessionId:f.sessionId,busy:false});assert.equal(f.store.getTask(f.taskId)?.status,'done');
 assert.equal(f.store.getApproval('one')?.status,'expired');
 assert.equal(f.store.listEvents(f.taskId).filter(e=>e.kind==='approval'&&(e.payload as any).decision==='denied').length,0);
});

test('authoritative loss and a cancellation missed offline are distinct from user denial',t=>{
 const f=fixture();t.after(()=>f.close());f.ask('one');f.disconnect();
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'one'});
 f.emit({type:'busy',sessionId:f.sessionId,busy:false});f.hello();
 assert.equal(f.store.getApproval('one')?.status,'cancelled');assert.equal(f.store.getTask(f.taskId)?.status,'done');
 f.emit({type:'busy',sessionId:f.sessionId,busy:true});f.ask('two');f.disconnect();f.runner.shutdown();f.hello();
 assert.equal(f.store.getApproval('two')?.status,'lost');assert.equal(f.store.getTask(f.taskId)?.status,'error');
});

test('last expiry after turn completion releases queued input exactly once',t=>{
 const f=fixture();t.after(()=>f.close());f.ask('one');f.ask('two');
 f.hub.sendMessage(f.taskId,'queued fixture input');
 f.emit({type:'busy',sessionId:f.sessionId,busy:false});
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'one',reason:'expired'});
 assert.equal(f.store.queued().length,1);
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'two',reason:'expired'});
 assert.equal(f.store.queued().length,0);
 assert.equal(f.sent.filter(c=>c.type==='send').length,1);
 f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'two',reason:'expired'});
 assert.equal(f.sent.filter(c=>c.type==='send').length,1);
});

test('expiry before an undelivered decision is distinct from a user denial',t=>{
 const f=fixture();t.after(()=>f.close());f.ask('one');f.drop();f.hub.resolveApproval('one',true);
 f.drop(false);f.hello(); // First finish the normal delivery, then cover a separate lost decision.
 f.ask('two');f.drop();f.hub.resolveApproval('two',true);f.drop(false);
 // The timeout event may be replayed before the next hello in older transports.
 f.disconnect();f.emit({type:'approval_cancelled',sessionId:f.sessionId,approvalId:'two',reason:'expired'});
 f.hello();
 assert.equal(f.resolved.filter(c=>c.approvalId==='two').length,0);
 assert.equal(f.store.approvalDelivery('two',f.sessionId),undefined);
});


for(const atomic of [false,true])for(const busy of [false,true])test(`replayed decision precedes queued input and preserves runner busy (atomic=${atomic}, busy=${busy})`,t=>{
 const f=fixture();t.after(()=>f.close());f.ask('approval');f.hub.sendMessage(f.taskId,'queued after approval');
 f.drop();f.hub.resolveApproval('approval',false,'declined');
 if(!busy)f.emit({type:'busy',sessionId:f.sessionId,busy:false});
 f.restart();f.drop(false);f.sent.length=0;f.hello(atomic);
 assert.equal(f.sent[0]?.type,'approval_result');
 assert.equal(f.resolved.length,1);assert.equal(f.resolved[0].allow,false);
 assert.equal(f.store.queued().length,busy?1:0);
 assert.equal(f.sent.filter(c=>c.type==='send').length,busy?0:1);
 if(busy){assert.equal(f.hub.busy.has(f.sessionId),true);f.emit({type:'busy',sessionId:f.sessionId,busy:false});}
 assert.equal(f.sent.filter(c=>c.type==='send').length,1);
});

test('rolled back outer operation never delivers a user approval',t=>{
 const f=fixture();t.after(()=>f.close());f.ask('approval');
 assert.throws(()=>f.hub.atomic(()=>{f.hub.resolveApproval('approval',true);throw new Error('rollback');}),/rollback/);
 assert.equal(f.resolved.length,0);assert.equal(f.store.getApproval('approval')?.status,'pending');
 assert.equal(f.store.approvalDelivery('approval',f.sessionId),undefined);
});


for(const atomic of [false,true])test(`all replayed decisions precede queued input (atomic=${atomic})`,t=>{
 const f=fixture();t.after(()=>f.close());f.ask('one');f.ask('two');f.hub.sendMessage(f.taskId,'queued after both');
 f.drop();f.hub.atomic(()=>{f.hub.resolveApproval('one',true);f.hub.resolveApproval('two',false);});
 f.emit({type:'busy',sessionId:f.sessionId,busy:false});f.restart();f.drop(false);f.sent.length=0;f.hello(atomic);
 assert.deepEqual(f.sent.map(c=>c.type),['approval_result','approval_result','send']);
 assert.equal(f.resolved.length,2);assert.equal(f.store.queued().length,0);
});
