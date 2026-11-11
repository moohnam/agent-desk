import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { RemoteJournal } from '../../hub/src/runner/remote-journal.ts';
import { SharedRuntime } from '../../hub/src/runner/shared-runtime.ts';
import { activateRemoteImport, commitRemoteTransfer, exportRemoteTransfer, importRemoteManifests, importRemoteTransfer, verifyRemoteImport,
  importEmptyRemoteProjects, verifyEmptyRemoteMerge, activateEmptyRemoteMerge, abortEmptyRemoteMerge } from '../../hub/src/runner/remote-migration.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import type { RunnerPort } from '../../hub/src/runner/client.ts';
import type { StartOptions } from '../../hub/src/runner/engine.ts';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LocalRuntime } from '../../hub/src/runner/local-runtime.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { abortRemoteImport, rollbackRemoteTransfer } from '../../hub/src/runner/remote-migration.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { collectSkillVersion, peerSkillManifest, skillDigest, syncSkillVersion } from '../../hub/src/shared-skill-sync.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'desk-remote-migration-'));
  const source=new Store(join(dir,'source.db'));
  const local:RunnerPort={connected:false,id:'local-test',engines:new Set(['codex']),has:()=>false,handle:()=>{}};
  const hub=new Hub(source,{skills:new SkillStore(join(dir,'source-skills')),runner:()=>local,graceMs:60_000});
  const registered=hub.remotes.register('user@worker');
  const runnerId=registered.runner.id;
  const journalPath=join(dir,'old-delivery.db');
  const journal=new RemoteJournal(journalPath);journal.bind('https://old-hub.example/',runnerId);
  const db=source.database;
  db.prepare('UPDATE remote_runner SET journal_id=?,sent_through=4,event_ack=0 WHERE id=?').run(journal.id,runnerId);
  source.createProject({id:'project-remote',name:'remote',root_path:`user@worker:${dir}`,created_at:'2026-01-01T00:00:00Z'});
  source.createProject({id:'project-local',name:'local',root_path:'/tmp/local',created_at:'2026-01-01T00:00:00Z'});
  const base={status:'done' as const,checkpoint_md:null,created_by:'user',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'};
  source.createTask({id:'task-remote',project_id:'project-remote',title:'remote',...base});
  source.createTask({id:'task-local',project_id:'project-local',title:'local',...base});
  source.createSession({id:'session-remote',task_id:'task-remote',engine:'codex',engine_session_id:'engine-native',cwd:`user@worker:${dir}`,source:'app',status:'done',runner_id:runnerId,created_at:base.created_at,permission_mode:'default',model:null,effort:null});
  source.createSession({id:'session-local',task_id:'task-local',engine:'codex',engine_session_id:'engine-local',cwd:'/tmp/local',source:'app',status:'done',runner_id:'local-test',created_at:base.created_at,permission_mode:'default',model:null,effort:null});
  const oldEvent=source.addEvent('session-remote','task-remote','assistant',{text:'earlier'},base.created_at);
  source.addEvent('session-local','task-local','assistant',{text:'local'},base.created_at);
  source.createApproval({id:'approval-remote',session_id:'session-remote',task_id:'task-remote',tool_name:'tool',input:{},status:'allowed',created_at:base.created_at});
  source.createQuestion({id:'question-remote',session_id:'session-remote',task_id:'task-remote',text:'past question',status:'answered',answer:'yes',created_at:base.created_at,answered_at:base.created_at});
  source.enqueue({id:'queued-remote',task_id:'task-remote',session_id:'session-remote',text:'waiting',body:'waiting',skills:[],mode:null,created_at:base.created_at});
  source.createRequest({id:'request-from-remote',from_task_id:'task-remote',from_session_id:'session-remote',to_task_id:'task-local',to_session_id:'session-local',text:'answered',status:'answered',answer:'ok',approval_id:null,queued_id:null,prompt_event_id:null,created_at:base.created_at,answered_at:base.created_at});
  source.createRequest({id:'request-to-remote',from_task_id:'task-local',from_session_id:'session-local',to_task_id:'task-remote',to_session_id:'session-remote',text:'answered',status:'answered',answer:'ok',approval_id:null,queued_id:null,prompt_event_id:oldEvent.id,created_at:base.created_at,answered_at:base.created_at});
  const command={type:'close' as const,sessionId:'session-remote'};
  journal.receive([{seq:4,value:command}]);
  db.prepare('INSERT INTO remote_command(seq,runner_id,session_id,kind,payload) VALUES (4,?,?,?,?)').run(runnerId,'session-remote','close',JSON.stringify(command));
  return {dir,source,hub,journal,journalPath,runnerId,oldEvent};
}

