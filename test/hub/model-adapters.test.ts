import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

const moduleUrl=(path:string)=>pathToFileURL(resolve(import.meta.dirname,'../../',path)).href;

test('AGY adapter pins a running model across metadata refresh and serializes variant effort changes before send',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-models-'));
  try {
    const cli=join(dir,'fake-agy'),capture=join(dir,'capture.jsonl');
    writeFileSync(cli,`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
if(process.argv[2]==='models'){console.log('gemini-4-hydrogen-medium\\tHydrogen M\\ngemini-4-hydrogen-xhigh\\tHydrogen XH');process.exit(0);}
appendFileSync(process.env.MODEL_CAPTURE,JSON.stringify({args:process.argv.slice(2)})+'\\n');
for await(const line of createInterface({input:process.stdin})){
  appendFileSync(process.env.MODEL_CAPTURE,line+'\\n');
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS'}}));
}
`,{mode:0o755});
    const driver=`
import {startAgy} from ${JSON.stringify(moduleUrl('hub/src/runner/agy.ts'))};
import {runnerModelCatalogs,agyCatalog} from ${JSON.stringify(moduleUrl('hub/src/runner/model-catalog.ts'))};
let engine;
await new Promise((done,fail)=>{
  let turns=0;
  const timer=setTimeout(()=>{engine.close();fail(Error('timeout'));},4000);
  engine=startAgy({sessionId:'fixture',cwd:${JSON.stringify(dir)},prompt:'first',permissionMode:'default',model:'variants:agy:gemini-4-hydrogen',emit(message){
    if(message.type==='event'&&message.event.kind==='status'){
      if(message.event.state==='error'){clearTimeout(timer);engine.close();fail(Error(JSON.stringify(message.event)));}
      if(message.event.state==='turn_done'){
        const count=++turns;
        void(async()=>{
          if(count===1){
            await runnerModelCatalogs.read('agy',true,async()=>agyCatalog('gemini-4-hydrogen-medium\\tH4 M\\ngemini-4-hydrogen-xhigh\\tH4 XH\\ngemini-5-hydrogen-medium\\tH5 M\\ngemini-5-hydrogen-xhigh\\tH5 XH'));
            engine.send('second after refresh');
          }else if(count===2){
            const changing=engine.setModel(undefined,'xhigh');
            engine.send('third after effort change');
            await changing;
          }else{clearTimeout(timer);engine.close();done();}
        })().catch(error=>{clearTimeout(timer);engine.close();fail(error);});
      }
    }
  }});
});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{cwd:dir,env:{...process.env,AGY_BIN:cli,MODEL_CAPTURE:capture},encoding:'utf8',timeout:6000});
    assert.equal(result.status,0,result.stderr||String(result.error));
    const starts=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.args).map(row=>row.args[row.args.indexOf('--model')+1]);
    assert.deepEqual(starts,['gemini-4-hydrogen-medium','gemini-4-hydrogen-xhigh']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Codex adapter keeps a family version across refreshed catalog and effort-only changes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-codex-models-'));
  try {
    const cli=join(dir,'fake-codex'),capture=join(dir,'capture.jsonl');
    writeFileSync(cli,`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const write=message=>console.log(JSON.stringify(message));
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);appendFileSync(process.env.MODEL_CAPTURE,line+'\\n');if(request.id==null)continue;
  const result=request.method==='model/list'?{data:[{id:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}],nextCursor:null}
    :request.method.startsWith('thread/')?{thread:{id:'fixture'},model:'gpt-6-sol'}:request.method==='turn/start'?{turn:{id:'turn'}}:{};
  write({id:request.id,result});
  if(request.method==='turn/start')setTimeout(()=>write({method:'turn/completed',params:{threadId:'fixture',turn:{id:'turn',status:'completed'}}}),5);
}
`,{mode:0o755});
    const driver=`
