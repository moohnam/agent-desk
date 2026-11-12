import { mergeEvents, mergeTaskEvents } from '../../web/src/posts.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../../web/src/api.ts';
import { compareEvents, composeSource, discoverSources, eventId, legacyTaskId, mapEvent, mapMessage, mapState, scopeId, sourceFilter, splitId } from '../../web/src/federation.ts';
import type { DeskState, HubEvent } from '../../web/src/types.ts';

const event=(id:number,ts='2026-11-10T00:00:00.000Z'):HubEvent=>({id,ts,task_id:'task',session_id:'session',kind:'assistant',payload:{text:'hello'}});
const state=():DeskState=>({projects:[{id:'project',name:'same',root_path:'/tmp/project',created_at:''}],tasks:[{id:'task',project_id:'project',seq:1,title:'task',status:'done',checkpoint_md:null,created_by:'me',created_at:'',updated_at:'',project_name:'same',engine:'claude',permission_mode:'default',model:null,effort:null,live:false,source:'app',last_event:event(1),pending_approvals:1,pending_questions:1,pending_ask:{event_id:1,text:'ask',ts:''},queued:[{id:'queue',text:'later',created_at:''}],background:[]}],approvals:[{id:'approval',task_id:'task',session_id:'session',status:'pending',tool_name:'Bash',input:{},created_at:''}],questions:[{id:'question',task_id:'task',session_id:'session',status:'pending',text:'?',answer:null,created_at:'',answered_at:null}],runner:{connected:true}});

test('source identities isolate tasks, events, approvals, questions and queues without changing local IDs',()=>{
 const input=state();input.tasks[0].runner_id='runner';input.tasks[0].runner_label='person@worker';
 const a=mapState('a',1,input),b=mapState('b',2,input);
 assert.notEqual(a.tasks[0].id,b.tasks[0].id);assert.notEqual(a.tasks[0].last_event!.id,b.tasks[0].last_event!.id);
 assert.equal(a.tasks[0].runner_id,scopeId('a','runner'));assert.equal(a.tasks[0].runner_label,'person@worker');
 assert.equal(a.tasks[0].pending_ask!.event_id,eventId(1,1));assert.equal(a.tasks[0].queued[0].id,scopeId('a','queue'));
 assert.equal(a.approvals[0].task_id,a.tasks[0].id);assert.equal(a.questions[0].id,scopeId('a','question'));
 const e=mapEvent('a',1,{...event(1),kind:'approval',payload:{approvalId:'approval',answers:'question'}});
 assert.equal(e.payload.approvalId,a.approvals[0].id);assert.equal(e.payload.answers,a.questions[0].id);
 assert.equal(mapMessage('a',1,{type:'runner',connected:false}),null);
 assert.deepEqual(splitId(a.tasks[0].id),['a','task']);assert.equal(mapState('',0,state()).tasks[0].last_event!.id,1);
 assert.equal(sourceFilter('a',{taskIds:['task']}),null);assert.equal(sourceFilter('',{taskIds:[]}),null);
 assert.deepEqual(sourceFilter('b',{taskIds:[a.tasks[0].id,b.tasks[0].id],q:'find'}),{taskIds:['task'],q:'find'});
 assert.throws(()=>composeSource('@same hello',[...state().projects,...a.projects]),/여러 작업공간/);
 assert.equal(composeSource('@same hello',a.projects),'a');assert.equal(composeSource('#claude @same hello',a.projects),'a');assert.equal(composeSource('@same hello',a.projects,''),'');
});

test('renaming a shared task routes to its source and scopes the returned task', async () => {
 const original=globalThis.fetch;
 const source='rename-source', id=scopeId(source,'task');
 const requests:{path:string;method:string;body:any;operation:string|null}[]=[];
 globalThis.fetch=async(input,init)=>{
   const path=String(input);
   if(path==='/api/workspaces')return Response.json([{id:source,view_index:3,name:'workspace',url:'',workspace_id:'uuid',pending:0}]);
   requests.push({path,method:init?.method??'GET',body:JSON.parse(String(init?.body)),operation:new Headers(init?.headers).get('x-desk-operation-id')});
   return Response.json({...state().tasks[0],title:'새 제목',title_revision:1});
 };
 try {
   const updated=await api.renameTask(id,'새 제목');
   assert.equal(updated.id,id);
   assert.equal(updated.project_id,scopeId(source,'project'));
   assert.equal(updated.title,'새 제목');
   assert.equal(updated.title_revision,1);
   assert.deepEqual(requests.map(r=>[r.path,r.method,r.body.title]),[[`/api/workspaces/${source}/tasks/task`,'PATCH','새 제목']]);
   assert.ok(requests[0].operation,'shared writes use a stable operation ID');
 }finally{globalThis.fetch=original;}
});

