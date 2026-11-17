import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { multiplexStream } from '../../hub/src/stream-mux.ts';
class Response extends EventEmitter {
 writableLength=0;destroyed=false;frames:string[]=[];
 writeHead(){} write(value:string){this.frames.push(value);return true;}
 destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}}
 packets(){return this.frames.filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(6)));}
}
const wait=async(fn:()=>boolean)=>{const deadline=Date.now()+3500;while(!fn()){if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,20));}};
test('an initially unauthorized connection is closed before subscribing or starting timers',()=>{
 const res=new Response();let subscriptions=0;
 multiplexStream(res as unknown as ServerResponse,{
  allowed:()=>false,sources:()=>[],access:()=>{subscriptions++;return()=>{};},stream:async()=>{}
 });
 assert.equal(res.destroyed,true);assert.equal(subscriptions,0);assert.equal(res.frames.length,0);
});
test('multiplexed source reconnects independently and close cancels all streams and timers',async()=>{
 const res=new Response();let allowed=true;let removed=false;let leaves=0;let localSend:(m:any)=>void=()=>{};
 const attempts:{id:string;signal:AbortSignal;open:()=>void;send:(m:any)=>void;end:()=>void}[]=[];
 multiplexStream(res as unknown as ServerResponse,{
  allowed:()=>allowed,sources:()=>removed?[]:[{id:'a',linkId:'peer-a',view_index:1}],
  local:fn=>{localSend=fn;return()=>leaves++;},access:()=>()=>leaves++,
  stream:(id,signal,open,send)=>new Promise(resolve=>{attempts.push({id,signal,open,send,end:resolve});signal.addEventListener('abort',()=>resolve(),{once:true});open();})
 });
 try{
 localSend({type:'runner',connected:true});attempts[0].send({type:'runner',connected:true});attempts[0].end();await wait(()=>attempts.length===2);
 assert.equal(res.packets().filter(p=>p.source==='a'&&p.connected===true).length,2);
 assert.ok(res.packets().some(p=>p.source==='a'&&p.connected===false));assert.ok(res.packets().some(p=>p.source===''&&p.message));
 removed=true;await wait(()=>attempts[1].signal.aborted);const count=res.packets().length;attempts[1].send({type:'runner',connected:true});attempts[1].open();assert.equal(res.packets().length,count);
 allowed=false;await wait(()=>res.destroyed);assert.equal(leaves,2);
 }finally{res.destroy();}
});
test('a slow consumer closes without retaining unbounded data; late opens cannot publish',async()=>{
 const res=new Response();let send:(m:any)=>void=()=>{};let signal:AbortSignal|undefined;let opened=()=>{};
 multiplexStream(res as unknown as ServerResponse,{allowed:()=>true,sources:()=>[{id:'a',linkId:'a',view_index:1}],access:()=>()=>{},stream:(_id,s,o,fn)=>{signal=s;send=fn;opened=o;return new Promise(r=>s.addEventListener('abort',()=>r(),{once:true}));}});
 res.writableLength=8*1024*1024;send({type:'runner',connected:true});assert.equal(res.destroyed,true);assert.equal(signal?.aborted,true);
 const count=res.frames.length;opened();assert.equal(res.frames.length,count);
});
