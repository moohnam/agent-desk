import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { LocalRuntime } from '../../hub/src/runner/local-runtime.ts';
import { Store } from '../../hub/src/db.ts';
import type { RunnerFactory } from '../../hub/src/runner/client.ts';
import type { HubToRunner } from '../../shared/protocol.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { importLegacyWorkspaceLinks } from '../../hub/src/runner/local-migration.ts';
import { localAuthorityActivated, assertLegacyHubAllowed } from '../../hub/src/runner/local-ownership.ts';
import { SkillStore } from '../../hub/src/skills.ts';

test('local authority preserves task, session, queue and runner IDs across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-authority-'));
  const db = join(dir, 'desk.db');
  const project = join(dir, 'project');
  mkdirSync(project);
  const commands: HubToRunner[] = [];
  const runner: RunnerFactory = () => ({
    connected: true, id: 'local-existing-runner', engines: new Set(['claude']),
    has: () => true, handle: command => { commands.push(command); },
  });
  let first: LocalRuntime | undefined;
  let second: LocalRuntime | undefined;
  try {
    first = new LocalRuntime(db, {runner,skills:new SkillStore(join(dir,'skills'))});
    first.activate();
    const peer = first.workspace.grant('gateway');
    const task = first.workspace.execute(peer.id, {id:randomUUID(),method:'POST',path:'/compose',body:{text:`@one:${project} #claude first`}}).body;
    const rename = {id:randomUUID(),method:'PATCH',path:`/tasks/${task.id}`,body:{title:'  새 제목  '}};
    assert.equal(first.workspace.execute(peer.id, rename).body.title, '새 제목');
    assert.equal(first.workspace.execute(peer.id, rename).body.title, '새 제목', 'the shared operation receipt is reusable');
    assert.equal(first.workspace.execute(peer.id, {id:randomUUID(),method:'PATCH',path:`/tasks/${task.id}`,body:{title:'  '}}).status, 400);
    assert.equal(first.workspace.execute(peer.id, {id:randomUUID(),method:'PATCH',path:'/tasks/missing',body:{title:'새 제목'}}).status, 404);
    const revoked = first.workspace.grant('revoked');
    first.workspace.revoke(revoked.id);
    assert.throws(() => first!.workspace.execute(revoked.id, {id:randomUUID(),method:'PATCH',path:`/tasks/${task.id}`,body:{title:'거부'}}), {status:401});
    const session = first.hub.store.latestSession(task.id)!;
    assert.equal(session.runner_id, 'local-existing-runner');
    assert.ok(commands.some(command => command.type === 'start' && command.sessionId === session.id));
    first.workspace.execute(peer.id, {id:randomUUID(),method:'POST',path:`/tasks/${task.id}/messages`,body:{text:'#later keep this input'}});
    const queued = first.hub.store.queued().map(row => row.id);
    assert.equal(queued.length, 1);
    assert.throws(() => new LocalRuntime(db, {runner,skills:new SkillStore(join(dir,'skills'))}), /이미 실행/);
    first.close();
    second = new LocalRuntime(db, {runner,skills:new SkillStore(join(dir,'skills'))});
    assert.equal(second.workspace.id, first.workspace.id);
    assert.equal(second.hub.store.getTask(task.id)?.id, task.id);
    assert.equal(second.hub.store.latestSession(task.id)?.id, session.id);
    assert.equal(second.hub.store.latestSession(task.id)?.runner_id, session.runner_id);
    assert.deepEqual(second.hub.store.queued().map(row => row.id), queued);
  } finally { second?.close(); first?.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('initial local authority activation rejects an unfinished legacy session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-cutover-'));
  const db = join(dir, 'desk.db');
  const store = new Store(db);
  try {
    store.database.prepare('INSERT INTO project VALUES (?,?,?,?)').run('p','existing',dir,new Date().toISOString());
    store.database.prepare("INSERT INTO task (id,project_id,title,status,created_by,created_at,updated_at,seq) VALUES ('t','p','old','running','owner','2026-01-01','2026-01-01',1)").run();
    store.database.prepare("INSERT INTO session (id,task_id,engine,cwd,source,status,runner_id,created_at) VALUES ('s','t','claude',?,'app','running','local-existing-runner','2026-01-01')").run(dir);
    assert.throws(() => new LocalRuntime(db, {skills:new SkillStore(join(dir,'skills')),runner: () => {throw new Error('runner must not start');}}), /진행 중/);
    assert.equal((store.database.prepare('SELECT count(*) n FROM session').get() as {n:number}).n, 1);
  } finally { store.database.close(); rmSync(dir, {recursive:true,force:true}); }
});

