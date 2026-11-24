import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CodexActivity} from '../../hub/src/runner/codex-activity.ts';
import {AgyActivity} from '../../hub/src/runner/agy-activity.ts';
import {Runner} from '../../hub/src/runner/runner.ts';
import {sessionBlockers} from '../../hub/src/runtime-control.ts';
import {inBackground,statusLabel,stalledMinutes,taskRunning} from '../../web/src/format.ts';
import type {BackgroundTask,RunnerToHub} from '../../shared/protocol.ts';
import type {TaskView} from '../../web/src/types.ts';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(interval=60000){
  let children:any[]=[],terminals:any[]=[],fail=false;
  const requests:string[]=[],out:BackgroundTask[][]=[];
  const monitor=new CodexActivity(async(method)=>{
    requests.push(method);if(fail)throw Error('offline');
    if(method==='thread/list')return {data:children,nextCursor:null};
    if(method==='thread/read')return {thread:{id:'child',status:{type:'notLoaded'}}};
    return {data:terminals,nextCursor:null};
  },tasks=>out.push(tasks),interval);
  return {monitor,requests,out,set:(c:any[],t:any[]=[])=>{children=c;terminals=t;},fail:(v:boolean)=>{fail=v;},last:()=>out.at(-1)!};
}

test('Codex waits for initial native inventory, and stops polling when all work is finished',async()=>{
  const f=fixture(10);try{
    f.monitor.start('root');assert.equal(f.last()[0].state,'unknown');await flush();assert.deepEqual(f.last(),[]);
    const count=f.requests.length;await new Promise(r=>setTimeout(r,30));assert.equal(f.requests.length,count);
  }finally{f.monitor.stop();}
});

test('child execution and background terminals survive parent completion; finished child processes are not running',async()=>{
  const f=fixture();try{
    f.monitor.start('root');await flush();
    f.set([{id:'child',status:{type:'active'},agentNickname:'worker'}]);
    f.monitor.notification('thread/started',{thread:{id:'child',parentThreadId:'root',status:{type:'active'}}});
    assert.ok(f.last().some(t=>t.id==='agent:child'));
    f.monitor.notification('turn/completed',{threadId:'root'});await flush();
    assert.equal(f.last().filter(t=>t.type==='local_agent').length,1);
    f.set([{id:'child',status:{type:'idle'}}],[{processId:'12',command:'sleep 30'}]);
    f.monitor.notification('thread/status/changed',{threadId:'child',status:{type:'idle'}});f.monitor.refresh();await flush();
    assert.ok(f.last().every(t=>t.type==='shell'));assert.equal(f.last().length,2);
    f.set([{id:'child',status:{type:'idle'}}]);f.monitor.refresh();await flush();assert.deepEqual(f.last(),[]);
  }finally{f.monitor.stop();}
});

test('unknown/unrelated thread events cannot leak into the task and failed reads cannot declare idle',async()=>{
  const f=fixture();try{
    f.monitor.start('root');await flush();
    f.monitor.notification('thread/started',{thread:{id:'stranger',parentThreadId:'elsewhere',status:{type:'active'}}});
    f.monitor.notification('item/started',{threadId:'stranger',item:{type:'commandExecution',id:'x',status:'inProgress'}});
    assert.deepEqual(f.last(),[]);
    f.fail(true);f.monitor.refresh();await flush();assert.equal(f.last()[0].state,'unknown');
    f.fail(false);f.monitor.refresh();await flush();assert.deepEqual(f.last(),[]);
  }finally{f.monitor.stop();}
});

test('closed ephemeral children are forgotten and messaging a parent or stranger does not adopt it',async()=>{
  let reads=0;const out:BackgroundTask[][]=[];
  const m=new CodexActivity(async method=>{if(method==='thread/read'){reads++;throw Error('not found');}return {data:[],nextCursor:null};},t=>out.push(t),60000);
  try{
    m.start('root');await flush();
    m.notification('thread/started',{thread:{id:'child',parentThreadId:'root',status:{type:'active'}}});
    m.notification('item/completed',{threadId:'child',item:{type:'collabAgentToolCall',tool:'sendMessage',receiverThreadIds:['root','stranger'],agentsStates:{root:{status:'running'},stranger:{status:'running'}}}});
    assert.deepEqual(out.at(-1)!.map(t=>t.id),['agent:child']);
    m.notification('thread/closed',{threadId:'child'});m.refresh();await flush();
    assert.equal(reads,0);assert.deepEqual(out.at(-1),[]);
  }finally{m.stop();}
});

