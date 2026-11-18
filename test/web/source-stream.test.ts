import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceStreams } from '../../web/src/sourceStream.ts';
function fixture() {
  const sockets: any[] = [];
  const open = createSourceStreams(() => { const socket = {onmessage:null,onerror:null,closed:false,close(){this.closed=true;}};sockets.push(socket);return socket; });
  const send = (packet: unknown) => sockets.at(-1).onmessage({data:JSON.stringify(packet)});
  return {open,sockets,send};
}
test('one connection routes separate sources and reconnect statuses without conflating task IDs', async () => {
  const f=fixture(),local=f.open(''),a=f.open('a'),b=f.open('b');const data:string[]=[],states:string[]=[];
  local.onmessage=e=>data.push('local:'+e.data);a.onmessage=e=>data.push('a:'+e.data);b.onmessage=e=>data.push('b:'+e.data);
  a.onopen=()=>states.push('up');a.onerror=()=>states.push('down');
  assert.equal(f.sockets.length,1);
  f.send({source:'a',message:{type:'task',task:{id:'same'}}});
  f.send({source:'a',connected:true});f.send({source:'a',connected:false});f.send({source:'a',connected:true});
  assert.equal(data.length,1);assert.ok(data[0].startsWith('a:'));assert.deepEqual(states,['up','down','up']);
  local.close();a.close();assert.equal(f.sockets[0].closed,false);b.close();assert.equal(f.sockets[0].closed,true);
});
test('late discovery receives known status, removed sources discard messages, old sockets cannot publish', async()=>{
  const f=fixture(),local=f.open('');f.send({source:'late',connected:true});
  const late=f.open('late');let opened=0,messages=0;late.onopen=()=>opened++;late.onmessage=()=>messages++;
  await Promise.resolve();assert.equal(opened,1);late.close();f.send({source:'late',message:{type:'task'}});assert.equal(messages,0);
  local.close();const old=f.sockets[0],fresh=f.open('');fresh.onmessage=()=>messages++;
  old.onmessage({data:JSON.stringify({source:'',message:{type:'task'}})});assert.equal(messages,0);fresh.close();
});
test('whole connection failure marks every subscriber disconnected and clears cached status',async()=>{
  const f=fixture(),a=f.open('a'),b=f.open('b');let errors=0,opens=0;a.onerror=b.onerror=()=>errors++;
  f.send({source:'late',connected:true});f.sockets[0].onerror();assert.equal(errors,2);
  const late=f.open('late');late.onopen=()=>opens++;await Promise.resolve();assert.equal(opens,0);a.close();b.close();late.close();
});
test('a transport the browser closed for good (an HTTP error) is reopened with backoff; a dropped one is left to the browser',async()=>{
  const timers:{fn:()=>void;ms:number;cancelled:boolean}[]=[];
  const sockets:any[]=[];
  const open=createSourceStreams(()=>{const socket={onopen:null,onmessage:null,onerror:null,closed:false,readyState:1,close(){this.closed=true;}};sockets.push(socket);return socket;},
    (fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true;};});
  const fire=()=>{const timer=timers.shift()!;assert.equal(timer.cancelled,false);timer.fn();return timer.ms;};
  const a=open('a');let errors=0,opens=0;a.onerror=()=>errors++;a.onopen=()=>opens++;
  sockets[0].onerror();assert.equal(errors,1);assert.equal(sockets.length,1);assert.equal(timers.length,0);
  sockets[0].readyState=2;sockets[0].onerror();assert.equal(errors,2);assert.equal(sockets[0].closed,true);
  assert.equal(fire(),1000);assert.equal(sockets.length,2);
  sockets[1].readyState=2;sockets[1].onerror();assert.equal(fire(),2000);assert.equal(sockets.length,3);
  sockets[2].onopen();
  sockets[2].readyState=2;sockets[2].onerror();assert.equal(fire(),1000);assert.equal(sockets.length,4);
  sockets[3].onmessage({data:JSON.stringify({source:'a',connected:true})});assert.equal(opens,1);
  // A late subscriber while a retry waits connects at once; closing the last one cancels the retry.
  sockets[3].readyState=2;sockets[3].onerror();const b=open('b');assert.equal(sockets.length,5);assert.equal(timers[0].cancelled,true);timers.shift();
  sockets[4].readyState=2;sockets[4].onerror();a.close();b.close();assert.equal(timers[0].cancelled,true);
  sockets[3].onerror();assert.equal(sockets.length,5);
});