test('gateway import keeps pending operation IDs and view indices exactly once', async () => {
  const dir=mkdtempSync(join(tmpdir(),'desk-local-import-'));
  const source=new Store(join(dir,'canonical.db'));
  const gateway=new Store(join(dir,'gateway.db'));
  const sourceLinks=new WorkspaceLinks(source),gatewayLinks=new WorkspaceLinks(gateway);
  try {
    const link='existing-link',operation='existing-operation';
    source.database.prepare('INSERT INTO workspace_link VALUES (?,?,?,?,?)').run(link,'remote','http://127.0.0.1:4321/','workspace-id','secret');
    source.database.prepare('INSERT INTO workspace_view_index(seq,link_id) VALUES (?,?)').run(19,link);
    source.database.prepare('INSERT INTO workspace_delivery(seq,id,link_id,digest,payload,result,status) VALUES (?,?,?,?,?,?,?)')
      .run(42,operation,link,'digest',JSON.stringify({id:operation,method:'POST',path:'/compose',body:{text:'pending'}}),null,null);
    importLegacyWorkspaceLinks(join(dir,'canonical.db'),gateway);
    importLegacyWorkspaceLinks(join(dir,'canonical.db'),gateway);
    assert.equal(gatewayLinks.list()[0].view_index,19);
    assert.equal(gatewayLinks.list()[0].pending,1);
    assert.equal((gateway.database.prepare('SELECT seq FROM workspace_delivery WHERE id=?').get(operation) as {seq:number}).seq,42);
    assert.equal((gateway.database.prepare('SELECT count(*) n FROM workspace_delivery').get() as {n:number}).n,1);
    source.database.prepare('INSERT INTO workspace_delivery(seq,id,link_id,digest,payload,result,status) VALUES (?,?,?,?,?,?,?)')
      .run(43,'unexpected',link,'digest','{}',null,null);
    assert.throws(()=>importLegacyWorkspaceLinks(join(dir,'canonical.db'),gateway),/이관 뒤 바뀌었습니다/);
  } finally { await sourceLinks.close();await gatewayLinks.close();source.database.close();gateway.database.close();rmSync(dir,{recursive:true,force:true}); }
});

test('closing a local authority cancels delayed runner reconciliation', async () => {
  const dir=mkdtempSync(join(tmpdir(),'desk-local-grace-'));
  try {
    const runtime=new LocalRuntime(join(dir,'desk.db'),{graceMs:5,skills:new SkillStore(join(dir,'skills')),runner:()=>({
      connected:false,id:null,engines:new Set(),has:()=>false,handle:()=>{},
    })});
    runtime.close();
    await new Promise(resolve=>setTimeout(resolve,30));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('failed construction and failed first listen leave the legacy database available',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-local-first-fail-'));
  const db=join(dir,'desk.db');
  const skills=new SkillStore(join(dir,'skills'));
  const blocker=createServer();
  try {
    assert.throws(()=>new LocalRuntime(db,{skills,runner:()=>{throw new Error('injected construction failure');}}),/injected construction failure/);
    assert.equal(localAuthorityActivated(db),false);
    assert.doesNotThrow(()=>assertLegacyHubAllowed(db));
    await new Promise<void>(resolve=>blocker.listen(0,'127.0.0.1',()=>resolve()));
    const port=(blocker.address() as {port:number}).port;
    const runtime=new LocalRuntime(db,{skills,runner:()=>({connected:false,id:null,engines:new Set(),has:()=>false,handle:()=>{}})});
    assert.equal(localAuthorityActivated(db),false);
    assert.throws(()=>assertLegacyHubAllowed(db),/소유/);
    const server=runtime.server();
    await new Promise<void>(resolve=>{server.once('error',()=>resolve());server.listen(port,'127.0.0.1');});
    assert.equal(localAuthorityActivated(db),false);
    assert.doesNotThrow(()=>assertLegacyHubAllowed(db));
    const retry=new LocalRuntime(db,{skills,runner:()=>({connected:false,id:null,engines:new Set(),has:()=>false,handle:()=>{}})});
    retry.activate();
    assert.equal(localAuthorityActivated(db),true);
    retry.close();
  }finally{if(blocker.listening)await new Promise<void>(resolve=>blocker.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
