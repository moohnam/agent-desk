import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CodexSubagents} from '../../hub/src/runner/codex-subagents.ts';
import {AgySubagents} from '../../hub/src/runner/agy-subagents.ts';
import {checkRunnerToHub,type RunnerToHub} from '../../shared/protocol.ts';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('Codex child history, live items, paging and repeat recovery share stable IDs; root and strangers are excluded',async()=>{
  const out:RunnerToHub[]=[],requests:any[]=[];
  const user={type:'userMessage',id:'u',content:[{type:'text',text:'child instruction'}]};
  const cmd={type:'commandExecution',id:'cmd',command:'echo test',status:'completed',aggregatedOutput:'test',exitCode:0};
  const answer={type:'agentMessage',id:'a',text:'child answer'};
  const tracker=new CodexSubagents('s',async(method,p)=>{
    requests.push([method,p]);
    if(method==='thread/read')return {thread:{id:'child',status:{type:'idle'},turns:[]}};
    return p.cursor?{data:[{id:'t2',status:'completed',itemsView:'full',items:[answer]}],nextCursor:null}
      :{data:[{id:'t1',status:'completed',itemsView:'full',items:[user,cmd]}],nextCursor:'next'};
  },m=>out.push(m));
  tracker.discover({id:'child',parentThreadId:'root',status:{type:'active'}},'root');await flush();
  tracker.notification('item/completed',{threadId:'child',turnId:'t2',item:answer},'root');
  tracker.notification('item/completed',{threadId:'root',turnId:'t2',item:{...answer,id:'root'}},'root');
  tracker.notification('item/completed',{threadId:'stranger',turnId:'t2',item:{...answer,id:'stranger'}},'root');
  await tracker.recover('child');
  const events=out.filter(m=>m.type==='subagent_event');
  assert.deepEqual(events.map(m=>m.event.kind),['user','tool','tool_result','assistant']);
  assert.equal(new Set(events.map(m=>m.event.sourceId)).size,4);
  assert.ok(requests.some(([,p])=>p.cursor==='next'));
  assert.ok(out.every(m=>typeof checkRunnerToHub(m)==='object'));
  tracker.stop();
});

test('Codex old history API fallback and unavailable histories state accurate limits',async()=>{
  const out:RunnerToHub[]=[];let available=true;
  const tracker=new CodexSubagents('s',async(method,p)=>{
    if(method!=='thread/read'||!p.includeTurns||!available)throw Error('unsupported');
    return {thread:{id:'child',status:{type:'idle'},turns:[{id:'t',status:'completed',items:[{type:'agentMessage',id:'m',text:'recovered'}]}]}};
  },m=>out.push(m));
  tracker.discover({id:'child',status:{type:'idle'}},'root');await flush();
  assert.equal(out.filter(m=>m.type==='subagent_event').length,1);
  available=false;await tracker.recover('child');
  assert.match(out.filter(m=>m.type==='subagent').at(-1)!.subagent.detailNote!,/제공하지 못/);
  tracker.stop();
});

test('Codex stale recovery does not overwrite a resumed run and unfinished text is not frozen',async()=>{
  const out:RunnerToHub[]=[];let release!:(x:any)=>void;
  const tracker=new CodexSubagents('s',async(method)=>method==='thread/read'?{thread:{id:'child',status:{type:'idle'}}}:new Promise(r=>{release=r;}),m=>out.push(m));
  tracker.discover({id:'child',status:{type:'active'}},'root');await flush();
  tracker.notification('turn/started',{threadId:'child'},'root');
  release({data:[{id:'t',status:'inProgress',itemsView:'full',items:[{type:'agentMessage',id:'m',text:'partial'}]}],nextCursor:null});await flush();
  assert.equal(out.filter(m=>m.type==='subagent_event').length,0);
  assert.equal(out.filter(m=>m.type==='subagent').at(-1)!.subagent.status,'running');
  tracker.notification('item/completed',{threadId:'child',turnId:'t',item:{type:'agentMessage',id:'m',text:'whole'}},'root');
  assert.equal(out.filter(m=>m.type==='subagent_event').length,1);tracker.stop();
});

test('AGY child notifications stay separate; metadata does not guess spawn prompts; idle is not success',()=>{
  const out:RunnerToHub[]=[];const tracker=new AgySubagents('s',m=>out.push(m));
  tracker.update('stranger',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'unowned'}});
  tracker.discover({conversationId:'child',subagentDescriptor:{role:'worker'}},true);
  tracker.update('child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer'}});
  tracker.update('child',{sessionUpdate:'tool_call',toolCallId:'tool',name:'read_file',rawInput:{path:'fixture'}});
  tracker.update('child',{sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',rawOutput:'contents'});
  tracker.idle('child','message-file','answer');
  assert.deepEqual(out.filter(m=>m.type==='subagent_event').map(m=>m.event.kind),['tool','tool_result','assistant']);
  assert.equal(out.filter(m=>m.type==='subagent').at(-1)!.subagent.status,'ended');
  assert.ok(out.every(m=>typeof checkRunnerToHub(m)==='object'));
  assert.ok(out.every(m=>m.type!=='event'),'never emits parent transcript entries');
});


test('Codex holds live child events behind initial history to keep native conversation order',async()=>{
  const out:RunnerToHub[]=[];let release!:(x:any)=>void;
  const tracker=new CodexSubagents('s',async method=>method==='thread/read'?{thread:{id:'child',status:{type:'active'}}}:new Promise(r=>{release=r;}),m=>out.push(m));
  tracker.discover({id:'child',status:{type:'active'}},'root');await flush();
  tracker.notification('item/completed',{threadId:'child',turnId:'t',item:{type:'agentMessage',id:'answer',text:'new answer'}},'root');
  assert.equal(out.filter(m=>m.type==='subagent_event').length,0);
  release({data:[{id:'t',status:'inProgress',itemsView:'full',items:[{type:'userMessage',id:'prompt',content:[{type:'text',text:'earlier instruction'}]}]}],nextCursor:null});await flush();
  assert.deepEqual(out.filter(m=>m.type==='subagent_event').map(m=>m.event.kind),['user','assistant']);tracker.stop();
});


test('AGY final text arriving after native idle never resurrects running work or leaves a hidden buffer',()=>{
  const out:RunnerToHub[]=[];const tracker=new AgySubagents('s',m=>out.push(m));
  tracker.discover({conversationId:'child'},false);
  tracker.idle('child','idle','late final response');
  tracker.update('child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'late final response'}});
  assert.equal(out.filter(m=>m.type==='subagent').at(-1)!.subagent.status,'ended');
  assert.equal(out.filter(m=>m.type==='subagent_event').at(-1)!.event.kind,'assistant');
  const count=out.length;tracker.close();assert.equal(out.length,count,'final response was already flushed');
});
