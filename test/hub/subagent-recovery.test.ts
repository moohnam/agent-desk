import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgySubagents} from '../../hub/src/runner/agy-subagents.ts';
import {CodexSubagents} from '../../hub/src/runner/codex-subagents.ts';
import {Store} from '../../hub/src/db.ts';
import {Subagents} from '../../hub/src/subagents.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function sink(){
 const store=new Store(':memory:');store.database.exec('PRAGMA foreign_keys = OFF');
 const sub=new Subagents(store,()=>{}),session={id:'synthetic-session',task_id:'synthetic-task'} as any;
 return {emit:(m:any)=>{if(m.type==='subagent')sub.report(session,m.subagent);if(m.type==='subagent_event')sub.event(session,m.subagentId,m.event);},
 links:()=>sub.list(session.task_id).filter(x=>x.toolUseId).map(x=>({id:x.id,toolUseId:x.toolUseId!})),texts:()=>sub.events(session.task_id,session.id,'agent:child').events.map(e=>(e.payload as any).text),close:()=>store.database.close()};
}
test('AGY restart replays an already stored response',()=>{
 const s=sink();try{
  const first=new AgySubagents('synthetic-session',s.emit);
  first.discover({conversationId:'child'},false);
  first.update('child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}});
  first.idle('child','same-idle.json','answer');first.close();
  const restarted=new AgySubagents('synthetic-session',s.emit);
  restarted.discover({conversationId:'child'},true);restarted.idle('child','same-idle.json','answer');
  console.log('AGY restart actual='+JSON.stringify(s.texts())+' expected=["answer"]');
  assert.deepEqual(s.texts(),['answer']);
 }finally{s.close();}
});
test('AGY idle before final chunks duplicates the answer',()=>{
 const s=sink();try{
  const a=new AgySubagents('synthetic-session',s.emit);a.discover({conversationId:'child'},false);
  a.idle('child','idle.json','hello world');
  a.update('child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello '}});
  a.update('child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'world'}});
  console.log('AGY late actual='+JSON.stringify(s.texts())+' expected=["hello world"]');
  assert.deepEqual(s.texts(),['hello world']);
 }finally{s.close();}
});
test('Codex retries an unchanged thread after a transient history failure',async()=>{
 const out:any[]=[];let reads=0,fail=true;
 const a=new CodexSubagents('s',async(method)=>{
  if(method==='thread/read'){reads++;if(fail)throw Error('temporary timeout');return {thread:{id:'child',status:{type:'idle'}}};}
  return {data:[{id:'turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'answer'}]}],nextCursor:null};
 },m=>out.push(m));
 const snapshot={id:'child',updatedAt:123,status:{type:'idle'}};
 a.discover(snapshot,'root');await flush();fail=false;
 a.discover(snapshot,'root');await flush();a.discover(snapshot,'root');await flush();
 const texts=out.filter(m=>m.type==='subagent_event').map(m=>m.event.text);
 console.log('Codex retry actual='+JSON.stringify({reads,texts})+' expected={"reads":2,"texts":["answer"]}');
 a.stop();assert.deepEqual(texts,['answer']);
});
test('Codex failed multipage recovery followed by live and retry preserves native order',async()=>{
 const s=sink();let fail=true,release!:(x:any)=>void;
 const old={id:'old',type:'userMessage',content:[{type:'text',text:'earlier prompt'}]};
 const answer={id:'answer',type:'agentMessage',text:'later answer'};
 const a=new CodexSubagents('synthetic-session',async(method,p)=>{
  if(method==='thread/read')return {thread:{id:'child',status:{type:'active'}}};
  if(!p.cursor)return {data:[{id:'older-turn',status:'completed',items:[old]}],nextCursor:'second'};
  if(fail)return new Promise((resolve,reject)=>{release=()=>reject(Error('temporary page failure'));});
  return {data:[{id:'t',status:'completed',items:[answer]}],nextCursor:null};
 },s.emit);
 try{
  a.discover({id:'child',status:{type:'active'}},'root');await flush();
  a.notification('item/completed',{threadId:'child',turnId:'t',item:answer},'root');
  release(null);await flush();fail=false;await a.recover('child');
  console.log('Codex order actual='+JSON.stringify(s.texts())+' expected=["earlier prompt","later answer"]');
  assert.deepEqual(s.texts(),['earlier prompt','later answer']);
 }finally{a.stop();s.close();}
});

test('Claude restart followed by SendMessage keeps the original parent tool mapping',async()=>{
 const {subagentTracker}=await import('../../hub/src/runner/claude.ts');
 const s=sink();const send=(track:any,m:any)=>track(m);
 try{
  const first=subagentTracker('synthetic-session',s.emit);
  send(first,{type:'system',subtype:'task_started',task_id:'agent:child',tool_use_id:'original-agent-call',task_type:'local_agent',description:'child',is_backgrounded:true,prompt:'first prompt'});
  send(first,{type:'system',subtype:'task_notification',task_id:'agent:child',status:'completed',summary:'done',output_file:''});
  const restarted=subagentTracker('synthetic-session',s.emit,s.links());
  send(restarted,{type:'system',subtype:'task_started',task_id:'agent:child',tool_use_id:'send-message-call',description:'child',prompt:'followup prompt'});
  send(restarted,{type:'assistant',parent_tool_use_id:'original-agent-call',message:{content:[{type:'text',text:'followup answer'}]}});
  send(restarted,{type:'system',subtype:'task_notification',task_id:'agent:child',status:'completed',summary:'done',output_file:''});
  console.log('Claude restart followup actual='+JSON.stringify(s.texts())+' expected=["first prompt","followup prompt","followup answer"]');
  assert.deepEqual(s.texts(),['first prompt','followup prompt','followup answer']);
 }finally{s.close();}
});
