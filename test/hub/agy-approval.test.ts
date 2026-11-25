import { AgyChildren } from '../../hub/src/runner/agy-children.ts';
import type { BackgroundTask } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const duringTurn of [false,true]) test(`agy native approvals remain one-shot and a failed strict mode blocks execution (active=${duringTurn})`, () => {
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-approval-'));
  try {
    const cli=join(dir,'agy');
    writeFileSync(cli,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium');process.exit(0);}
const send=msg=>console.log(JSON.stringify({jsonrpc:'2.0',...msg}));
const ask=(id,sessionId,options)=>send({id,method:'session/request_permission',params:{
  sessionId,toolCall:{toolCallId:id,name:'run_command',rawInput:{CommandLine:id}},options}});
const selections={};
let prompt;
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);
  if(!r.method){
    selections[r.id]=r.result.outcome.optionId??r.result.outcome.outcome;
    if(Object.keys(selections).length===4){
      assert.deepEqual(selections,{first:'temporary',second:'no',foreign:'no',persistent:'cancelled'});
      send({id:prompt,result:{stopReason:'end_turn'}});
    }
    continue;
  }
  if(r.method==='session/set_mode' && r.params.modeId==='default'){
    send({id:r.id,error:{code:-32602,message:'mode rejected'}});
    continue;
  }
  if(r.method==='session/prompt'){
    assert.equal(prompt,undefined,'a failed strict mode switch must block the next prompt');
    prompt=r.id;
    const options=[{kind:'allow_always',optionId:'forever'},{kind:'allow_once',optionId:'temporary'},{kind:'reject_once',optionId:'no'}];
    ask('first','native',options);ask('second','native',options);ask('foreign','other',options);
    ask('persistent','native',[options[0]]);
    continue;
  }
  send({id:r.id,result:r.method==='initialize'?{protocolVersion:1}:r.method==='session/new'?{sessionId:'native'}:{}});
}
`,{mode:0o755});
    const adapter=new URL('../../hub/src/runner/agy.ts',import.meta.url).href;
    const driver=`
import assert from 'node:assert/strict';
import {startAgy} from ${JSON.stringify(adapter)};
const pending=new Map();
const duringTurn=${duringTurn};
await new Promise((done,fail)=>{
  const engine=startAgy({sessionId:'desk',cwd:process.cwd(),prompt:'test',permissionMode:'auto',emit(m){
    if(m.type==='approval_request'){
      pending.set(m.input.command,m.approvalId);
      if(pending.size===2){
        if(duringTurn) {
          engine.setMode('default').catch(()=>{});
          return;
        }
        engine.resolveApproval(pending.get('second'),false);
        engine.resolveApproval(pending.get('first'),true);
        engine.resolveApproval(pending.get('first'),true);
      }
    }
    if(m.type==='event' && m.event.kind==='status'){
      if(duringTurn && m.event.state==='interrupted'){engine.close();done();return;}
      if(m.event.state==='turn_done'){
        engine.setMode('default').catch(()=>{});
        engine.send('must wait for strict mode');
      } else if(m.event.state==='error'){
        engine.close();
        if(!duringTurn && /mode rejected|승인 모드/.test(m.event.detail.message))done();
        else fail(Error(m.event.detail.message));
      }
    }
  }});
});
assert.deepEqual([...pending.keys()],['first','second']);`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{
      cwd:dir,env:{...process.env,AGY_BIN:cli},encoding:'utf8',timeout:8000
    });
    assert.equal(result.status,0,result.stderr||String(result.error));
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('a rejected repeat invalidates the last AGY acknowledgement until an explicit retry succeeds',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-mode-'));
  try {
    const cli=join(dir,'agy');
    writeFileSync(cli,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium');process.exit(0);}
let changes=0, prompts=0;
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);
  let result={};
  if(r.method==='initialize') result={protocolVersion:1};
  if(r.method==='session/new') result={sessionId:'native'};
  if(r.method==='session/set_mode')changes++;
  if(r.method==='session/set_mode' && changes===1){
    writeFileSync('initial-mode','');
    while(!existsSync('retry-in-flight'))await wait(5);
  }
  if(r.method==='session/set_mode' && (changes===1 || changes===3)){
    console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32602,message:'rejected'}}));
    continue;
  }
  if(r.method==='session/prompt'){
    if(++prompts===2 && !r.params.prompt[0].text.includes('after retry'))process.exit(1);
    result={stopReason:'end_turn'};
  }
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}
`,{mode:0o755});
    const runner=new URL('../../hub/src/runner/runner.ts',import.meta.url).href;
    const driver=`
import assert from 'node:assert/strict';
import {Runner} from ${JSON.stringify(runner)};
import {existsSync,writeFileSync} from 'node:fs';
const phases=[];
let turns=0, blocked=false;
await new Promise((done,fail)=>{
  const runner=new Runner('test',m=>{
    if(m.type!=='event'||m.event.kind!=='status')return;
    const {state,detail}=m.event;
    if(detail?.phase){phases.push(detail.phase);assert.equal(detail.mode,'auto');}
    if(state==='warning'){assert.match(detail.message,/#auto.*다시/);return;}
    if(state==='error'){
      assert.match(detail.message,/#auto/);blocked=true;
      queueMicrotask(()=>{runner.handle({type:'set_mode',sessionId:'s',permissionMode:'auto'});runner.handle({type:'send',sessionId:'s',text:'after retry'});});
    }
    if(state==='turn_done' && ++turns===1){
      runner.handle({type:'set_mode',sessionId:'s',permissionMode:'auto'});
      runner.handle({type:'send',sessionId:'s',text:'must be blocked'});
    }else if(state==='turn_done'){
      runner.handle({type:'close',sessionId:'s'});done();
    }
  });
  runner.handle({type:'start',sessionId:'s',engine:'agy',cwd:process.cwd(),prompt:'start',permissionMode:'auto'});
  const poll=setInterval(()=>{
    if(!existsSync('initial-mode'))return;
    clearInterval(poll);
    runner.handle({type:'set_mode',sessionId:'s',permissionMode:'auto'});
    writeFileSync('retry-in-flight','');
  },5);
});
assert.equal(blocked,true);assert.deepEqual(phases,['applied','failed','applied']);`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{
      cwd:dir,env:{...process.env,AGY_BIN:cli},encoding:'utf8',timeout:8000
    });
    assert.equal(result.status,0,result.stderr||String(result.error));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a superseded live #ask failure preserves the newer #auto input and skips obsolete queued modes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-mode-race-'));
  try {
    const cli=join(dir,'agy');
    writeFileSync(cli,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
if(process.argv[2]==='models'){console.log('gemini-3.8-flash-medium');process.exit(0);}
const emit=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
const tool=name=>emit({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:name,title:name,status:'completed'}}});
let prompt, modes=[];
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);
  let result={};
  if(r.method==='initialize')result={protocolVersion:1};
  if(r.method==='session/new')result={sessionId:'native'};
  if(r.method==='session/set_mode'){
    modes.push(r.params.modeId);
    if(r.params.modeId==='default'){
      tool('strict-in-flight');
      emit({id:r.id,error:{code:-32602,message:'old strict request rejected'}});
      continue;
    }
    if(prompt)emit({id:prompt,result:{stopReason:'end_turn'}});
  }
  if(r.method==='session/prompt'){
    if(!prompt){prompt=r.id;tool('first-prompt');continue;}
    assert.deepEqual(modes,['auto','default','auto']);
    assert.equal(r.params.prompt[0].text,'latest input');
    result={stopReason:'end_turn'};
  }
  emit({id:r.id,result});
}
`,{mode:0o755});
    const runner=new URL('../../hub/src/runner/runner.ts',import.meta.url).href;
    const driver=`
