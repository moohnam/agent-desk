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
source=source.slice(0,source.indexOf('const STATUS:')).replace(/^import .*lucide-react.*\n/m,'').replace(/^import '\.\/subagent-panel.css';\n/m,'');
source=source.replace("from 'react'",`from '${pathToFileURL(require.resolve('react'))}'`)
 .replace("from './api.ts'",`from '${new URL('../../web/src/api.ts',import.meta.url)}'`)
 .replace("from './posts.ts'",`from '${new URL('../../web/src/posts.ts',import.meta.url)}'`);
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {useSubagentEvents,reportSubagent}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
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
