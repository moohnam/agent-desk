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
