import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalogModelName,modelEngine,modelReference,parseCompose,type EngineName} from '../../shared/compose.ts';
import {catalogModel,catalogProblem,catalogEffort,catalogModelTags,catalogsForTarget,checkModelCatalogs,type CatalogModel,type EngineModelCatalog,type ModelCatalogs,type RunnerModelCatalog} from '../../shared/model-catalog.ts';
import {ModelCatalogCache,agyCatalog,claudeCatalog,codexCatalog,readCodexModels} from '../../hub/src/runner/model-catalog.ts';
import {Store} from '../../hub/src/db.ts';
import {Hub} from '../../hub/src/hub.ts';
import {SkillStore} from '../../hub/src/skills.ts';
import {RunnerClient} from '../../hub/src/runner/client.ts';
import {workspaceApi} from '../../hub/src/workspace-api.ts';
import {checkRunnerToHub,type HubToRunner,type RunnerToHub} from '../../shared/protocol.ts';

const at='2026-11-17T00:00:00.000Z';
const catalog=(engine:EngineName,models:CatalogModel[]):EngineModelCatalog=>({engine,models,updatedAt:at,checkedAt:at});
const fable=(version='5-1'):CatalogModel=>({id:`claude-fable-${version}[1m]`,resolvedId:`claude-fable-${version}`,label:'Fable',efforts:['low','medium','high','xhigh','max']});

test('normalizers preserve native Fable context suffix and all AGY providers/effort variants',()=>{
  assert.deepEqual(claudeCatalog([{value:'claude-fable-5-1[1m]',resolvedModel:'claude-fable-5-1',displayName:'Fable',supportedEffortLevels:['high','max']}]),
    [{...fable(),efforts:['high','max']}]);
  const agy=agyCatalog('Fetching available models...\ngemini-4-hydrogen-xhigh\tHydrogen (XHigh)\ngemini-3.8-flash-medium\tFlash (Medium)\nclaude-opus-5-5-high\tClaude Opus\ngpt-oss-120b-medium\tGPT-OSS\ngemini-pro-orchestrator-g1-pro\tOrchestrator\n');
  assert.deepEqual(agy.map(m=>m.id),['gemini-4-hydrogen-xhigh','gemini-3.8-flash-medium','claude-opus-5-5-high','gpt-oss-120b-medium','gemini-pro-orchestrator-g1-pro']);
  assert.deepEqual(agy[0].efforts,['xhigh']);
  assert.equal(agy.at(-1)?.efforts,null,'missing effort metadata is unknown, not a guessed level');
  assert.equal(agyCatalog('gemini-3.8-flash-medium\n')[0].id,'gemini-3.8-flash-medium','old single-column CLI remains supported');
  assert.equal(modelEngine(catalogModelName('agy','claude-opus-5-5-high')),'agy','provider name cannot change the engine');
  assert.equal(modelReference('model:claude:claude-fable-5-1[1m]')?.id,'claude-fable-5-1[1m]');
  assert.equal(modelReference('model:claude:x;touch'),null);
});

test('TTL coalesces reads, failure keeps last success, retries back off, and snapshots are isolated',async()=>{
  let now=Date.parse(at),reads=0,fail=false;
  const reader=async()=>{reads++;if(fail)throw new Error('offline');return [fable()];};
  const cache=new ModelCatalogCache({claude:reader,codex:reader,agy:reader},()=>now,1000);
  const [first,concurrent]=await Promise.all([cache.read('claude'),cache.read('claude',true)]);
  assert.equal(reads,1);assert.deepEqual(first,concurrent);
  first.models.length=0;
  assert.equal(cache.snapshot().claude?.models.length,1);
  await cache.read('claude');assert.equal(reads,1);
  now+=1001;fail=true;
  const stale=await cache.read('claude');assert.equal(reads,2);
  assert.equal(stale.updatedAt,at);assert.equal(stale.models[0].id,fable().id);assert.match(stale.error!,/offline/);
  await cache.read('claude');assert.equal(reads,2,'failed refresh does not spin');
  now+=30_001;fail=false;
  const recovered=await cache.read('claude');assert.equal(reads,3);assert.equal(recovered.error,undefined);assert.notEqual(recovered.updatedAt,at);
  const failedFirst=new ModelCatalogCache({claude:async()=>[],codex:reader,agy:reader});
  const missing=await failedFirst.read('claude');assert.equal(missing.updatedAt,null);assert.deepEqual(missing.models,[]);
});

