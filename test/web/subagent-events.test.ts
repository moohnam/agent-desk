import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from '../../web/src/api.ts';

// Run the real hook with React, without a DOM renderer or copied paging implementation.
const require=createRequire(import.meta.url);
let source=readFileSync(new URL('../../web/src/subagents.tsx',import.meta.url),'utf8');
source=source.slice(0,source.indexOf('/** Under the post')).replace(/^import .*lucide-react.*\n/m,'').replace(/^import '\.\/subagent-panel.css';\n/m,'');
source=source.replace("from 'react'",`from '${pathToFileURL(require.resolve('react'))}'`)
 .replace("from './api.ts'",`from '${new URL('../../web/src/api.ts',import.meta.url)}'`)
 .replace("from './posts.ts'",`from '${new URL('../../web/src/posts.ts',import.meta.url)}'`);
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {useSubagentEvents,useSubagents,reportSubagent,hasSubagentPaneTarget,backgroundRunningCount}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const event=(id:number,task_id='t')=>({id,subagent_id:'a',task_id,session_id:'s',kind:'assistant',payload:{text:'step '+id}});

test('subagent initial SSE, older cursor, reconnect gaps and stale task loads converge',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const priorWindow=(globalThis as any).window;
  (globalThis as any).window={HTMLIFrameElement:class {}};
  const doc={nodeType:9,addEventListener(){},defaultView:(globalThis as any).window};
  const container={nodeType:1,tagName:'DIV',ownerDocument:doc,addEventListener(){},namespaceURI:'http://www.w3.org/1999/xhtml'};
  const original=api.subagentEvents;
  let state:any;
  const requests:{task:string,before?:number,resolve:(v:any)=>void,reject:(e:Error)=>void}[]=[];
  api.subagentEvents=(s,before)=>new Promise((resolve,reject)=>requests.push({task:s.task_id,before,resolve,reject}));
  const Column=({task='t',reload=0})=>{state=useSubagentEvents({id:'a',task_id:task,session_id:'s'},reload);return null;};
  const root=createRoot(container as any);
  const deliver=async(events:any[],more:boolean)=>{const r=requests.shift()!;assert.ok(r);await act(async()=>r.resolve({events,more}));return r;};
  try{
    await act(()=>root.render(createElement(Column)));
    assert.equal(requests.length,1,'only one initial load');
    await act(()=>reportSubagent({type:'subagent_event',event:event(502)}));
    await deliver(Array.from({length:500},(_,i)=>event(i+2)),true);
    assert.equal(state.more,true);assert.equal(state.events.length,501);
    await act(()=>{void state.older();});assert.equal(requests[0].before,2);
    await deliver([event(1)],false);assert.equal(state.events.length,502);assert.equal(state.more,false);
    await act(()=>root.render(createElement(Column,{reload:1})));
    await act(()=>reportSubagent({type:'subagent_event',event:event(1602)}));
    await deliver(Array.from({length:500},(_,i)=>event(i+1102)),true);
    assert.equal(requests[0].before,1102);
    // Failure partway through a reconnect must not advance the committed coverage boundary.
    await act(async()=>requests.shift()!.reject(Error('offline')));
    await act(()=>root.render(createElement(Column,{reload:2})));
    await deliver(Array.from({length:500},(_,i)=>event(i+1102)),true);
    await deliver(Array.from({length:500},(_,i)=>event(i+602)),true);
    assert.equal(requests[0].before,602);
    await deliver(Array.from({length:500},(_,i)=>event(i+102)),true);
    assert.equal(state.events.length,1602);assert.equal(state.more,false);assert.equal(state.error,undefined);
    assert.deepEqual(state.events.map((e:any)=>e.id),Array.from({length:1602},(_,i)=>i+1));
    await act(()=>root.render(createElement(Column,{reload:3})));
    const stale=requests.shift()!;
    await act(()=>root.render(createElement(Column,{task:'other',reload:3})));
    await deliver([event(9000,'other')],false);
    await act(async()=>stale.resolve({events:[event(9999)],more:true}));
    assert.deepEqual(state.events.map((e:any)=>e.id),[9000]);
    await act(()=>root.render(createElement(Column,{task:'empty',reload:0})));
    await deliver([],false);
    await act(()=>root.render(createElement(Column,{task:'empty',reload:1})));
    await deliver(Array.from({length:500},(_,i)=>event(i+501,'empty')),true);
    assert.equal(requests[0].before,501,'empty initial history still fills reconnect gaps');
    await deliver(Array.from({length:500},(_,i)=>event(i+1,'empty')),false);
    assert.equal(state.events.length,1000);assert.equal(state.more,false);
  }finally{await act(()=>root.unmount());api.subagentEvents=original;(globalThis as any).window=priorWindow;}
});


