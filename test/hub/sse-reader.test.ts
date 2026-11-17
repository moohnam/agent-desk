import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSse } from '../../hub/src/sse-reader.ts';
test('SSE parser preserves split UTF-8, CRLF and multiple data lines, ignores comments and incomplete final events',async()=>{
 const bytes=new TextEncoder().encode(': ping\r\ndata: {"한글":\r\ndata: "본문"}\r\n\r\ndata: unfinished');let i=0;const found:string[]=[];
 const body=new ReadableStream<Uint8Array>({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,i+=1));}});
 await readSse(body,data=>found.push(data));assert.deepEqual(found,['{"한글":\n"본문"}']);
});
test('SSE parser bounds the number of tiny data fields independently of character count',async()=>{
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: \n'.repeat(1025)));}});
 await assert.rejects(readSse(body,()=>{}),/too large/);
 assert.equal(body.locked,false);
});
test('SSE parser rejects oversized buffered fields and releases its reader',async()=>{
 for(const text of ['data: '+'x'.repeat(30),': '+'x'.repeat(30)+'\n',('data: \n').repeat(25)]){
 let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));},cancel(){cancelled=true;}});
 await assert.rejects(readSse(body,()=>{},20),/too large/);assert.equal(cancelled,true);assert.equal(body.locked,false);
 }
});
