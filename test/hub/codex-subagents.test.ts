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

for(const legacy of [false,true])test(`Codex history separates turn end from tool completion and preserves image calls (${legacy?'legacy':'paged'})`,async()=>{
  const out:RunnerToHub[]=[];
  const turns=['interrupted','failed','completed'].map((status,i)=>({id:'turn'+i,status,items:[
    {id:'pending',type:'commandExecution',command:'sleep 20',status:'inProgress',exitCode:null,aggregatedOutput:null},
    {id:'failed',type:'commandExecution',command:'false',status:'failed',exitCode:1,aggregatedOutput:'failed'},
    {id:'done',type:'commandExecution',command:'true',status:'completed',exitCode:0,aggregatedOutput:'done'},
    {id:'image',type:'imageView',path:'/tmp/input.png'},
    {id:'answer',type:'agentMessage',text:'answer'},
  ]}));
  const a=new CodexSubagents('s',async(method,p)=>{
    if(legacy&&method==='thread/turns/list')throw Error('unknown method');
    return method==='thread/read'?{thread:{id:'child',status:{type:'idle'},...(p.includeTurns?{turns}:{})}}:{data:turns,nextCursor:null};
  },m=>out.push(m));
  try{
    a.discover({id:'child',status:{type:'idle'}},'root');await a.recover('child');
    const events=out.filter(m=>m.type==='subagent_event').map(m=>m.event);
    for(let i=0;i<3;i++){
      assert.equal(events.filter(e=>e.kind==='tool_result'&&e.toolUseId===`turn${i}/pending`).length,0);
      assert.ok(events.some(e=>e.kind==='tool_result'&&e.toolUseId===`turn${i}/failed`&&e.isError));
      assert.ok(events.some(e=>e.kind==='tool_result'&&e.toolUseId===`turn${i}/done`&&!e.isError));
      assert.ok(events.some(e=>e.kind==='tool'&&e.toolUseId===`turn${i}/image`&&e.name==='ViewImage'&&(e.input as any).path==='/tmp/input.png'));
    }
    assert.equal(events.filter(e=>e.kind==='assistant').length,3,'a stopped turn still preserves supplied text without inventing tool success');
    const count=events.length;
    a.notification('item/completed',{threadId:'child',turnId:'turn0',item:{id:'image',type:'imageView',path:'/tmp/input.png'}},'root');
    assert.equal(out.filter(m=>m.type==='subagent_event').length,count,'live/history image deduplicates');
    a.notification('item/completed',{threadId:'child',turnId:'turn0',item:{id:'pending',type:'commandExecution',command:'sleep 20',status:'completed',exitCode:0,aggregatedOutput:'finished later'}},'root');
    assert.equal(out.filter(m=>m.type==='subagent_event'&&m.event.kind==='tool_result'&&m.event.toolUseId==='turn0/pending').length,1,'a later confirmed result is not hidden by synthetic success');
  }finally{a.stop();}
});

test('Codex stores delivered parent instructions on the receiving child and reconciles explicit IDs across recovery',async()=>{
  const {Store}=await import('../../hub/src/db.ts');
  const {Subagents}=await import('../../hub/src/subagents.ts');
  const store=new Store(':memory:');store.database.exec('PRAGMA foreign_keys=OFF');
  const db=new Subagents(store,()=>{}),session={id:'s',task_id:'t',engine:'codex'} as import('../../hub/src/db.ts').Session;
  let release!:(page:any)=>void;
  const tracker=new CodexSubagents('s',async method=>method==='thread/read'?{thread:{id:'child'}}:new Promise(r=>{release=r;}),m=>{
    if(m.type==='subagent')db.report(session,m.subagent);
    if(m.type==='subagent_event')db.event(session,m.subagentId,m.event);
  });
  const send=(id:string,tool:string,prompt:string,status='completed',sender='root',method='item/completed')=>tracker.notification(method,{
    threadId:sender,item:{id,type:'collabAgentToolCall',tool,status,prompt,senderThreadId:sender,receiverThreadIds:['child','stranger','root']}
  },'root');
  try{
    tracker.discover({id:'child',parentThreadId:'root',status:{type:'active'}},'root');await flush();
    send('one','spawnAgent','첫 지시');send('one','spawnAgent','첫 지시');
    send('two','followupTask','다음 지시');send('three','sendInput','실패','failed');
    send('four','wait','대기');send('five','sendMessage','외부','completed','unknown');
    send('six','sendInput','확정 전','inProgress','root','item/started');
    send('seven','sendMessage','gAAAA'+'x'.repeat(80));
    const user=(id:string,clientId:string,text:string)=>({type:'userMessage',id,clientId,content:[{type:'text',text}]});
    release({data:[{id:'turn',items:[user('u1','one','첫 지시'),user('u2','two','다음 지시')]}]});await flush();
    send('two','followupTask','다음 지시');
    send('again','sendInput','다음 지시');
    tracker.discover({id:'grandchild',parentThreadId:'child',status:{type:'active'}},'root');
    send('report','sendMessage','상위 작업에 결과 보고','completed','grandchild');
    const rows=db.events('t','s','agent:child').events;
    assert.deepEqual(rows.map(e=>(e.payload as {text:string}).text),['첫 지시','다음 지시','다음 지시']);
    assert.deepEqual(db.list('t').map(s=>s.id).sort(),['agent:child','agent:grandchild']);
  }finally{tracker.stop();store.database.close();}
});