test('subagent list retains SSE on failed initial load and merges it into a later reload',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const priorWindow=(globalThis as any).window;
  (globalThis as any).window={HTMLIFrameElement:class {}};
  const doc={nodeType:9,addEventListener(){},defaultView:(globalThis as any).window};
  const container={nodeType:1,tagName:'DIV',ownerDocument:doc,addEventListener(){},namespaceURI:'http://www.w3.org/1999/xhtml'};
  const original=api.subagents;
  const requests:{resolve:(v:any)=>void,reject:(e:Error)=>void}[]=[];
  api.subagents=()=>new Promise((resolve,reject)=>requests.push({resolve,reject}));
  let state:any[]=[];
  const Column=({reload=0})=>{state=useSubagents('t',reload);return null;};
  const root=createRoot(container as any);
  const item=(id:string,status='running',updated_at='2026-01-01T00:00:00Z')=>({id,task_id:'t',session_id:'s',type:'local_agent',status,updated_at});
  try{
    await act(()=>root.render(createElement(Column)));
    await act(()=>reportSubagent({type:'subagent',subagent:item('live')}));
    await act(async()=>requests.shift()!.reject(Error('offline')));
    assert.deepEqual(state.map(s=>s.id),['live']);
    await act(()=>reportSubagent({type:'subagent',subagent:item('live','completed','2026-01-01T00:00:01Z')}));
    assert.equal(state[0].status,'completed');
    await act(()=>root.render(createElement(Column,{reload:1})));
    await act(()=>reportSubagent({type:'subagent',subagent:item('live','completed','2026-01-01T00:00:01Z')}));
    await act(async()=>requests.shift()!.resolve([item('past','completed'),item('live')]));
    assert.deepEqual(state.map(s=>s.id),['past','live']);
    assert.equal(state[1].status,'completed');
  }finally{await act(()=>root.unmount());api.subagents=original;(globalThis as any).window=priorWindow;}
});

test('snapshot counts and post links exclude foreground, unproven and ended commands',()=>{
  const item=(type:string,extra:object={})=>({type,id:type,description:type,...extra});
  assert.equal(backgroundRunningCount([item('tool'),item('status'),item('shell'),item('local_bash')]),0);
  assert.equal(backgroundRunningCount([item('tool'),item('shell',{backgroundEvidence:'native'}),item('local_agent')]),2);
  assert.equal(hasSubagentPaneTarget(item('shell',{status:'running',backgroundEvidence:'native'})),true);
  assert.equal(hasSubagentPaneTarget(item('shell',{status:'completed',backgroundEvidence:'native'})),false);
  assert.equal(hasSubagentPaneTarget(item('local_bash',{status:'running',detailed:true,background:false})),false);
  assert.equal(hasSubagentPaneTarget(item('local_agent',{status:'completed'})),true);
});

test('common history retains read pages across membership changes and isolates resumed sources',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const prior=(globalThis as any).window;(globalThis as any).window={HTMLIFrameElement:class {}};
 const doc={nodeType:9,addEventListener(){},defaultView:(globalThis as any).window};
 const container={nodeType:1,tagName:'DIV',ownerDocument:doc,addEventListener(){},namespaceURI:'http://www.w3.org/1999/xhtml'};
 const original=api.subagentHistory,originalDetail=api.subagentEvents;
 api.subagentEvents=async s=>({events:[{...event(5),subagent_id:s.id}],more:false}) as any;
 const requests:{before?:number;resolve:(v:any)=>void;reject:(e:Error)=>void}[]=[];let state:any;
 api.subagentHistory=(_task,before)=>new Promise((resolve,reject)=>requests.push({before,resolve,reject}));
 const members=(ids:string[],task:string)=>ids.map(id=>({id,task_id:task,session_id:'s'}));
 const History=({ids=['a'],reload=0,task='t'})=>{state=useSubagentEvents(undefined,reload,{taskId:task,members:members(ids,task)});return null;};
 const root=createRoot(container as any);const deliver=async(events:any[],more=false)=>{await act(async()=>requests.shift()!.resolve({events,more}));};
 try{
  await act(()=>root.render(createElement(History)));
  await deliver([event(600)],true);
  await act(()=>reportSubagent({type:'subagent_event',event:{...event(601),subagent_id:'running'}}));
  assert.deepEqual(state.events.map((e:any)=>e.id),[600]);
  await act(()=>{void state.older();});assert.equal(requests[0].before,600);await deliver([event(10)],true);
  await act(()=>root.render(createElement(History,{ids:['a','b']})));
  assert.ok(state.events.some((e:any)=>e.id===10),'read records stay present while refreshing membership');
  await deliver(Array.from({length:500},(_,i)=>event(101+i)),true);
  assert.ok(state.events.some((e:any)=>e.id===10),'latest page need not contain the old read card');
  assert.equal(requests[0].before,101);
  await act(async()=>requests.shift()!.reject(Error('offline during repair')));
  await act(()=>{void state.older();});
  assert.equal(requests[0].before,undefined,'older retries interrupted repair before advancing its cursor');
  await deliver(Array.from({length:500},(_,i)=>event(101+i)),true);
  assert.equal(requests[0].before,101);
  await deliver([event(10),{...event(11),subagent_id:'b'}]);
  assert.ok(state.events.some((e:any)=>e.id===11),'repair restores records absent from the individual latest page');
  assert.ok(state.events.some((e:any)=>e.id===10));
  assert.equal(state.events.filter((e:any)=>e.id===5).length,1);
  await act(()=>root.render(createElement(History,{ids:['b']})));
  await deliver([{...event(5),subagent_id:'b'}]);
  await act(()=>reportSubagent({type:'subagent_event',event:event(602)}));
  assert.deepEqual(state.events.map((e:any)=>e.id),[5,11],'resumed agent history must leave the common column');
  await act(()=>root.render(createElement(History,{ids:['b'],reload:1})));
  const stale=requests.shift()!;
  await act(()=>root.render(createElement(History,{task:'other',ids:['b']})));
  await deliver([{...event(9000,'other'),subagent_id:'b'}]);
  await act(async()=>stale.resolve({events:[event(999)],more:true}));
  assert.deepEqual(state.events.map((e:any)=>e.id),[9000],'parent switches discard old read windows and stale responses');
 }finally{await act(()=>root.unmount());api.subagentHistory=original;api.subagentEvents=originalDetail;(globalThis as any).window=prior;}
});