test('migrated remote records appear once, old task links resolve, and offline snapshots respect removal',async()=>{
 const original=globalThis.fetch;
 const source='remote-runner', task='moved-task', project='moved-project';
 const row={id:source,view_index:4,name:'remote',url:'',workspace_id:'uuid',pending:0,
   legacy_task_ids:[task],legacy_project_ids:[project],legacy_approval_ids:[],legacy_question_ids:[]};
 let offline=false;
 const calls:string[]=[];
 globalThis.fetch=async(input)=>{
   const path=String(input),url=new URL(path,'http://desk');calls.push(path);
   if(path==='/api/workspaces')return Response.json([row]);
   const remote=url.pathname.startsWith(`/api/workspaces/${source}/`);
   const route=url.pathname.replace(remote?`/api/workspaces/${source}`:'/api','');
   if(remote&&offline)throw Error('offline');
   if(route==='/state') {
     if(!remote)return Response.json({...state(),projects:[],tasks:[],approvals:[],questions:[]});
     const value=state();value.projects[0].id=project;value.tasks[0].id=task;value.tasks[0].project_id=project;
     value.tasks[0].last_event={...event(11),task_id:task};value.approvals=[];value.questions=[];
     return Response.json(value);
   }
   if(route==='/feed')return Response.json(remote?[{...event(11),task_id:task}]:[]);
   if(route==='/compose')return Response.json({...state().tasks[0],id:task,project_id:project});
   return Response.json({ok:true});
 };
 try {
   await discoverSources(true);
   assert.equal(legacyTaskId(task),scopeId(source,task));
   const first=await api.state();
   assert.deepEqual(first.availableSources?.sort(),['','remote-runner']);
   assert.deepEqual(first.projects.map(p=>p.id),[scopeId(source,project)]);
   assert.deepEqual(first.tasks.map(t=>t.id),[scopeId(source,task)]);
   assert.deepEqual((await api.feed()).map(e=>e.id),[eventId(4,11)]);
   assert.equal((await api.compose('@same hello')).id,scopeId(source,task));
   assert.ok(calls.at(-1)!.startsWith(`/api/workspaces/${source}/compose`));
   await api.send(scopeId(source,task),'hello');
   assert.ok(calls.at(-1)!.startsWith(`/api/workspaces/${source}/tasks/${task}/messages`));
   offline=true;
   const unavailable=await api.state();
   assert.equal(unavailable.tasks[0].runner_connected,false);
   assert.deepEqual(unavailable.availableSources,['']);
   api.remember(source,{type:'removed',taskIds:[scopeId(source,task)],projectIds:[scopeId(source,project)]});
   const removed=await api.state();
   assert.deepEqual(removed.tasks,[]);assert.deepEqual(removed.projects,[]);
 }finally{globalThis.fetch=original;}
});

