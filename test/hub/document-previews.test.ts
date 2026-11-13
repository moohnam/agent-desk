import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { TemporaryFiles } from '../../hub/src/shared-files.ts';
import { DocumentPreviews, documentPath } from '../../hub/src/document-previews.ts';

test('failed and oversized documents do not consume the bounded preview cache',async()=>{
 let reads=0;
 const cache=new DocumentPreviews(async(_source,_task,href,_base,receive)=>{
  reads++;
  if(href.startsWith('missing'))throw Error('missing');
  if(href.startsWith('large'))return receive(new Response('x',{headers:{'content-length':String(6*1024*1024),'x-desk-filename':'large.html'}}));
  return receive(new Response('<h1>ok</h1>',{headers:{'content-length':'11','x-desk-filename':'ok.html'}}));
 });
 try {
  for(let n=0;n<105;n++)await assert.rejects(cache.prepare('','task',`missing-${n}.md`,false,()=>true),/missing/);
  for(let n=0;n<45;n++)await assert.rejects(cache.prepare('','task',`large-${n}.html`,false,()=>true),/5 MB/);
  const ready=await cache.prepare('','task','ok.html',false,()=>true);assert.equal(ready.kind,'html');assert.equal(reads,151);
 }finally{await cache.close();}
});

test('refresh replaces old copies once their readers release them and concurrent prepares reuse bytes',async()=>{
 let reads=0;
 const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>{
  reads++;await new Promise(r=>setTimeout(r,0));
  return receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'ok.html'}}));
 });
 try {
  const first=await Promise.all([cache.prepare('','t','ok.html',false,()=>true),cache.prepare('','t','ok.html',false,()=>true)]);
  assert.equal(reads,1);await cache.release(first[1].url.split('/')[2]);let prior=first[0];
  for(let n=0;n<105;n++){
   const next=await cache.prepare('','t','ok.html',true,()=>true);
   await cache.release(prior.url.split('/')[2]);prior=next;
  }
  assert.equal(reads,106);
 }finally{await cache.close();}
});

test('document paths accept editor suffixes but reject schemes and ambiguous decoding',()=>{
 assert.equal(documentPath('file:///tmp/a%20b.md#L12'),'/tmp/a b.md');
 assert.equal(documentPath('~/report.html:9:2'),'~/report.html');
 for(const value of ['https://site/report.html','%00a.md','broken%XX.md']) {
  assert.throws(()=>documentPath(value));
 }
});

test('capacity evicts the least recently used closed version and refetches its files',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000});
 const reads:string[]=[];
 const cache=new DocumentPreviews(async(_s,_t,href,_b,receive)=>{
  reads.push(href);return receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}}));
 },{maxFiles:2,maxBytes:4});
 const open=(name:string)=>cache.prepare('','t',name,false,()=>true);
 const close=(doc:{url:string})=>cache.release(doc.url.split('/')[2]);
 try {
  await close(await open('a.md'));t.mock.timers.tick(1);
  await close(await open('b.md'));t.mock.timers.tick(1);
  await close(await open('a.md'));t.mock.timers.tick(1);
  await close(await open('c.md'));
  assert.deepEqual(reads,['a.md','b.md','c.md']);
  await close(await open('a.md'));assert.equal(reads.length,3,'recent a remains cached');
  await close(await open('b.md'));assert.equal(reads.at(-1),'b.md','evicted version is fetched again');
 }finally{await cache.close();}
});

test('live readers protect a full cache; expired leases allow new documents without dangling paths',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_000});
 let reads=0;
 const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>{
  reads++;return receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}}));
 },{maxFiles:1});
 try {
  const a=await cache.prepare('','t','a.md',false,()=>true),id=a.url.split('/')[2];
  await assert.rejects(cache.prepare('','t','b.md',false,()=>true),/보관 한도/);
  t.mock.timers.tick(60_000);cache.renew(id);t.mock.timers.tick(60_000);
  await assert.rejects(cache.prepare('','t','b.md',false,()=>true),/보관 한도/);
  t.mock.timers.tick(30_001);assert.throws(()=>cache.renew(id),/만료/);
  const b=await cache.prepare('','t','b.md',false,()=>true);await cache.release(b.url.split('/')[2]);
  assert.equal((await cache.prepare('','t','a.md',false,()=>true)).text,'ok');
  assert.equal(reads,5);
 }finally{await cache.close();}
});

test('waiting prepares cannot be evicted while a previous transfer is delayed',async()=>{
 let release!:()=>void,started!:()=>void;
 const entered=new Promise<void>(r=>{started=r;});
 const blocked=new Promise<void>(r=>{release=r;});
 let reads=0;
 const cache=new DocumentPreviews(async(_s,_t,href,_b,receive)=>{
  reads++;if(href==='a.md'){started();await blocked;}
  return receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}}));
 },{maxFiles:1});
 try {
  const a=cache.prepare('','t','a.md',false,()=>true);await entered;
  const b=cache.prepare('','t','b.md',false,()=>true);
  const rejected=assert.rejects(b,/보관 한도/);release();
  const doc=await a;await rejected;
  assert.equal((await cache.prepare('','t','a.md',false,()=>true)).text,'ok');
  assert.equal(reads,2);await cache.release(doc.url.split('/')[2]);
 }finally{release();await cache.close();}
});


test('a failed cache deletion is retried instead of permanently losing its quota',async t=>{
 const original=TemporaryFiles.prototype.discard;let fail=true;
 t.mock.method(TemporaryFiles.prototype,'discard',async function(this:TemporaryFiles,path:string){
  if(fail){fail=false;throw Error('temporary deletion failure');}
  return original.call(this,path);
 });
 const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}})),{maxFiles:1});
 try {
  const a=await cache.prepare('','t','a.md',false,()=>true);await cache.release(a.url.split('/')[2]);
  await assert.rejects(cache.prepare('','t','b.md',false,()=>true),/deletion failure/);
  assert.equal((await cache.prepare('','t','b.md',false,()=>true)).text,'ok');
 }finally{await cache.close();}
});

test('copies reaped during suspension are fetched again without poisoning the receiver',async()=>{
 let path='',reads=0;
 const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>{
  reads++;path=await receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}}));return path;
 },{maxFiles:1});
 try {
  const a=await cache.prepare('','t','a.md',false,()=>true);
  await rm(path.slice(0,path.lastIndexOf('/')),{recursive:true,force:true});
  assert.equal((await cache.prepare('','t','a.md',false,()=>true)).text,'ok');
  assert.equal(reads,2);cache.renew(a.url.split('/')[2]);
 }finally{await cache.close();}
});