import {startCodex} from ${JSON.stringify(moduleUrl('hub/src/runner/codex.ts'))};
import {runnerModelCatalogs,codexCatalog} from ${JSON.stringify(moduleUrl('hub/src/runner/model-catalog.ts'))};
let engine;
await new Promise((done,fail)=>{
  let turns=0;const timer=setTimeout(()=>{engine.close();fail(Error('timeout'));},4000);
  engine=startCodex({sessionId:'fixture',cwd:${JSON.stringify(dir)},prompt:'first',permissionMode:'default',model:'sol',effort:'high',emit(message){
    if(message.type==='closed'&&message.error){clearTimeout(timer);fail(Error(message.error));}
    if(message.type==='event'&&message.event.kind==='status'&&message.event.state==='turn_done'){
      void(async()=>{
        if(++turns===1){
          await runnerModelCatalogs.read('codex',true,async()=>codexCatalog(['gpt-6-sol','gpt-6.1-sol'].map(id=>({id,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}))));
          engine.send('second');
        }else if(turns===2){const changing=engine.setModel(undefined,'xhigh');engine.send('third');await changing;}
        else{clearTimeout(timer);engine.close();done();}
      })().catch(error=>{clearTimeout(timer);engine.close();fail(error);});
    }
  }});
});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{cwd:dir,env:{...process.env,CODEX_BIN:cli,MODEL_CAPTURE:capture},encoding:'utf8',timeout:6000});
    assert.equal(result.status,0,result.stderr||String(result.error));
    const turns=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.method==='turn/start');
    assert.deepEqual(turns.map(row=>[row.params.model,row.params.effort]),[['gpt-6-sol','high'],['gpt-6-sol','high'],['gpt-6-sol','xhigh']]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Claude validates before delivering the first prompt and queued follow-up, and passes the canonical model ID',()=>{
  const driver=`
import assert from 'node:assert/strict';
import {mock} from 'node:test';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const captured=[];let resolveModels,options;
mock.module('@anthropic-ai/claude-agent-sdk',{namedExports:{query(input){
  if(input.options.model) options=input.options;
  let finishEvents;
  void(async()=>{for await(const message of input.prompt)captured.push(message.message.content);})();
  return {
    supportedModels:()=>new Promise(resolve=>{resolveModels=resolve;}),
    applyFlagSettings:async()=>{},setModel:async()=>{},setPermissionMode:async()=>{},interrupt:async()=>{},
    close(){finishEvents?.({done:true});},
    [Symbol.asyncIterator](){return {next:()=>new Promise(resolve=>{finishEvents=resolve;})};},
  };
}}});
const {startClaude}=await import(${JSON.stringify(moduleUrl('hub/src/runner/claude.ts'))});
const engine=startClaude({sessionId:'fixture',cwd:'/private/tmp',prompt:'first',permissionMode:'default',model:'model:claude:claude-fable-5-1',emit(){}});
engine.send('follow-up');await tick();assert.deepEqual(captured,[]);
resolveModels([{value:'fable',resolvedModel:'claude-fable-5-1',displayName:'Fable',supportedEffortLevels:['high']}]);
await tick();await tick();assert.deepEqual(captured,['first','follow-up']);assert.equal(options.model,'claude-fable-5-1');
engine.close();`;
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',driver],{cwd:resolve(import.meta.dirname,'../..'),env:{...process.env},encoding:'utf8',timeout:6000});
  assert.equal(result.status,0,result.stderr||String(result.error));
});


for (const action of ['interrupt','close']) test(`AGY same-tick start then ${action} cancels the deferred initial prompt before any CLI execution`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-agy-cancel-'));
  try {
    const cli=join(dir,'fake-agy'),capture=join(dir,'capture');
    writeFileSync(cli,`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';appendFileSync(process.env.MODEL_CAPTURE,'unexpected CLI call\\n');
`,{mode:0o755});
    const driver=`
import assert from 'node:assert/strict';
import {startAgy} from ${JSON.stringify(moduleUrl('hub/src/runner/agy.ts'))};
const messages=[];
const engine=startAgy({sessionId:'fixture',cwd:${JSON.stringify(dir)},prompt:'must be cancelled',permissionMode:'default',emit:message=>messages.push(message)});
${action==='interrupt' ? 'await engine.interrupt();' : 'engine.close();'}
await new Promise(resolve=>setImmediate(resolve));
${action==='interrupt' ? "assert.ok(messages.some(m=>m.type==='event'&&m.event.kind==='status'&&m.event.state==='interrupted'));assert.ok(messages.some(m=>m.type==='busy'&&!m.busy));engine.close();" : ''}
`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',driver],{cwd:dir,env:{...process.env,AGY_BIN:cli,MODEL_CAPTURE:capture},encoding:'utf8',timeout:4000});
    assert.equal(result.status,0,result.stderr||String(result.error));assert.equal(existsSync(capture),false,'cancelled initial input must not query models or start a CLI turn');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