test('unified API pages equal timestamps without gaps, routes writes and keeps offline SSE updates',async()=>{
 const original=globalThis.fetch;const calls:{path:string;body:any;method:string}[]=[];
 let offline=false;let duringState:(()=>void)|undefined;
 let remoteProjectName='same',remoteProjectDeleted=false;
 let remoteStateGate:Promise<void>|undefined,remoteStateEntered:(()=>void)|undefined;
 const sourceRows=[{id:'a',view_index:1,name:'remote',url:'',workspace_id:'uuid',pending:0}];
 const data=[event(1),event(2),event(3,'2026-11-10T00:00:01.000Z')];
 globalThis.fetch=async(input,init)=>{
   const path=String(input),url=new URL(path,'http://desk');
   const remote=path.startsWith('/api/workspaces/a/');const route=url.pathname.replace(remote?'/api/workspaces/a':'/api','');
   const body=init?.body?JSON.parse(String(init.body)):undefined;
   calls.push({path,body,method:init?.method??'GET'});
   if(path==='/api/workspaces')return Response.json(sourceRows);
   if(remote&&offline)throw Error('offline');
   if(route==='/state'){
     if(remote){duringState?.();if(remoteStateGate){remoteStateEntered?.();await remoteStateGate;}const value=state();value.projects=remoteProjectDeleted?[]:[{...value.projects[0],name:remoteProjectName}];return Response.json(value);}
     return Response.json(state());
   }
   if(route==='/feed'){
     const ts=url.searchParams.get('before_ts')!,id=Number(url.searchParams.get('cursor_id'));
     return Response.json(data.filter(e=>e.ts<ts||e.ts===ts&&e.id<id).slice(-Number(url.searchParams.get('limit'))));
   }
   if(route==='/feed/count')return Response.json({posts:3,tasks:1});
   if(route==='/tasks/task/events')return Response.json({events:[event(1)],more:false});
   if(route==='/tasks/task/messages')return Response.json({task_id:'task',queued_id:'queue'});
   if(route==='/compose')return Response.json(state().tasks[0]);
   return Response.json({ok:true});
 };
 try{
   await discoverSources(true);const s=await api.state();assert.equal(s.tasks.length,2);assert.equal(s.approvals.length,2);
   const found:HubEvent[]=[];let before:HubEvent|undefined;
   for(let i=0;i<4;i++){const page=await api.feed(2,before);found.push(...page);if(!page.length)break;before=page[0];}
   assert.deepEqual(found.map(e=>e.id).sort((a,b)=>a-b),[1,2,3,eventId(1,1),eventId(1,2),eventId(1,3)]);
   assert.deepEqual([...found].sort(compareEvents).map(e=>e.id),[1,2,eventId(1,1),eventId(1,2),3,eventId(1,3)]);
   const start=calls.length;assert.deepEqual(await api.feed(2,undefined,{taskIds:[]}),[]);assert.equal(calls.length,start);
   await api.feed(2,undefined,{taskIds:['w:a:task']});assert.equal(calls.at(-1)!.path.includes('/workspaces/a/feed?'),true);
   await api.events('w:a:task',{before:eventId(1,4),ids:[eventId(1,1)]});assert.match(calls.at(-1)!.path,/ids=1&before=4/);
   assert.deepEqual(await api.send('w:a:task','reply'),{task_id:'w:a:task',queued_id:'w:a:queue'});
   await api.sendQueuedNow('w:a:task','w:a:queue');assert.equal(calls.at(-1)!.path,'/api/workspaces/a/tasks/task/queue/queue/send');
   await api.open('/tmp/report.html','w:a:task');assert.equal(calls.at(-1)!.path,'/api/workspaces/a/open');assert.deepEqual(calls.at(-1)!.body,{href:'/tmp/report.html',task_id:'task'});
   await assert.rejects(api.sendChannel('local-channel',{text:'summarize',project_id:'w:a:project'}),/같은 허브/);
   await api.resolve('w:a:approval',true);assert.equal(calls.at(-1)!.path,'/api/workspaces/a/approvals/approval');
   await api.answer('w:a:question','answer');assert.equal(calls.at(-1)!.path,'/api/workspaces/a/questions/question');
   await api.requestHandoff('w:a:task',{picked:[eventId(1,2)]});assert.deepEqual(calls.at(-1)!.body.picked,[2]);
   assert.throws(()=>api.compose('@same hello'),/여러 작업공간/);
   assert.equal((await api.compose('@same hello','a')).id,'w:a:task');
   remoteProjectName='deleted-shared';await api.state();remoteProjectDeleted=true;
   api.remember('a',{type:'removed',taskIds:[scopeId('a','task')],projectIds:[scopeId('a','project')]});
   await api.compose('@deleted-shared:/tmp/recreated-shared');
   assert.equal(calls.at(-1)!.path,'/api/compose');
   const newTask={...s.tasks[1],id:'w:a:new'};
   duringState=()=>api.remember('a',{type:'task',task:newTask});await api.state();duringState=undefined;offline=true;
   const disconnected=await api.state();assert.ok(disconnected.tasks.some(t=>t.id==='w:a:new'&&t.runner_connected===false));
   assert.ok(!disconnected.projects.some(p=>p.name==='deleted-shared'));
   await api.compose('@deleted-shared:/tmp/recreated-shared');assert.equal(calls.at(-1)!.path,'/api/compose');
   await assert.rejects(api.feed(2,event(3)),/offline/); // Failed paging must remain retryable, not mark the end.
   assert.equal((await api.feed(2)).length,2); // Local feed remains useful.
   offline=false;
   let enterRemote!:()=>void,releaseRemote!:()=>void;
   const entered=new Promise<void>(resolve=>{enterRemote=resolve;});
   remoteStateGate=new Promise<void>(resolve=>{releaseRemote=resolve;});remoteStateEntered=enterRemote;
   const pendingState=api.state();await entered;
   api.remember('',{type:'removed',taskIds:['task'],projectIds:['project']});
   releaseRemote();const afterLocalRemoval=await pendingState;
   remoteStateGate=undefined;remoteStateEntered=undefined;
   assert.ok(!afterLocalRemoval.projects.some(p=>p.id==='project'));
   assert.ok(! (await api.state()).projects.some(p=>p.id==='project'));
 }finally{globalThis.fetch=original;}
});