test('an older snapshot cannot clear a newly started subagent, and close ignores late results',async()=>{
  let release!:(value:any)=>void;
  const out:BackgroundTask[][]=[];
  const m=new CodexActivity(async(method)=>method==='thread/list'?new Promise(r=>{release=r;}):{data:[],nextCursor:null},x=>out.push(x),60000);
  try{
    m.start('root');m.notification('item/completed',{threadId:'root',item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}}}});
    release({data:[],nextCursor:null});await flush();assert.ok(out.at(-1)!.some(t=>t.id==='agent:child'));
    m.refresh();const count=out.length;m.stop();release({data:[],nextCursor:null});await flush();assert.equal(out.length,count);
  }finally{m.stop();}
});

test('last child completion keeps the restart guard until its terminal inventory arrives',async()=>{
  let hold=false,release!:(value:any)=>void;const out:BackgroundTask[][]=[];
  const m=new CodexActivity(async method=>{
    if(method==='thread/list')return {data:[{id:'child',status:{type:'idle'}}],nextCursor:null};
    if(hold)return new Promise(r=>{release=r;});return {data:[],nextCursor:null};
  },tasks=>out.push(tasks));
  try{
    m.start('root');await flush();
    m.notification('thread/status/changed',{threadId:'child',status:{type:'active'}});
    hold=true;const before=out.length;
    m.notification('thread/status/changed',{threadId:'child',status:{type:'idle'}});await flush();
    assert.ok(out.slice(before).every(tasks=>tasks.length>0));
    hold=false;release({data:[{processId:'alive',command:'sleep 30'}],nextCursor:null});await flush();
    assert.ok(out.at(-1)!.some(t=>t.type==='shell'));
  }finally{m.stop();}
});

test('AGY unfinished tools remain unknown after a parent result until their terminal update',()=>{
  let tasks:BackgroundTask[]=[];const activity=new AgyActivity(t=>{tasks=t;});
  activity.acpTool({toolCallId:'cmd',name:'run_command',status:'in_progress'});
  activity.parentResult();assert.equal(tasks[0].state,'unknown');
  activity.acpTool({toolCallId:'cmd',status:'completed'});assert.equal(tasks.length,0);
});

test('polling can resume for late activity after a previous polling cycle became idle',async()=>{
  const f=fixture(10);try{
    f.set([{id:'child',status:{type:'active'}}]);f.monitor.start('root');await flush();
    f.set([]);await new Promise(r=>setTimeout(r,30));assert.equal(f.last().length,0);
    const count=f.requests.length;
    f.set([{id:'late',status:{type:'active'}}]);
    f.monitor.notification('thread/started',{thread:{id:'late',parentThreadId:'root',status:{type:'active'}}});
    await new Promise(r=>setTimeout(r,30));assert.ok(f.requests.length>count);
  }finally{f.monitor.stop();}
});

test('the same activity keeps UI running, blocks replacement and survives reconnect/idle reaping',async()=>{
  let emit!:(m:RunnerToHub)=>void;let closed=0;
  const runner=new Runner('test',()=>{},{idleMs:20,start:opts=>{emit=opts.emit;return {send(){},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval(){},close(){closed++;}};}});
  runner.handle({type:'start',sessionId:'s',engine:'codex',cwd:'/tmp',prompt:'test',permissionMode:'default'});
  const activity=[{id:'child',type:'local_agent',description:'worker'}];
  emit({type:'background',sessionId:'s',tasks:activity});emit({type:'busy',sessionId:'s',busy:false});
  await new Promise(r=>setTimeout(r,40));assert.equal(closed,0);assert.deepEqual(runner.snapshot()[0].background,activity);
  assert.ok(sessionBlockers(runner.snapshot()).includes('백그라운드 작업'));
  const task={status:'done',source:'app',background:activity,pending_questions:0,pending_approvals:0} as unknown as TaskView;
  assert.equal(inBackground(task),true);assert.equal(statusLabel(task),'백그라운드 실행 중');
  assert.equal(taskRunning(task),true);assert.equal(taskRunning({...task,background:[]}),false);
  const unknown={...task,background:activity.map(t=>({...t,state:'unknown' as const}))};
  assert.equal(taskRunning(unknown),true);assert.equal(statusLabel(unknown),'작업 상태 확인 필요');
  assert.equal(stalledMinutes({...task,status:'running',last_event:{ts:'2000-01-01'} as any}),null);
  emit({type:'background',sessionId:'s',tasks:[]});assert.deepEqual(sessionBlockers(runner.snapshot()),[]);
  await new Promise(r=>setTimeout(r,40));assert.equal(closed,1);
});
