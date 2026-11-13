import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderDiagram} from '../../web/src/hubDiagram.ts';

test('hub SVG results are returned without loading a client renderer',async t=>{
 const result={image:'data:image/svg+xml;utf8,<svg/>',background:'#fff'};
 t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
  assert.equal(url,'/api/diagram');assert.equal(JSON.parse(init.body as string).source,'flowchart LR\nA-->B');
  return new Response(JSON.stringify(result));
 });
 assert.deepEqual(await renderDiagram('flowchart LR\nA-->B'),result);
});

test('syntax and authorization errors do not fall back to another renderer',async t=>{
 for(const status of [401,403,422,429,504]){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'expected '+status}),{status}));
  await assert.rejects(renderDiagram('bad source'),new RegExp('expected '+status));mock.mock.restore();
 }
});

test('caller cancellation aborts the hub fetch and does not turn into a fallback',async t=>{
 let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
  started();return new Promise<Response>((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
 });
 const controller=new AbortController();const result=renderDiagram('a',controller.signal);
 await entered;controller.abort();await assert.rejects(result,{name:'AbortError'});
});