test('Codex reads every page and rejects repeated cursors instead of publishing partial results',async()=>{
  const calls:unknown[]=[];
  const rows=await readCodexModels(async(method,params)=>{
    calls.push([method,params]);
    return params.cursor ? {data:[{id:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}]}],nextCursor:null}
      : {data:[{id:'gpt-6-sol'}],nextCursor:'next'};
  });
  assert.equal(rows.length,2);assert.deepEqual(rows[1].efforts,['high','ultra']);
  assert.equal((calls[0] as any)[1].includeHidden,false);
  let issued=false;
  await assert.rejects(readCodexModels(async()=>{issued=true;return {};},Date.now()-1),/시간 초과/);
  assert.equal(issued,false,'an expired page deadline never starts another RPC');
  await readCodexModels(async(_method,_params,timeoutMs)=>{assert.ok(timeoutMs!>0&&timeoutMs!<=29_000);return {data:[{id:'gpt-6-sol'}]};});
  await assert.rejects(readCodexModels(async()=>({data:[{id:'gpt-6-sol'}],nextCursor:'same'})),/반복/);
});

test('legacy families pick numeric latest without Flash to Hydrogen remapping; exact IDs enforce effort',()=>{
  const codex=catalog('codex',codexCatalog([{id:'gpt-6.2-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'gpt-6.10-sol',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]));
  assert.equal(catalogModel(codex,'sol')?.id,'gpt-6.10-sol');
  assert.equal(catalogEffort(codex,'sol','max'),'high','old family tags keep nearest-supported effort');
  const agy=catalog('agy',agyCatalog('gemini-4-hydrogen-xhigh\tHydrogen\ngemini-4-hydrogen-high\tHydrogen high\ngemini-3.8-flash-medium\tFlash\ngemini-4-argon-high\tArgon\n'));
  assert.equal(catalogModel(agy,'flash')?.id,'gemini-3.8-flash-medium');
  const onlyHydrogen={...agy,models:agy.models.filter(m=>m.id.includes('hydrogen'))};
  assert.match(catalogProblem('agy','flash',undefined,onlyHydrogen)!,/#flash/);
  const hydrogen=catalogModelName('agy','gemini-4-hydrogen-xhigh');
  assert.equal(catalogProblem('agy',hydrogen,'xhigh',agy),null);
  assert.match(catalogProblem('agy',hydrogen,'high',agy)!,/지원하지/);
  assert.equal(catalogProblem('agy','argon','max',agy),null);
  assert.equal(catalogModel(agy,'argon','max')?.id,'gemini-4-argon-high');
  assert.match(catalogProblem('claude',hydrogen,undefined,catalog('claude',[fable()]))!,/Claude 모델이 아닙니다/);
});

test('dynamic tags avoid controls, skills and cross-engine conflicts, while same-engine runner versions remain usable',()=>{
  const local:RunnerModelCatalog={runnerId:'local-a',label:'local',connected:true,catalogs:{claude:catalog('claude',[fable('5-1'),{id:'auto',label:'auto',efforts:null}])}};
  const remote:RunnerModelCatalog={runnerId:'remote-a',label:'user@remote',connected:true,catalogs:{claude:catalog('claude',[fable('5-2')])}};
  const both=[local,remote];
  const combined=catalogModelTags(both.map(r=>r.catalogs));assert.ok(combined.fable);assert.equal(combined.auto,undefined);
  assert.equal(catalogModelTags(both.map(r=>r.catalogs),['fable']).fable,undefined);
  assert.equal(parseCompose('#fable 작업',[],true,combined).engine,undefined);
  assert.equal(modelEngine(parseCompose('#fable 작업',[],true,combined).model!),'claude');
  const localTags=catalogModelTags(catalogsForTarget(both,{rootPath:'/project'}));
  const remoteTags=catalogModelTags(catalogsForTarget(both,{rootPath:'user@remote:/project'}));
  assert.equal(modelReference(localTags.fable)?.id,fable('5-1').id);
  assert.equal(modelReference(remoteTags.fable)?.id,fable('5-2').id);
  assert.equal(catalogModelTags([{claude:catalog('claude',[fable()]),agy:catalog('agy',[{id:'fable',label:'other',efforts:null}])}]).fable,undefined);
  assert.deepEqual(parseCompose('#fable 작업',['fable'],true,combined).skills,['fable']);
});

test('wire validation rejects malformed catalog metadata while old runner hello remains valid',()=>{
  assert.ok(checkModelCatalogs({claude:catalog('claude',[fable()])}));
  assert.equal(checkModelCatalogs({claude:{...catalog('claude',[fable()]),models:[fable(),fable()]}}),false);
  assert.equal(checkModelCatalogs({claude:catalog('claude',[{...fable(),efforts:['nonsense' as any]}])}),false);
  assert.equal(typeof checkRunnerToHub({type:'hello',runnerId:'r',host:'r',sessions:[],capabilities:{engines:['claude']}}),'object');
  assert.equal(typeof checkRunnerToHub({type:'hello',runnerId:'r',host:'r',sessions:[],capabilities:{engines:['claude'],modelCatalogs:{claude:null}}}),'string');
});

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'desk-model-catalog-'));
  const store=new Store(':memory:');
  const sent:HubToRunner[]=[];
  let say!:(m:RunnerToHub)=>void;
  const live=new Set<string>();
  const hub=new Hub(store,{skills:new SkillStore(join(dir,'skills')),runner:onMessage=>{
    say=onMessage;
    return {connected:true,id:'local-test',engines:new Set(['claude','codex','agy']),has:id=>live.has(id),handle:cmd=>{sent.push(cmd);if(cmd.type==='start')live.add(cmd.sessionId);}};
  }});
  const hello=(catalogs?:ModelCatalogs)=>say({type:'hello',runnerId:'local-test',host:'local',capabilities:{engines:['claude','codex','agy'],close:true,...(catalogs?{modelCatalogs:catalogs}:{})},sessions:[...live].map(sessionId=>({sessionId,busy:true,approvals:[]}))});
  hello();
  return {hub,store,dir,sent,say,hello,close:()=>{hub.dispose();store.database.close();rmSync(dir,{recursive:true,force:true});}};
}

test('repeating an AGY permission tag sends the command again without claiming native success',()=>{
  const f=fixture();
  try {
    const task=f.hub.compose(`@agy:${f.dir} #agy #auto 첫 작업`);
    f.hub.sendMessage(task.id,'#auto');
    f.hub.sendMessage(task.id,'#auto');
    assert.deepEqual(f.sent.filter(m=>m.type==='set_mode').map(m=>m.permissionMode),['auto','auto']);
    const phases=f.store.eventsAfter(task.id,0,100).filter(e=>e.kind==='status' && (e.payload as any).state==='mode')
      .map(e=>(e.payload as any).detail.phase);
    assert.deepEqual(phases,['requested','requested']);
  } finally {f.close();}
});

test('actual model settings and #fable run on the checked runner; refresh never changes an existing selection',()=>{
  const f=fixture();
  try {
    const local={claude:catalog('claude',[fable()])};f.hello(local);
    const choice=catalogModelName('claude',fable().id);
    assert.equal(f.hub.setSettings({claude:{model:choice,effort:'high'}}).claude.model,choice);
    const first=f.hub.compose(`@fable:${f.dir} #fable 첫 작업`);
    const start=f.sent.find(m=>m.type==='start')!;
    assert.equal(start.type,'start');if(start.type!=='start')throw Error('start');
    assert.deepEqual([start.model,start.engine,start.prompt],[choice,'claude','첫 작업']);
    f.hello({claude:catalog('claude',[fable('5-2')])});
    assert.equal(f.hub.taskView(f.store.getTask(first.id)!).model,choice);
    assert.equal(f.sent.filter(m=>m.type==='set_model').length,0);
    f.hub.setSettings({claude:{model:null,effort:null}});
    f.hello(local);
    f.hub.sendMessage(first.id,'#fable #now 명시 재시도');
    assert.equal(f.sent.filter(m=>m.type==='set_model').length,1,'repeating the same explicit model retries a runner-side change failure');
    assert.throws(()=>f.hub.setSettings({claude:{model:catalogModelName('claude','invented')}}),/목록에/);
    assert.throws(()=>f.hub.setSettings({claude:{model:catalogModelName('agy','claude-opus-5-5-high')}}),/Claude 모델이 아닙니다/);
    assert.ok(Array.isArray(workspaceApi(f.hub,'GET',new URL('http://workspace/models')).body));
  } finally {f.close();}
});

test('remote catalog versions route independently and old runners still accept only legacy models',()=>{
  const f=fixture();
  try {
    assert.equal(f.hub.setSettings({claude:{model:'opus'}}).claude.model,'opus');
    assert.throws(()=>f.hub.setSettings({claude:{model:catalogModelName('claude',fable().id)}}),/아직 확인/);
    f.hello({claude:catalog('claude',[fable('5-1')])});
    const peer=f.hub.remotes.register('remote').runner;
    f.hub.remotes.exchange(peer.id,{version:1,journalId:'fixture',commandAck:0,events:[],more:false,sessions:[],engines:['claude'],modelCatalogs:{claude:catalog('claude',[fable('5-2')])}});
    f.hub.setSettings({claude:{model:null,effort:null}});
    const local=f.hub.compose(`@local:${f.dir} #fable local`);
    const remote=f.hub.compose('@remote:remote:/project #fable remote');
    assert.equal(f.hub.taskView(f.store.getTask(local.id)!).model,catalogModelName('claude',fable('5-1').id));
    assert.equal(f.hub.taskView(f.store.getTask(remote.id)!).model,catalogModelName('claude',fable('5-2').id));
    assert.throws(()=>f.hub.createTask(remote.project_id,'','#opus new'),/목록에/);
  } finally {f.close();}
});

test('Claude aliases normalize to canonical exact selections and never drift after a catalog refresh',()=>{
  const before=catalog('claude',claudeCatalog([{value:'fable',resolvedModel:'claude-fable-5-1',displayName:'Fable',supportedEffortLevels:['high']} ]));
  assert.equal(before.models[0].id,'claude-fable-5-1');
  assert.deepEqual(before.models[0].aliases,['fable']);
  const chosen=catalogModelTags([{claude:before}]).fable;
  assert.equal(chosen,'model:claude:claude-fable-5-1');
  assert.equal(catalogProblem('claude',chosen,'high',before),null);
  const after=catalog('claude',claudeCatalog([{value:'fable',resolvedModel:'claude-fable-5-2',displayName:'Fable',supportedEffortLevels:['high']} ]));
  assert.match(catalogProblem('claude',chosen,'high',after)!,/목록에/);
  const opus=claudeCatalog([{value:'default',resolvedModel:'claude-opus-5-5',displayName:'Default'}, {value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus'}]);
  assert.equal(opus.length,1);assert.equal(opus[0].isDefault,true);
  assert.equal(catalogModel(catalog('claude',opus),'opus')?.id,'claude-opus-5-5');
});

test('cache boundary times out hung adapter readers and allows recovery instead of keeping an immortal flight',async()=>{
  const reader=async()=>[fable()];
  const cache=new ModelCatalogCache({claude:reader,codex:reader,agy:reader},Date.now,1000,15);
  await cache.read('claude');
  const stale=await cache.read('claude',true,()=>new Promise(()=>{}));
  assert.match(stale.error!,/시간 초과/);assert.equal(stale.models[0].id,fable().id);
  const recovered=await cache.read('claude',true,async()=>[fable('5-2')]);
  assert.equal(recovered.error,undefined);assert.equal(recovered.models[0].id,fable('5-2').id);
});

test('AGY discovered variant tags pin a CLI version and reject unsupported effort without touching Flash',()=>{
  const agy=catalog('agy',agyCatalog('gemini-4-hydrogen-medium\tHydrogen M\ngemini-4-hydrogen-high\tHydrogen H\ngemini-4-hydrogen-xhigh\tHydrogen XH\ngemini-3.8-flash-medium\tFlash\n'));
  const tags=catalogModelTags([{agy}]);
  assert.equal(tags.hydrogen,'variants:agy:gemini-4-hydrogen');
  assert.equal(tags.flash,undefined,'the existing Flash alias keeps its own meaning');
  assert.equal(catalogModel(agy,tags.hydrogen)?.id,'gemini-4-hydrogen-medium');
  assert.equal(catalogModel(agy,tags.hydrogen,'xhigh')?.id,'gemini-4-hydrogen-xhigh');
  assert.match(catalogProblem('agy',tags.hydrogen,'max',agy)!,/지원하지/);
  const refreshed={...agy,models:[...agy.models,...agyCatalog('gemini-5-hydrogen-medium\tHydrogen5 M\ngemini-5-hydrogen-xhigh\tHydrogen5 XH\n')]};
  assert.equal(catalogModel(refreshed,tags.hydrogen,'xhigh')?.id,'gemini-4-hydrogen-xhigh','effort-only changes keep the selected version');
  assert.equal(catalogModelTags([{agy:refreshed}]).hydrogen,'variants:agy:gemini-5-hydrogen','a fresh explicit tag selects the newest discovered group');
});

test('settings accept a model from the workspace union but each runner revalidates it; a legacy exchange clears stale catalogs',()=>{
  const f=fixture();
  try {
    f.hello({claude:catalog('claude',[fable('5-1')])});
    const peer=f.hub.remotes.register('remote').runner;
    const input={version:1 as const,journalId:'fixture',commandAck:0,events:[],more:false,sessions:[],engines:['claude']};
    f.hub.remotes.exchange(peer.id,{...input,modelCatalogs:{claude:catalog('claude',[fable('5-2')])}});
    const remoteOnly=catalogModelName('claude',fable('5-2').id);
    assert.equal(f.hub.setSettings({claude:{model:remoteOnly}}).claude.model,remoteOnly);
    assert.throws(()=>f.hub.compose(`@local:${f.dir} 작업`),/목록에/);
    const remote=f.hub.compose('@remote:remote:/project 작업');assert.equal(remote.model,remoteOnly);
    const oldReply=f.hub.remotes.exchange(peer.id,input);
    assert.deepEqual(oldReply.commands,[],'a queued exact-model start cannot reach an old runner');
    assert.equal(f.hub.remotes.list().find(r=>r.id===peer.id)?.pending,0,'an incompatible start leaves the queue');
    assert.ok(f.store.listEvents(remote.id).some(event=>event.kind==='status' && (event.payload as {detail?:{reason?:string}}).detail?.reason==='remote_feature_unsupported'));
    assert.deepEqual(f.hub.remotes.catalogsFor(peer.id),{});
    assert.equal(f.hub.remotes.catalogsSupported(peer.id),false);
    assert.throws(()=>f.hub.createTask(remote.project_id,'','작업'),/아직 확인/);
    const restored=f.hub.remotes.exchange(peer.id,{...input,modelCatalogs:{claude:catalog('claude',[fable('5-2')])}});
    assert.deepEqual(restored.commands,[],'an upgrade does not replay the rejected request');
    f.hub.sendMessage(remote.id,'사용자가 다시 요청');
    const retry=f.hub.remotes.exchange(peer.id,{...input,modelCatalogs:{claude:catalog('claude',[fable('5-2')])}});
    assert.equal(retry.commands[0]?.value.type,'start');
  } finally {f.close();}
});


test('a local legacy runner rejects exact and variant references before any wire write, including resume',()=>{
  const writes:string[]=[];
  const port={connected:true,socket:{write:(line:string)=>writes.push(line)},supportsModelCatalogs:false,live:new Set<string>()} as unknown as RunnerClient;
  const start={type:'start' as const,sessionId:'resume',engine:'claude' as const,cwd:'/private/tmp',prompt:'retry',permissionMode:'default' as const,resume:'existing'};
  assert.throws(()=>RunnerClient.prototype.handle.call(port,{...start,model:catalogModelName('claude','claude-fable-5-1')}),/실제 모델 ID/);
  assert.throws(()=>RunnerClient.prototype.handle.call(port,{type:'set_model',sessionId:'resume',model:'variants:agy:gemini-4-hydrogen'}),/실제 모델 ID/);
  assert.deepEqual(writes,[]);
  RunnerClient.prototype.handle.call(port,{...start,model:'opus'});assert.equal(writes.length,1,'legacy aliases keep their wire contract');
});
