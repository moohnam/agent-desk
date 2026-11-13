import assert from 'node:assert/strict';
import { test } from 'node:test';
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
