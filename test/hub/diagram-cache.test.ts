import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiagramCache } from '../../hub/src/diagram-cache.ts';

const svg=(text:string)=>({image:'data:image/svg+xml;utf8,'+text,background:'#fff'});

test('identical diagrams share one job; version and source changes invalidate the result',async()=>{
 let calls=0;
 const cache=new DiagramCache(async text=>{calls++;await new Promise(r=>setTimeout(r,0));return svg(text);});
 try {
  assert.deepEqual(await Promise.all([cache.render('a','v1'),cache.render('a','v1')]),[svg('a'),svg('a')]);
  await cache.render('a','v1');assert.equal(calls,1);
  await cache.render('a','v2');await cache.render('b','v2');assert.equal(calls,3);
 }finally{cache.close();}
});

test('SVG cache evicts least recently used entries and expires idle results after 24 hours',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000});
 let calls=0;const cache=new DiagramCache(async text=>{calls++;return svg(text);});
 try {
  for(let n=0;n<128;n++)await cache.render(String(n),'v');
  await cache.render('0','v');await cache.render('128','v');await cache.render('0','v');
  assert.equal(calls,129);await cache.render('1','v');assert.equal(calls,130);
  t.mock.timers.tick(24*60*60*1000+1);await cache.render('0','v');assert.equal(calls,131);
 }finally{cache.close();}
});

test('cancelled waiters do not cancel shared work and abandoned queued work never starts',async()=>{
 let release!:()=>void,started!:()=>void;
 const startedPromise=new Promise<void>(r=>{started=r;});const block=new Promise<void>(r=>{release=r;});
 const draws:string[]=[];
 const cache=new DiagramCache(async text=>{draws.push(text);started();await block;return svg(text);});
 const controller=new AbortController(),abandoned=new AbortController();
 try {
  const a=cache.render('a','v',controller.signal);const b=cache.render('a','v');
  await startedPromise;
  const c=cache.render('c','v',abandoned.signal);
  controller.abort();abandoned.abort();
  await assert.rejects(a,{name:'AbortError'});await assert.rejects(c,{name:'AbortError'});
  release();assert.deepEqual(await b,svg('a'));
  await cache.render('a','v');assert.deepEqual(draws,['a']);
 }finally{release();cache.close();}
});

test('failures are retryable and queues and SVG size are bounded',async()=>{
 let fail=true;
 const cache=new DiagramCache(async text=>{
  if(fail){fail=false;throw Error('transient');}
  return svg(text==='huge'?'x'.repeat(16*1024*1024):text);
 });
 try {
  await assert.rejects(cache.render('a','v'),/transient/);assert.deepEqual(await cache.render('a','v'),svg('a'));
  await assert.rejects(cache.render('huge','v'),/結果|결과/);
  await assert.rejects(cache.render('x'.repeat(20_001),'v'),/너무/);
 }finally{cache.close();}
 let release!:()=>void;
 const wait=new Promise<void>(r=>{release=r;});
 const full=new DiagramCache(async text=>{await wait;return svg(text);});
 try {
  const work=Array.from({length:16},(_,n)=>full.render(String(n),'v'));
  await assert.rejects(full.render('overflow','v'),/요청이 많/);release();await Promise.all(work);
 }finally{release();full.close();}
});

test('the last reader aborts active rendering so the next visible diagram can run',async()=>{
 let started!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve;});
 let interrupted=false;
 const cache=new DiagramCache(async(text,signal)=>{
  if(text!=='blocked')return svg(text);
  started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{interrupted=true;reject(signal.reason);},{once:true}));
 });
 try {
  const controller=new AbortController();const blocked=cache.render('blocked','v',controller.signal);
  await entered;controller.abort();await assert.rejects(blocked,{name:'AbortError'});
  assert.deepEqual(await cache.render('next','v'),svg('next'));assert.equal(interrupted,true);
 }finally{cache.close();}
});

test('a cancelled job can immediately be requested again without inheriting its aborted result',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let calls=0;
 const cache=new DiagramCache(async(text,signal)=>{
  if(++calls>1)return svg(text);
  entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 });
 try {
  const controller=new AbortController();const first=cache.render('same','v',controller.signal);
  await started;controller.abort();await assert.rejects(first,{name:'AbortError'});
  assert.deepEqual(await cache.render('same','v'),svg('same'));assert.equal(calls,2);
 }finally{cache.close();}
});

test('queue wait is included in the forty-second generation budget',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000});
 let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(r=>{release=r;});const secondStarted=new Promise<void>(r=>{entered=r;});
 const cache=new DiagramCache(async(text,signal)=>{
  if(text==='first'){await blocked;return svg(text);}
  entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 });
 try {
  const first=cache.render('first','v'),second=cache.render('second','v');
  const rejected=assert.rejects(second,/처리 시간이 초과/);
  await new Promise(r=>setImmediate(r));t.mock.timers.tick(25_000);release();await first;await secondStarted;
  t.mock.timers.tick(15_001);await rejected;
 }finally{release();cache.close();}
});
