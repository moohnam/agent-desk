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
 for(const status of [401,403,422]){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'expected '+status}),{status}));
  await assert.rejects(renderDiagram('bad source'),new RegExp('expected '+status));mock.mock.restore();
 }
});

test('only two hub requests run at once and queued cancellation never reaches fetch',async t=>{
 const result={image:'data:image/svg+xml;utf8,<svg/>',background:'#fff'};
 const started:string[]=[];
 const complete=new Map<string,(response:Response)=>void>();
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
  const {source}=JSON.parse(init.body as string);
  started.push(source);
  const {promise,resolve,reject}=Promise.withResolvers<Response>();
  complete.set(source,resolve);
  init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});
  return promise;
 });
 const inFlight=new AbortController(),queued=new AbortController();
 const first=renderDiagram('first');
 const second=assert.rejects(renderDiagram('second',inFlight.signal),{name:'AbortError'});
 const hidden=assert.rejects(renderDiagram('hidden',queued.signal),{name:'AbortError'});
 const third=renderDiagram('third'),fourth=renderDiagram('fourth');
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(started,['first','second']);
 queued.abort();await hidden;
 complete.get('first')!(new Response(JSON.stringify(result)));
 assert.deepEqual(await first,result);
 assert.deepEqual(started,['first','second','third']);
 inFlight.abort();await second;
 assert.deepEqual(started,['first','second','third','fourth']);
 for(const source of ['third','fourth'])complete.get(source)!(new Response(JSON.stringify(result)));
 assert.deepEqual(await Promise.all([third,fourth]),[result,result]);
});

test('a full browser queue retries after the current diagrams free space',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const result={image:'data:image/svg+xml;utf8,<svg/>',background:'#fff'};
 const started:string[]=[];
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
  started.push(JSON.parse(init.body as string).source);
  return new Response(JSON.stringify(result));
 });
 const renders=Array.from({length:32},(_,index)=>renderDiagram(`diagram-${index}`));
 const overflow=renderDiagram('overflow');
 await Promise.all(renders);
 assert.equal(started.length,32);assert.ok(!started.includes('overflow'));
 t.mock.timers.tick(1000);
 assert.deepEqual(await overflow,result);assert.equal(started.at(-1),'overflow');
});

test('caller cancellation aborts the hub fetch and does not turn into a fallback',async t=>{
 let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
  started();return new Promise<Response>((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));
 });
 const controller=new AbortController();const result=renderDiagram('a',controller.signal);
 await entered;controller.abort();await assert.rejects(result,{name:'AbortError'});
});

test('429, 503 and non-JSON 504 responses retry after backoff',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const result={image:'data:image/svg+xml;utf8,<svg/>',background:'#fff'};
 for(const status of [429,503,504]){
  let calls=0;
  const response=t.mock.method(globalThis,'fetch',async()=>++calls===1
   ?new Response(status===504?'Gateway Timeout':'{"error":"busy"}',{status})
   :new Response(JSON.stringify(result)));
  const pending=renderDiagram('a');await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);t.mock.timers.tick(1000);
  assert.deepEqual(await pending,result);assert.equal(calls,2);
  response.mock.restore();
 }
});

test('a hub render that already spent its timeout retry window never starts again',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1_000});
 let calls=0;
 const timeout=Promise.withResolvers<Response>();
 t.mock.method(globalThis,'fetch',async()=>{calls++;return timeout.promise;});
 const rejected=assert.rejects(renderDiagram('slow diagram'),/도표 처리 시간이 초과됐습니다/);
 await new Promise(r=>setImmediate(r));
 t.mock.timers.tick(40_000);
 timeout.resolve(new Response('{"error":"도표 처리 시간이 초과됐습니다"}',{status:504}));
 await rejected;assert.equal(calls,1);
});

test('congestion retries are bounded and cancellation clears the pending retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{"error":"busy"}',{status:429});});
 const pending=assert.rejects(renderDiagram('a'),/busy/);
 for(const delay of [1000,2000,4000]){await new Promise(r=>setImmediate(r));t.mock.timers.tick(delay);}
 await pending;assert.equal(calls,4);
 const controller=new AbortController();const cancelled=assert.rejects(renderDiagram('a',controller.signal),{name:'AbortError'});
 await new Promise(r=>setImmediate(r));controller.abort();await cancelled;
 t.mock.timers.tick(10000);await new Promise(r=>setImmediate(r));assert.equal(calls,5);
});

test('persistent 503 falls back to the iframe and temporarily skips the hub',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1_000});
 for(const name of ['document','window','location']){
  const original=Object.getOwnPropertyDescriptor(globalThis,name);
  t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);});
 }
 const result={image:'data:image/svg+xml;utf8,<svg/>',background:'#fff'};
 let calls=0,frames=0,removed=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{"error":"unavailable"}',{status:503});});
 Object.defineProperties(globalThis,{
  location:{configurable:true,value:{href:'http://localhost/',origin:'http://localhost'}},
  window:{configurable:true,value:{postMessage(_message:unknown,_origin:string,[port]:MessagePort[]){
   port.onmessage=({data})=>port.postMessage({id:data.id,result});
   port.postMessage({ready:true});
  }}},
  document:{configurable:true,value:{
   createElement(){frames++;return {style:{},contentWindow:{},setAttribute(){},remove(){removed++;}};},
   body:{append(frame:{onload:()=>void}){queueMicrotask(()=>frame.onload());}},
  }},
 });
 const pending=renderDiagram('a');
 for(const delay of [1000,2000,4000]){await new Promise(r=>setImmediate(r));t.mock.timers.tick(delay);}
 assert.deepEqual(await pending,result);assert.equal(calls,4);assert.equal(frames,1);
 assert.deepEqual(await renderDiagram('b'),result);assert.equal(calls,4);assert.equal(frames,1);
 t.mock.timers.tick(5000);assert.equal(removed,1);
});