test('remote cutover preserves IDs, history, delivery sequence and cross-source settled requests',async()=>{
  const f=fixture();let target:Store|undefined,runtime:SharedRuntime|undefined,gateway:Store|undefined,links:WorkspaceLinks|undefined,server:Server|undefined;
  try {
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    assert.deepEqual(bundle.legacy.legacy_task_ids,['task-remote']);
    assert.equal(bundle.rows.event[0].id,f.oldEvent.id);
    target=new Store(join(f.dir,'target','workspace.db'));
    importRemoteTransfer(bundle,target,f.journal);
    importRemoteTransfer(bundle,target,f.journal);
    const verified=verifyRemoteImport(bundle,target.database,f.journal);
    assert.equal(target.getSession('session-remote')?.engine_session_id,'engine-native');
    assert.equal(target.database.prepare('SELECT count(*) n FROM request').get()?.n,1);
    assert.throws(()=>new SharedRuntime(join(f.dir,'target'),'user@worker',{skills:new SkillStore(join(f.dir,'target-skills')),
      migration:{runnerId:f.runnerId,journalPath:f.journalPath,skillsHome:join(f.dir,'engine-skills')}}),/아직 활성화/);
    assert.ok(f.source.getTask('task-remote'));
    const receipt=commitRemoteTransfer(f.source.database,bundle,verified);
    assert.deepEqual(commitRemoteTransfer(f.source.database,bundle,verified),receipt);
    assert.equal(f.source.getTask('task-remote'),undefined);
    assert.ok(f.source.getTask('task-local'));
    assert.ok(f.source.getRequest('request-to-remote'));
    assert.equal(f.source.getRequest('request-from-remote'),undefined);
    assert.throws(()=>activateRemoteImport(target!.database,f.runnerId,{...receipt,fingerprint:'wrong'}),/영수증/);
    activateRemoteImport(target.database,f.runnerId,receipt);
    target.database.close();target=undefined;f.journal.close();
    const starts:StartOptions[]=[];
    runtime=new SharedRuntime(join(f.dir,'target'),'user@worker',{skills:new SkillStore(join(f.dir,'target-skills')),
      migration:{runnerId:f.runnerId,journalPath:f.journalPath,skillsHome:join(f.dir,'engine-skills')},
      start:opts=>{starts.push(opts);return {send:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval:()=>{},close:()=>{}};}});
    assert.ok(runtime.journal.commandAck>=4);
    assert.equal(runtime.hub.remotes.list()[0].id,f.runnerId);
    assert.equal(runtime.hub.store.getSession('session-remote')?.engine_session_id,'engine-native');
    assert.equal(runtime.hub.store.listEvents('task-remote')[0].id,f.oldEvent.id);
    runtime.exchange();assert.equal(starts[0]?.resume,'engine-native');
    assert.equal(starts.length,1,'보관된 입력은 한 번만 엔진에 전달한다');
    assert.equal(runtime.hub.store.queued({taskId:'task-remote'}).length,0);
    server=runtime.workspace.server();
    await new Promise<void>((resolve,reject)=>server!.once('error',reject).listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    const token=runtime.workspace.grant('gateway').token;
    gateway=new Store(join(f.dir,'gateway.db'));links=new WorkspaceLinks(gateway);
    const view=await links.installMigrated(join(f.dir,'source.db'),f.runnerId,{url:`http://127.0.0.1:${port}/`,token});
    assert.deepEqual(view.legacy_task_ids,['task-remote']);
    importRemoteManifests(join(f.dir,'source.db'),gateway,true);
    assert.equal(links.legacyOwner('task','task-remote'),f.runnerId);
    assert.equal(links.legacyOwner('approval','approval-remote'),f.runnerId);
    assert.equal(links.legacyOwner('question','question-remote'),f.runnerId);
  }finally{
    if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await links?.close();runtime?.close();target?.database.close();f.hub.dispose();f.source.database.close();
    if(!runtime)f.journal.close();gateway?.database.close();rmSync(f.dir,{recursive:true,force:true});
  }
});

test('tampered or changed transfer, wrong journal and live lease refuse import',()=>{
  const f=fixture();const target=new Store(join(f.dir,'target.db'));
  try{
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    assert.throws(()=>importRemoteTransfer({...bundle,fingerprint:'altered'},target,f.journal),/지문/);
    const incomplete=structuredClone(bundle) as any;delete incomplete.rows.task;
    assert.throws(()=>importRemoteTransfer(incomplete,target,f.journal),/묶음/);
    const injected=structuredClone(bundle) as any;
    injected.rows.project[0]['id) VALUES (1); DROP TABLE task;--']='unsafe';
    injected.fingerprint=createHash('sha256').update(JSON.stringify({runnerId:injected.runner_id,address:injected.address,
      rows:injected.rows,legacy:injected.legacy,skills:injected.skills})).digest('hex');
    assert.throws(()=>importRemoteTransfer(injected,target,f.journal),/알 수 없는 열/);
    assert.equal(target.database.prepare('SELECT count(*) n FROM task').get()?.n,0);
    const wrong=new RemoteJournal(join(f.dir,'wrong-journal.db'));wrong.bind('https://old-hub.example/','remote-wrong');
    try{assert.throws(()=>importRemoteTransfer(bundle,target,wrong),/ID/);}finally{wrong.close();}
    importRemoteTransfer(bundle,target,f.journal);
    const altered=structuredClone(bundle);
    altered.rows.event[0].payload_json='{"text":"different"}';
    altered.fingerprint=createHash('sha256').update(JSON.stringify({runnerId:altered.runner_id,address:altered.address,rows:altered.rows,legacy:altered.legacy,skills:altered.skills})).digest('hex');
    assert.throws(()=>importRemoteTransfer(altered,target,f.journal),/다른 원본/);
    assert.deepEqual(verifyRemoteImport(bundle,target.database,f.journal).fingerprint,bundle.fingerprint);
    f.journal.claim();
    const competing=new RemoteJournal(f.journalPath);
    try{assert.throws(()=>competing.claim(),/이미 실행/);}finally{competing.close();}
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('old journal copy with the same UUID cannot lose acknowledged output; replayable output remains valid',()=>{
  const f=fixture();const target=new Store(join(f.dir,'target.db'));
  try{
    f.journal.emit({type:'event',sessionId:'session-remote',event:{kind:'assistant',text:'delayed delivery'}});
    f.source.database.prepare('UPDATE remote_runner SET event_ack=1 WHERE id=?').run(f.runnerId);
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    const stalePath=join(f.dir,'stale.db');
    let stale=new RemoteJournal(stalePath);stale.bind('https://old-hub.example/',f.runnerId);
    stale.receive([{seq:4,value:{type:'close',sessionId:'session-remote'}}]);stale.close();
    const raw=new DatabaseSync(stalePath);raw.prepare("UPDATE meta SET value=? WHERE key='id'").run(f.journal.id);raw.close();
    stale=new RemoteJournal(stalePath);
    try{
      assert.equal(stale.id,f.journal.id);
      assert.throws(()=>importRemoteTransfer(bundle,target,stale),/출력 이력/);
      assert.equal(target.database.prepare('SELECT count(*) n FROM task').get()?.n,0);
    }finally{stale.close();}
    importRemoteTransfer(bundle,target,f.journal);
    assert.equal(verifyRemoteImport(bundle,target.database,f.journal).fingerprint,bundle.fingerprint);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('source desk skills arrive with the same tag and files; a target collision stops import',()=>{
  const f=fixture();const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  const conflict=new Store(join(f.dir,'conflict','workspace.db'));
  const conflictSkills=new SkillStore(join(f.dir,'conflict','desk-plugin'));
  try{
    sourceSkills.create('guide','source');
    sourceSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: source\n---\nUse this guide.');
    sourceSkills.writeFile('guide','scripts/run.sh','#!/bin/sh\necho ready\n',true);
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    assert.equal(bundle.skills.length,2);
    conflictSkills.create('guide','different');
    const conflictingPeer=new SharedWorkspace(undefined,conflict).grant('source-hub').id;
    assert.throws(()=>importRemoteTransfer(bundle,conflict,f.journal,conflictSkills,conflictingPeer),/원본과 다릅니다/);
    assert.equal(conflict.database.prepare('SELECT count(*) n FROM task').get()?.n,0);
    assert.throws(()=>importRemoteTransfer(bundle,target,f.journal,targetSkills),/peer ID/);
    const peer=new SharedWorkspace(undefined,target).grant('source-hub').id;
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    assert.deepEqual(targetSkills.names(),['guide']);
    assert.equal(targetSkills.readFile('guide','scripts/run.sh').executable,true);
    assert.equal(target.database.prepare('SELECT peer_id FROM shared_skill_owner WHERE name=?').get('guide')?.peer_id,peer);
    assert.ok(peerSkillManifest(target.database,targetSkills,peer).guide);
    const secondPeer=new SharedWorkspace(undefined,target).grant('other-hub').id;
    assert.throws(()=>importRemoteTransfer(bundle,target,f.journal,targetSkills,secondPeer),/peer ID/);
    assert.equal(verifyRemoteImport(bundle,target.database,f.journal,targetSkills).fingerprint,bundle.fingerprint);
    sourceSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: changed\n---\nChanged.');
    const verified={runner_id:f.runnerId,fingerprint:bundle.fingerprint,journal_id:f.journal.id,verified_at:new Date().toISOString()};
    assert.throws(()=>commitRemoteTransfer(f.source.database,bundle,verified,sourceSkills),/원본 기록이 변경/);
    const aborted=abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(aborted.fingerprint,bundle.fingerprint);
    assert.equal(target.database.prepare('SELECT peer_id FROM shared_skill_owner WHERE name=?').get('guide'),undefined);
    assert.equal(peerSkillManifest(target.database,targetSkills,peer).guide,undefined);
    assert.deepEqual(targetSkills.names(),[],'abort removes only the global skill files created by import');
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    assert.equal(verifyRemoteImport(bundle,target.database,f.journal,targetSkills).fingerprint,bundle.fingerprint);
  }finally{f.journal.close();target.database.close();conflict.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('abort keeps preexisting identical skill files and user edits to imported files',()=>{
  const f=fixture();
  const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  try{
    sourceSkills.create('guide');
    const md='---\nname: guide\ndescription: source\n---\nUse this guide.';
    sourceSkills.writeFile('guide','SKILL.md',md);
    sourceSkills.writeFile('guide','scripts/run.sh','#!/bin/sh\necho ready\n',true);
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    const peer=new SharedWorkspace(undefined,target).grant('origin').id;
    targetSkills.create('guide');
    targetSkills.writeFile('guide','SKILL.md',md);
    targetSkills.writeFile('guide','scripts/run.sh','#!/bin/sh\necho ready\n',true);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(targetSkills.readFile('guide','SKILL.md').content,md);
    assert.equal(targetSkills.readFile('guide','scripts/run.sh').content,'#!/bin/sh\necho ready\n');
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    assert.equal(verifyRemoteImport(bundle,target.database,f.journal,targetSkills).fingerprint,bundle.fingerprint);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.deepEqual(targetSkills.names(),['guide']);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('abort preserves preexisting skill ownership and manifest across import retries',()=>{
  const f=fixture();
  const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  try{
    sourceSkills.create('guide');
    const md='---\nname: guide\ndescription: source\n---\nUse this guide.';
    sourceSkills.writeFile('guide','SKILL.md',md);
    targetSkills.create('guide');
    targetSkills.writeFile('guide','SKILL.md',md);
    const peer=new SharedWorkspace(undefined,target).grant('origin').id;
    const files=[{name:'guide',path:'SKILL.md',content:md,executable:false}];
    const digest=skillDigest(files);
    syncSkillVersion(target.database,targetSkills,peer,{version:1,selected:['guide'],files,hashes:{guide:digest},digest});
    target.database.prepare('INSERT INTO shared_skill_owner(name,peer_id,digest) VALUES (?,?,?)').run('guide',peer,digest);
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    verifyRemoteImport(bundle,target.database,f.journal,targetSkills);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(target.database.prepare('SELECT peer_id,digest FROM shared_skill_owner WHERE name=?').get('guide')?.digest,digest);
    assert.equal(peerSkillManifest(target.database,targetSkills,peer).guide,digest);
    assert.equal(targetSkills.readFile('guide','SKILL.md').content,md);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(peerSkillManifest(target.database,targetSkills,peer).guide,digest);
    assert.equal(target.database.prepare('SELECT peer_id FROM shared_skill_owner WHERE name=?').get('guide')?.peer_id,peer);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('import pins a previous skill cache version through eviction, then releases the pin',()=>{
  const f=fixture();
  const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const oldSkills=new SkillStore(join(f.dir,'old-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  try{
    sourceSkills.create('guide');
    sourceSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: new\n---\nNew version.');
    targetSkills.create('guide');
    targetSkills.writeFile('guide','SKILL.md',sourceSkills.readFile('guide','SKILL.md').content);
    oldSkills.create('guide');
    oldSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: old\n---\nOld version.');
    const peer=new SharedWorkspace(undefined,target).grant('origin').id;
    const oldVersion=collectSkillVersion(oldSkills,'guide');
    syncSkillVersion(target.database,targetSkills,peer,oldVersion);
    const insert=target.database.prepare('INSERT INTO shared_skill_cache VALUES (?,?,?,?,?)');
    for(let i=0;i<4095;i++)insert.run(`dummy-${i}`,'dummy','a'.repeat(64),0,Date.now()+100000);
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    assert.equal(target.database.prepare('SELECT digest FROM shared_skill_cache_pin WHERE op_id=?').get(`remote-import:${f.runnerId}`)?.digest,oldVersion.digest);
    assert.equal(target.database.prepare('SELECT count(*) n FROM shared_skill_cache').get()?.n,4096);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(peerSkillManifest(target.database,targetSkills,peer).guide,oldVersion.digest);
    assert.equal(target.database.prepare('SELECT 1 FROM shared_skill_cache_pin WHERE op_id=?').get(`remote-import:${f.runnerId}`),undefined);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    const verified=verifyRemoteImport(bundle,target.database,f.journal,targetSkills);
    const committed=commitRemoteTransfer(f.source.database,bundle,verified,sourceSkills);
    activateRemoteImport(target.database,f.runnerId,committed);
    assert.equal(target.database.prepare('SELECT 1 FROM shared_skill_cache_pin WHERE op_id=?').get(`remote-import:${f.runnerId}`),undefined);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('import rejects a full cache when all previous versions are pinned',()=>{
  const f=fixture();
  const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const oldSkills=new SkillStore(join(f.dir,'old-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  try{
    sourceSkills.create('guide');
    sourceSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: new\n---\nNew version.');
    targetSkills.create('guide');
    targetSkills.writeFile('guide','SKILL.md',sourceSkills.readFile('guide','SKILL.md').content);
    oldSkills.create('guide');
    oldSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: old\n---\nOld version.');
    const peer=new SharedWorkspace(undefined,target).grant('origin').id;
    const oldVersion=collectSkillVersion(oldSkills,'guide');
    syncSkillVersion(target.database,targetSkills,peer,oldVersion);
    const insert=target.database.prepare('INSERT INTO shared_skill_cache VALUES (?,?,?,?,?)');
    const pin=target.database.prepare('INSERT INTO shared_skill_cache_pin VALUES (?,?,?,?)');
    for(let i=0;i<4095;i++){
      const dummy=`dummy-${i}`;
      insert.run(dummy,'dummy','a'.repeat(64),0,Date.now()+100000);
      pin.run('other-operation',dummy,'dummy','a'.repeat(64));
    }
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    assert.throws(()=>importRemoteTransfer(bundle,target,f.journal,targetSkills,peer),/캐시 공간/);
    assert.equal(peerSkillManifest(target.database,targetSkills,peer).guide,oldVersion.digest);
    assert.equal(target.database.prepare('SELECT count(*) n FROM shared_skill_cache').get()?.n,4096);
    assert.equal(target.database.prepare('SELECT 1 FROM shared_skill_cache_pin WHERE op_id=?').get(`remote-import:${f.runnerId}`),undefined);
    assert.equal(target.database.prepare('SELECT 1 FROM remote_import WHERE runner_id=?').get(f.runnerId),undefined);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('abort preserves edited imported files, and a failed import cleans only its new files before retry',()=>{
  const f=fixture();
  const sourceSkills=new SkillStore(join(f.dir,'source-skills'));
  const target=new Store(join(f.dir,'target','workspace.db'));
  const targetSkills=new SkillStore(join(f.dir,'target','desk-plugin'));
  try{
    sourceSkills.create('guide');
    sourceSkills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: source\n---\nUse this guide.');
    sourceSkills.writeFile('guide','scripts/run.sh','#!/bin/sh\necho ready\n',true);
    f.source.setSetting('migration-conflict','source');
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId,sourceSkills);
    const peer=new SharedWorkspace(undefined,target).grant('origin').id;
    target.setSetting('migration-conflict','target');
    assert.throws(()=>importRemoteTransfer(bundle,target,f.journal,targetSkills,peer),/UNIQUE constraint/);
    assert.deepEqual(targetSkills.names(),[],'failed transaction cleans the skill it created');
    assert.equal(target.setting('migration-conflict'),'target');
    target.setSetting('migration-conflict',null);
    importRemoteTransfer(bundle,target,f.journal,targetSkills,peer);
    targetSkills.writeFile('guide','scripts/run.sh','#!/bin/sh\necho user edit\n',true);
    abortRemoteImport(bundle,target.database,f.journal,targetSkills);
    assert.equal(targetSkills.readFile('guide','scripts/run.sh').content,'#!/bin/sh\necho user edit\n');
    assert.equal(target.database.prepare('SELECT 1 FROM shared_skill_owner WHERE name=?').get('guide'),undefined);
    writeFileSync(join(targetSkills.home,'skills','guide','scripts','run.sh'),'#!/bin/sh\necho ready\n');
    assert.equal(abortRemoteImport(bundle,target.database,f.journal,targetSkills).runner_id,f.runnerId,'abort cleanup is retryable');
    assert.equal(targetSkills.readFile('guide','scripts/run.sh').content,'#!/bin/sh\necho ready\n',
      'ownership of a preserved user edit is released after abort');
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('CLI export, import and verify preserve native IDs and bind skills to the granted source peer',()=>{
  const f=fixture();const targetPath=join(f.dir,'cli-target','workspace.db');const target=new Store(targetPath);
  try{
    f.hub.skills.create('guide','source');
    f.hub.skills.writeFile('guide','SKILL.md','---\nname: guide\ndescription: source\n---\nFollow the guide.');
    const peer=new SharedWorkspace(undefined,target).grant('source-hub').id;
    const bundleFile=join(f.dir,'cli-bundle.json'),receiptFile=join(f.dir,'cli-verified.json');
    const cli=join(import.meta.dirname,'../../hub/src/runner/remote-migration.ts');
    const child={encoding:'utf8' as const,env:{...process.env,AGENT_DESK_SKILLS_HOME:f.hub.skills.home}};
    const run=(args:string[])=>spawnSync(process.execPath,[cli,...args],child);
    const exported=run(['export',join(f.dir,'source.db'),f.runnerId,bundleFile]);
    assert.equal(exported.status,0,exported.stderr);
    const imported=run(['import',targetPath,f.journalPath,bundleFile,peer]);
    assert.equal(imported.status,0,imported.stderr);
    const verified=run(['verify',targetPath,f.journalPath,bundleFile,receiptFile]);
    assert.equal(verified.status,0,verified.stderr);
    const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
    assert.equal(receipt.runner_id,f.runnerId);
    assert.equal(target.getSession('session-remote')?.engine_session_id,'engine-native');
    assert.equal(target.listEvents('task-remote')[0].id,f.oldEvent.id);
    assert.equal(target.database.prepare('SELECT peer_id FROM shared_skill_owner WHERE name=?').get('guide')?.peer_id,peer);
    const aborted=run(['abort',targetPath,f.journalPath,bundleFile,join(f.dir,'cli-aborted.json')]);
    assert.equal(aborted.status,0,aborted.stderr);
    assert.equal(target.getTask('task-remote'),undefined);
    assert.equal(target.database.prepare('SELECT peer_id FROM shared_skill_owner WHERE name=?').get('guide'),undefined);
    assert.equal(run(['import',targetPath,f.journalPath,bundleFile,peer]).status,0);
    const reverified=run(['verify',targetPath,f.journalPath,bundleFile,join(f.dir,'cli-reverified.json')]);
    assert.equal(reverified.status,0,reverified.stderr);
    assert.equal(target.listEvents('task-remote')[0].id,f.oldEvent.id);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('unactivated target can abort and restore source with every original ID',()=>{
  const f=fixture();const target=new Store(join(f.dir,'target.db'));
  try{
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    importRemoteTransfer(bundle,target,f.journal);
    const verified=verifyRemoteImport(bundle,target.database,f.journal);
    const committed=commitRemoteTransfer(f.source.database,bundle,verified);
    assert.equal(f.source.getTask('task-remote'),undefined);
    const aborted=abortRemoteImport(bundle,target.database,f.journal);
    assert.deepEqual(abortRemoteImport(bundle,target.database,f.journal),aborted);
    rollbackRemoteTransfer(f.source.database,bundle,committed,aborted);
    assert.equal(f.source.getSession('session-remote')?.engine_session_id,'engine-native');
    assert.equal(f.source.listEvents('task-remote')[0].id,f.oldEvent.id);
    assert.equal(f.source.database.prepare('SELECT seq FROM remote_command WHERE runner_id=?').get(f.runnerId)?.seq,4);
    assert.equal(target.database.prepare('SELECT count(*) n FROM task').get()?.n,0);
    assert.throws(()=>rollbackRemoteTransfer(f.source.database,bundle,committed,aborted));
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('CLI commit retries the same source marker after receipt file creation fails',()=>{
  const f=fixture();const target=new Store(join(f.dir,'target.db'));
  try{
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    importRemoteTransfer(bundle,target,f.journal);
    const verified=verifyRemoteImport(bundle,target.database,f.journal);
    const bundleFile=join(f.dir,'bundle.json'),verifiedFile=join(f.dir,'verified.json');
    const blockedFile=join(f.dir,'existing.json'),receiptFile=join(f.dir,'commit.json');
    writeFileSync(bundleFile,JSON.stringify(bundle));writeFileSync(verifiedFile,JSON.stringify(verified));
    writeFileSync(blockedFile,'occupied');
    const cli=join(import.meta.dirname,'../../hub/src/runner/remote-migration.ts');
    const args=(out:string)=>[cli,'commit',join(f.dir,'source.db'),f.runnerId,bundleFile,out,verifiedFile];
    const child={encoding:'utf8' as const,env:{...process.env,AGENT_DESK_SKILLS_HOME:join(f.dir,'source-skills')}};
    const first=spawnSync(process.execPath,args(blockedFile),child);
    assert.notEqual(first.status,0);
    assert.equal(f.source.getTask('task-remote'),undefined);
    const second=spawnSync(process.execPath,args(receiptFile),child);
    assert.equal(second.status,0,second.stderr);
    const receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
    assert.equal(receipt.fingerprint,bundle.fingerprint);
    const abortBlocked=join(f.dir,'abort-existing.json'),abortFile=join(f.dir,'abort.json');
    writeFileSync(abortBlocked,'occupied');
    const abortArgs=(out:string)=>[cli,'abort',join(f.dir,'target.db'),f.journalPath,bundleFile,out];
    const abortFirst=spawnSync(process.execPath,abortArgs(abortBlocked),child);
    assert.notEqual(abortFirst.status,0);
    assert.equal(target.database.prepare('SELECT count(*) n FROM task').get()?.n,0);
    const abortSecond=spawnSync(process.execPath,abortArgs(abortFile),child);
    assert.equal(abortSecond.status,0,abortSecond.stderr);
    const aborted=JSON.parse(readFileSync(abortFile,'utf8'));
    rollbackRemoteTransfer(f.source.database,bundle,receipt,aborted);
    assert.equal(f.source.getTask('task-remote')?.id,'task-remote');
    const forged=structuredClone(bundle);forged.fingerprint='different';
    assert.throws(()=>commitRemoteTransfer(f.source.database,forged,verified),/지문/);
  }finally{f.journal.close();target.database.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('changed source or active cross-runner request blocks cutover without deleting rows',()=>{
  const f=fixture();try{
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    const verified={runner_id:f.runnerId,fingerprint:bundle.fingerprint,journal_id:f.journal.id,verified_at:new Date().toISOString()};
    f.source.addEvent('session-remote','task-remote','assistant',{text:'late'});
    assert.throws(()=>commitRemoteTransfer(f.source.database,bundle,verified),/변경/);
    assert.ok(f.source.getTask('task-remote'));
    f.source.database.prepare("UPDATE request SET status='running' WHERE id='request-to-remote'").run();
    assert.throws(()=>exportRemoteTransfer(f.source.database,f.runnerId),/열린 다른 작업 질문/);
  }finally{f.journal.close();f.hub.dispose();f.source.database.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('empty legacy project merges into existing shared source without changing its workspace, runner or tasks',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-remote-merge-'));
  const source=new Store(join(dir,'source.db'));
  const local:RunnerPort={connected:false,id:'local',engines:new Set(),has:()=>false,handle:()=>{}};
  const hub=new Hub(source,{skills:new SkillStore(join(dir,'source-skills')),runner:()=>local,graceMs:60_000});
  const registered=hub.remotes.register('user@worker');
  const oldId=registered.runner.id;
  const oldJournalPath=join(dir,'old-remote.db');
  let oldJournal=new RemoteJournal(oldJournalPath);oldJournal.bind('https://old-hub.example/',oldId);
  source.database.prepare('UPDATE remote_runner SET journal_id=? WHERE id=?').run(oldJournal.id,oldId);
  source.createProject({id:'legacy-project',name:'legacy',root_path:`user@worker:${dir}/legacy`,created_at:'2026-01-01T00:00:00Z'});
  const sharedDir=join(dir,'shared');const skills=new SkillStore(join(dir,'shared-skills'));
  let runtime:SharedRuntime|undefined,server:Server|undefined,links:WorkspaceLinks|undefined,gateway:Store|undefined,target:Store|undefined,sharedJournal:RemoteJournal|undefined;
  try{
    runtime=new SharedRuntime(sharedDir,'user@worker',{skills});
    const workspaceId=runtime.workspace.id,sharedRunnerId=runtime.hub.remotes.list()[0].id,sharedJournalId=runtime.journal.id;
    runtime.hub.store.createProject({id:'existing-project',name:'existing',root_path:`user@worker:${dir}/existing`,created_at:'2025-01-01T00:00:00Z'});
    for(const id of ['old-task-a','old-task-b'])runtime.hub.store.createTask({id,project_id:'existing-project',title:id,status:'done',checkpoint_md:null,
      created_by:'user',created_at:'2025-01-01T00:00:00Z',updated_at:'2025-01-01T00:00:00Z'});
    const token=runtime.workspace.grant('gateway').token;
    runtime.close();runtime=undefined;
    const bundle=exportRemoteTransfer(source.database,oldId);
    assert.equal(bundle.rows.task.length,0);
    target=new Store(join(sharedDir,'workspace.db'));
    sharedJournal=new RemoteJournal(join(sharedDir,'delivery.db'));
    oldJournal.claim();sharedJournal.claim();
    const nonempty=structuredClone(bundle);
    nonempty.rows.task.push({id:'unexpected'});
    nonempty.fingerprint=createHash('sha256').update(JSON.stringify({runnerId:nonempty.runner_id,address:nonempty.address,
      rows:nonempty.rows,legacy:nonempty.legacy,skills:nonempty.skills})).digest('hex');
    assert.throws(()=>importEmptyRemoteProjects(nonempty,target!.database,oldJournal,sharedJournal!),/작업 없는 프로젝트/);
    const collision=structuredClone(bundle);
    collision.rows.project[0].name='existing';
    collision.fingerprint=createHash('sha256').update(JSON.stringify({runnerId:collision.runner_id,address:collision.address,
      rows:collision.rows,legacy:collision.legacy,skills:collision.skills})).digest('hex');
    assert.throws(()=>importEmptyRemoteProjects(collision,target!.database,oldJournal,sharedJournal!),/충돌/);
    importEmptyRemoteProjects(bundle,target.database,oldJournal,sharedJournal);
    importEmptyRemoteProjects(bundle,target.database,oldJournal,sharedJournal);
    const aborted=abortEmptyRemoteMerge(bundle,target.database,oldJournal,sharedJournal);
    assert.deepEqual(abortEmptyRemoteMerge(bundle,target.database,oldJournal,sharedJournal),aborted);
    assert.equal(target.getProject('legacy-project'),undefined);
    importEmptyRemoteProjects(bundle,target.database,oldJournal,sharedJournal);
    const verified=verifyEmptyRemoteMerge(bundle,target.database,oldJournal,sharedJournal);
    assert.equal(target.getProject('existing-project')?.name,'existing');
    assert.equal(target.listTasks().length,2);
    sharedJournal.close();sharedJournal=undefined;oldJournal.close();
    target.database.close();target=undefined;
    assert.throws(()=>new SharedRuntime(sharedDir,'user@worker',{skills}),/아직 활성화/);
    const committed=commitRemoteTransfer(source.database,bundle,verified);
    target=new Store(join(sharedDir,'workspace.db'));
    activateEmptyRemoteMerge(target.database,oldId,committed);
    target.database.close();target=undefined;
    runtime=new SharedRuntime(sharedDir,'user@worker',{skills});
    assert.equal(runtime.workspace.id,workspaceId);
    assert.equal(runtime.hub.remotes.list()[0].id,sharedRunnerId);
    assert.equal(runtime.journal.id,sharedJournalId);
    assert.equal(runtime.hub.store.listTasks().length,2);
    assert.equal(runtime.hub.store.getProject('legacy-project')?.name,'legacy');
    server=runtime.workspace.server();
    await new Promise<void>((resolve,reject)=>server!.once('error',reject).listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    gateway=new Store(join(dir,'gateway.db'));links=new WorkspaceLinks(gateway);
    const existing=await links.attach({name:'shared',url:`http://127.0.0.1:${port}/`,token},'existing-link');
    const merged=await links.installMerged(join(dir,'source.db'),oldId,existing.id);
    assert.equal(merged.id,'existing-link');
    assert.equal(merged.workspace_id,workspaceId);
    assert.equal(merged.view_index,existing.view_index);
    assert.deepEqual(merged.legacy_project_ids,['legacy-project']);
    assert.deepEqual(merged.legacy_runner_ids,[oldId]);
    assert.equal(links.remoteOwner('user@worker'),'existing-link');
    importRemoteManifests(join(dir,'source.db'),gateway,true);
  }finally{
    if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await links?.close();gateway?.database.close();runtime?.close();target?.database.close();sharedJournal?.close();
    if(oldJournal)try{oldJournal.close();}catch{/* already closed */}
    hub.dispose();source.database.close();rmSync(dir,{recursive:true,force:true});
  }
});

test('gateway routes old IDs, new remote addresses and existing project names, including offline input',async()=>{
  const f=fixture();let target:Store|undefined,remote:SharedRuntime|undefined,authority:LocalRuntime|undefined;
  let gateway:Store|undefined,links:WorkspaceLinks|undefined,gatewayHub:Hub|undefined;
  let remoteServer:Server|undefined,localServer:Server|undefined,gatewayServer:Server|undefined;
  try{
    const bundle=exportRemoteTransfer(f.source.database,f.runnerId);
    const targetDir=join(f.dir,'target');target=new Store(join(targetDir,'workspace.db'));
    importRemoteTransfer(bundle,target,f.journal);
    const verified=verifyRemoteImport(bundle,target.database,f.journal);
    const committed=commitRemoteTransfer(f.source.database,bundle,verified);
    activateRemoteImport(target.database,f.runnerId,committed);
    target.database.close();target=undefined;
    f.journal.close();f.hub.dispose();f.source.database.close();
    const starts:StartOptions[]=[];
    remote=new SharedRuntime(targetDir,'user@worker',{skills:new SkillStore(join(targetDir,'desk-plugin')),
      migration:{runnerId:f.runnerId,journalPath:f.journalPath,skillsHome:join(f.dir,'engine-skills')},
      start:opts=>{starts.push(opts);return {send:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval:()=>{},close:()=>{}};}});
    const remoteToken=remote.workspace.grant('gateway').token;
    remoteServer=remote.workspace.server();
    await new Promise<void>((resolve,reject)=>remoteServer!.once('error',reject).listen(0,'127.0.0.1',resolve));
    const remoteUrl=`http://127.0.0.1:${(remoteServer.address() as {port:number}).port}/`;
    const localRunner:RunnerPort={connected:true,id:'local-test',engines:new Set(['codex']),has:()=>false,handle:()=>{}};
    authority=new LocalRuntime(join(f.dir,'source.db'),{skills:new SkillStore(join(f.dir,'local-skills')),runner:()=>localRunner,graceMs:60_000});
    const localToken=authority.workspace.grant('gateway').token;
    localServer=authority.server();
    await new Promise<void>((resolve,reject)=>localServer!.once('error',reject).listen(0,'127.0.0.1',resolve));
    const localUrl=`http://127.0.0.1:${(localServer.address() as {port:number}).port}/`;
    gateway=new Store(join(f.dir,'gateway.db'));links=new WorkspaceLinks(gateway);
    await links.configureLocal(localUrl,localToken);
    await links.installMigrated(join(f.dir,'source.db'),f.runnerId,{url:remoteUrl,token:remoteToken});
    importRemoteManifests(join(f.dir,'source.db'),gateway,true);
    const gatewayRunner:RunnerPort={connected:false,id:'gateway',engines:new Set(),has:()=>false,handle:()=>{throw new Error('gateway engine start');}};
    gatewayHub=new Hub(gateway,{skills:new SkillStore(join(f.dir,'gateway-skills')),runner:()=>gatewayRunner,graceMs:60_000});
    const access=new Access(join(f.dir,'access-token'),4317,join(f.dir,'devices.json'));
    gatewayServer=createHttpServer(gatewayHub,access,join(f.dir,'uploads'),{workspaces:links,localAuthorityId:'local-authority'});
    await new Promise<void>((resolve,reject)=>gatewayServer!.once('error',reject).listen(0,'127.0.0.1',resolve));
    const gatewayUrl=`http://127.0.0.1:${(gatewayServer.address() as {port:number}).port}`;
    const api=async(path:string,body:unknown)=>{
      const response=await fetch(gatewayUrl+'/api'+path,{method:'POST',headers:{'content-type':'application/json','x-desk-operation-id':crypto.randomUUID()},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json() as any};
    };
    const newDir=join(f.dir,'new');mkdirSync(newDir);
    const explicit=await api('/compose',{text:`@new:user@worker:${newDir} #codex begin`});
    assert.equal(explicit.status,201,JSON.stringify(explicit.body));
    assert.ok(remote.hub.store.getTask(explicit.body.id));
    assert.equal(authority.hub.store.getTask(explicit.body.id),undefined);
    const existing=await api('/compose',{text:'@remote #codex continue'});
    assert.equal(existing.status,201,JSON.stringify(existing.body));
    assert.ok(remote.hub.store.getTask(existing.body.id));
    const oldReply=await api('/tasks/task-remote/messages',{text:'legacy plain ID reply'});
    assert.equal(oldReply.status,202,JSON.stringify(oldReply.body));
    assert.ok(remote.hub.store.queued({taskId:'task-remote'}).length||remote.hub.store.listEvents('task-remote').length>1);
    assert.equal(gateway.listTasks().length,0);
    await new Promise<void>(resolve=>remoteServer!.close(()=>resolve()));remoteServer=undefined;
    const offlineDir=join(f.dir,'offline');mkdirSync(offlineDir);
    const offline=await api('/compose',{text:`@offline:user@worker:${offlineDir} #codex queued`});
    assert.equal(offline.status,202,JSON.stringify(offline.body));
    assert.equal(offline.body.shared_pending,true);
    remoteServer=remote.workspace.server();
    await new Promise<void>((resolve,reject)=>remoteServer!.once('error',reject).listen(Number(new URL(remoteUrl).port),'127.0.0.1',resolve));
    await links.flush(f.runnerId);
    assert.ok(remote.hub.store.findProjectByName('offline'));
    assert.equal(remote.hub.store.listTasks().filter(t=>t.project_id===remote!.hub.store.findProjectByName('offline')!.id).length,1);
  }finally{
    if(gatewayServer?.listening)await new Promise<void>(resolve=>gatewayServer!.close(()=>resolve()));
    if(localServer?.listening)await new Promise<void>(resolve=>localServer!.close(()=>resolve()));
    if(remoteServer?.listening)await new Promise<void>(resolve=>remoteServer!.close(()=>resolve()));
    await links?.close();gatewayHub?.dispose();gateway?.database.close();authority?.close();remote?.close();target?.database.close();
    rmSync(f.dir,{recursive:true,force:true});
  }
});
