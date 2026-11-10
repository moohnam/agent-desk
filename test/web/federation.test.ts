import { mergeEvents, mergeTaskEvents } from '../../web/src/posts.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../../web/src/api.ts';
import { compareEvents, composeSource, discoverSources, eventId, mapEvent, mapMessage, mapState, scopeId, sourceFilter, splitId } from '../../web/src/federation.ts';
import type { DeskState, HubEvent } from '../../web/src/types.ts';

const event=(id:number,ts='2026-11-10T00:00:00.000Z'):HubEvent=>({id,ts,task_id:'task',session_id:'session',kind:'assistant',payload:{text:'hello'}});
const state=():DeskState=>({projects:[{id:'project',name:'same',root_path:'/tmp/project',created_at:''}],tasks:[{id:'task',project_id:'project',seq:1,title:'task',status:'done',checkpoint_md:null,created_by:'me',created_at:'',updated_at:'',project_name:'same',engine:'claude',permission_mode:'default',model:null,effort:null,live:false,source:'app',last_event:event(1),pending_approvals:1,pending_questions:1,pending_ask:{event_id:1,text:'ask',ts:''},queued:[{id:'queue',text:'later',created_at:''}],background:[]}],approvals:[{id:'approval',task_id:'task',session_id:'session',status:'pending',tool_name:'Bash',input:{},created_at:''}],questions:[{id:'question',task_id:'task',session_id:'session',status:'pending',text:'?',answer:null,created_at:'',answered_at:null}],runner:{connected:true}});

test('source identities isolate tasks, events, approvals, questions and queues without changing local IDs',()=>{
 const a=mapState('a',1,state()),b=mapState('b',2,state());
 assert.notEqual(a.tasks[0].id,b.tasks[0].id);assert.notEqual(a.tasks[0].last_event!.id,b.tasks[0].last_event!.id);
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

test('unified API pages equal timestamps without gaps, routes writes and keeps offline SSE updates',async()=>{
 const original=globalThis.fetch;const calls:{path:string;body:any;method:string}[]=[];
 let offline=false;let duringState:(()=>void)|undefined;
 const sourceRows=[{id:'a',view_index:1,name:'remote',url:'',workspace_id:'uuid',pending:0}];
 const data=[event(1),event(2),event(3,'2026-11-10T00:00:01.000Z')];
 globalThis.fetch=async(input,init)=>{
   const path=String(input),url=new URL(path,'http://desk');
   const remote=path.startsWith('/api/workspaces/a/');const route=url.pathname.replace(remote?'/api/workspaces/a':'/api','');
   const body=init?.body?JSON.parse(String(init.body)):undefined;
   calls.push({path,body,method:init?.method??'GET'});
   if(path==='/api/workspaces')return Response.json(sourceRows);
   if(remote&&offline)throw Error('offline');
   if(route==='/state'){if(remote)duringState?.();return Response.json(state());}
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
   await assert.rejects(api.sendChannel('local-channel',{text:'summarize',project_id:'w:a:project'}),/같은 허브/);
   await api.resolve('w:a:approval',true);assert.equal(calls.at(-1)!.path,'/api/workspaces/a/approvals/approval');
   await api.answer('w:a:question','answer');assert.equal(calls.at(-1)!.path,'/api/workspaces/a/questions/question');
   await api.requestHandoff('w:a:task',{picked:[eventId(1,2)]});assert.deepEqual(calls.at(-1)!.body.picked,[2]);
   assert.throws(()=>api.compose('@same hello'),/여러 작업공간/);
   assert.equal((await api.compose('@same hello','a')).id,'w:a:task');
   const newTask={...s.tasks[1],id:'w:a:new'};
   duringState=()=>api.remember('a',{type:'task',task:newTask});await api.state();duringState=undefined;offline=true;
   const disconnected=await api.state();assert.ok(disconnected.tasks.some(t=>t.id==='w:a:new'&&t.runner_connected===false));
   await assert.rejects(api.feed(2,event(3)),/offline/); // Failed paging must remain retryable, not mark the end.
   assert.equal((await api.feed(2)).length,2); // Local feed remains useful.
 }finally{globalThis.fetch=original;}
});


test('thread pagination keeps ID order when a disconnected runner reports older timestamps later',()=>{
 const earlier=event(1,'2026-11-10T00:00:01.000Z'),delayed=event(2,'2026-11-09T00:00:00.000Z');
 assert.deepEqual(mergeEvents([],[earlier,delayed]).map(e=>e.id),[2,1]);
 assert.deepEqual(mergeTaskEvents([],[earlier,delayed]).map(e=>e.id),[1,2]);
 assert.deepEqual(mergeTaskEvents([delayed],[earlier]).map(e=>e.id),[1,2]);
});