test('local authority outage preserves known local IDs while a live shared source remains readable',async()=>{
 const original=globalThis.fetch;
 let localFailure=0;
 const sourceRows=[{id:'a',view_index:1,name:'remote',url:'',workspace_id:'uuid',pending:0}];
 globalThis.fetch=async(input)=>{
   const path=String(input),url=new URL(path,'http://desk');
   if(path==='/api/workspaces')return Response.json(sourceRows);
   const remote=url.pathname.startsWith('/api/workspaces/a/');
   const route=url.pathname.replace(remote?'/api/workspaces/a':'/api','');
   if(!remote&&localFailure&&['/state','/feed','/feed/count'].includes(route))
     return Response.json({error:'로컬 작업공간 연결 끊김'},{status:localFailure});
   if(route==='/state')return Response.json(state());
   if(route==='/feed')return Response.json([event(remote?1:2)]);
   if(route==='/feed/count')return Response.json({posts:1,tasks:1});
   return Response.json({ok:true});
 };
 try{
   await discoverSources(true);
   const before=await api.state();
   assert.deepEqual(before.tasks.map(task=>task.id).sort(),['task','w:a:task']);
   localFailure=503;
   const disconnected=await api.state();
   assert.ok(disconnected.unavailableSources?.includes(''));
   assert.deepEqual(disconnected.tasks.map(task=>task.id).sort(),['task','w:a:task']);
   assert.equal(disconnected.tasks.find(task=>task.id==='task')?.runner_connected,false);
   assert.notEqual(disconnected.tasks.find(task=>task.id==='w:a:task')?.runner_connected,false);
   assert.deepEqual((await api.feed()).map(post=>post.id),[eventId(1,1)]);
   assert.deepEqual(await api.feedCount({}),{posts:1,tasks:1});
   for(const status of [401,403]){
     localFailure=status;
     await assert.rejects(api.state(),/로컬 작업공간 연결 끊김/);
     await assert.rejects(api.feed(),/글을 불러오지 못했습니다|로컬 작업공간 연결 끊김/);
     await assert.rejects(api.feedCount({}),/글 수를 불러오지 못했습니다|로컬 작업공간 연결 끊김/);
   }
   localFailure=0;
   const restored=await api.state();
   assert.ok(!restored.unavailableSources?.includes(''));
   assert.deepEqual(restored.tasks.map(task=>task.id).sort(),['task','w:a:task']);
   assert.equal(restored.tasks.find(task=>task.id==='task')?.runner_connected,undefined);
 }finally{globalThis.fetch=original;}
});


test('thread pagination keeps ID order when a disconnected runner reports older timestamps later',()=>{
 const earlier=event(1,'2026-11-10T00:00:01.000Z'),delayed=event(2,'2026-11-09T00:00:00.000Z');
 assert.deepEqual(mergeEvents([],[earlier,delayed]).map(e=>e.id),[2,1]);
 assert.deepEqual(mergeTaskEvents([],[earlier,delayed]).map(e=>e.id),[1,2]);
 assert.deepEqual(mergeTaskEvents([delayed],[earlier]).map(e=>e.id),[1,2]);
});

test('a failed remote feed marks a partial newest page without discarding local posts',async()=>{
 const original=globalThis.fetch;
 let remoteFailure=true;
 const sourceRows=[{id:'a',view_index:1,name:'remote',url:'',workspace_id:'uuid',pending:0}];
 globalThis.fetch=async(input)=>{
   const path=String(input),url=new URL(path,'http://desk');
   if(path==='/api/workspaces')return Response.json(sourceRows);
   if(url.pathname.endsWith('/feed')){
     if(path.startsWith('/api/workspaces/a/'))return remoteFailure
       ? Response.json({error:'temporary'},{status:503}) : Response.json([event(2)]);
     return Response.json([event(1)]);
   }
   return Response.json({ok:true});
 };
 try{
   await discoverSources(true);
   const partial=await api.feedPage();
   assert.equal(partial.complete,false);
   assert.equal(partial.events.map(e=>e.id).join(','),'1');
   assert.equal((await api.feed()).map(e=>e.id).join(','),'1','the existing partial-results API remains usable');
   remoteFailure=false;
   const recovered=await api.feedPage();
   assert.equal(recovered.complete,true);
   assert.equal(recovered.events.map(e=>e.id).join(','),`1,${eventId(1,2)}`);
 }finally{globalThis.fetch=original;}
});