import assert from 'node:assert/strict';
import {Runner} from ${JSON.stringify(runner)};
let turns=0;
await new Promise((done,fail)=>{
  const runner=new Runner('test',m=>{
    if(m.type!=='event')return;
    const e=m.event;
    const mode=permissionMode=>runner.handle({type:'set_mode',sessionId:'s',permissionMode});
    if(e.kind==='tool' && e.name==='first-prompt')mode('default');
    if(e.kind==='tool' && e.name==='strict-in-flight'){
      mode('auto');mode('default');mode('auto');
      runner.handle({type:'send',sessionId:'s',text:'latest input'});
    }
    if(e.kind==='status'){
      if(['interrupted','warning','error'].includes(e.state)){runner.handle({type:'close',sessionId:'s'});fail(Error(JSON.stringify(e)));}
      if(e.state==='turn_done' && ++turns===2){runner.handle({type:'close',sessionId:'s'});done();}
    }
  });
  runner.handle({type:'start',sessionId:'s',engine:'agy',cwd:process.cwd(),prompt:'first',permissionMode:'auto'});
});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{
      cwd:dir,env:{...process.env,AGY_BIN:cli},encoding:'utf8',timeout:8000
    });
    assert.equal(result.status,0,result.stderr||String(result.error));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('agy keeps a spawned child active until the session records its idle notification',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-child-'));
  const parent='00000000-0000-4000-8000-000000000001', child='00000000-0000-4000-8000-000000000002';
  const records=join(dir,parent,'.system_generated');
  let tasks:BackgroundTask[]=[];
  const monitor=new AgyChildren(value=>{tasks=value;},dir);
  try {
    for(const subdir of ['subagents','messages']) mkdirSync(join(records,subdir),{recursive:true});
    const update={name:'invoke_subagent',sessionUpdate:'tool_call',toolCallId:'spawn',rawInput:{Role:'worker'}};
    monitor.beforePrompt(parent);
    writeFileSync(join(records,'subagents',child+'.json'),JSON.stringify({conversationId:child,subagentDescriptor:{role:'worker'}}));
    monitor.observe(update);
    monitor.observe({...update,sessionUpdate:'tool_call_update',status:'completed'});
    assert.equal(tasks[0].state,'unknown');
    assert.equal(monitor.owns(child),true);
    writeFileSync(join(records,'messages',parent+'.json'),JSON.stringify({sender:'system',content:'Subagent '+child+' has gone idle. Done'}));
    assert.equal(monitor.owns(child),false);
    assert.deepEqual(tasks,[]);
  } finally {monitor.reset();rmSync(dir,{recursive:true,force:true});}
});
