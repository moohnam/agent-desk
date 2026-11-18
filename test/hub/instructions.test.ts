import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { InstructionStore, DEFAULT_INSTRUCTIONS } from '../../hub/src/instruction-store.ts';
import { deskInstructions } from '../../hub/src/runner/instructions.ts';
import { SharedRuntime } from '../../hub/src/runner/shared-runtime.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import type { StartOptions } from '../../hub/src/runner/engine.ts';
import { needsDefaultInstructions } from '../../hub/src/workspace-api.ts';

const listen = (server: Server) => new Promise<string>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`));
});
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test('only potentially new conversations read hub defaults; existing controls survive invalid files and old runners', async () => {
  const db = new Store(':memory:');
  const links = new WorkspaceLinks(db);
  db.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run('old', 'old', 'http://127.0.0.1:1/', 'workspace', 'fixture');
  let reads = 0;
  links.instructions = () => { reads++; throw new Error('손상된 지침 파일'); };
  const calls: string[] = [];
  (links as unknown as {request: (link: unknown, path: string) => Promise<unknown>}).request = async (_link, path) => {
    calls.push(path);
    return {status:200, body:path === '/v1/identity' ? {capabilities:{}} : {ok:true}};
  };
  try {
    for (const [method,path,body] of [
      ['POST','/tasks/task/interrupt',{}], ['POST','/tasks/task/close',{}],
      ['POST','/approvals/approval',{allow:true}], ['POST','/questions/question',{answer:'답'}],
      ['DELETE','/tasks/task',{}], ['PATCH','/tasks/task',{title:'제목'}],
      ['POST','/tasks/task/reset',{text:'새 문맥'}], ['POST','/tasks/task/handoff',{}],
      ['POST','/tasks/task/messages',{text:'기존 대화 #now'}],
      ['POST','/compose',{text:'@project#1 기존 대화'}],
      ['PUT','/tasks/task/queue/item',{index:0}], ['PUT','/settings',{claude:{model:null}}],
    ] as [string,string,Record<string,unknown>][]) {
      assert.equal(needsDefaultInstructions(method,path,body),false,path);
      links.enqueue('old',{id:randomUUID(),method,path,body});
    }
    await links.flush('old');
    assert.equal(reads,0);
    assert.equal(calls.length,12);
    assert.ok(calls.every(path=>path==='/v1/operation'));
    for (const [path,body] of [
      ['/tasks',{prompt:'새 작업'}], ['/tasks/task/messages',{text:'#new 새 대화'}],
      ['/tasks/task/messages',{text:'#fork 분기'}], ['/compose',{text:'@project#1 #fork 분기'}],
      ['/compose',{text:'@project 새 작업 가능'}], ['/channels/channel/messages',{text:'첫 대화 가능'}],
    ] as [string,Record<string,unknown>][]) assert.equal(needsDefaultInstructions('POST',path,body),true,path);
  } finally {await links.close();db.database.close();}
});

test('shared instruction support is rechecked after a runner version change', async () => {
  const db = new Store(':memory:');
  const links = new WorkspaceLinks(db);
  db.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run('peer', 'peer', 'http://127.0.0.1:1/', 'workspace', 'fixture');
  links.instructions = () => '사용자 지침';
  let supported = true, operations = 0, identities = 0;
  (links as unknown as {request: (link: unknown, path: string) => Promise<unknown>}).request = async (_link, path) => {
    if (path === '/v1/identity') {identities++;return {status:200,body:{capabilities:{instructions:supported?1:undefined}}};}
    if (path.startsWith('/v1/receipts/')) return {status:404,body:{code:'receipt_not_found'}};
    operations++;return {status:201,body:{id:'task'}};
  };
  try {
    links.enqueue('peer',{id:randomUUID(),method:'POST',path:'/tasks',body:{project_id:'project',prompt:'처음'}});
    await links.flush('peer');
    supported=false;
    links.enqueue('peer',{id:randomUUID(),method:'POST',path:'/tasks',body:{project_id:'project',prompt:'다음'}});
    await links.flush('peer');
    assert.equal(identities,2);assert.equal(operations,1);
    assert.match(links.deliveries('peer')[0].error,/업데이트/);
  } finally {await links.close();db.database.close();}
});

test('instruction text files preserve edits, reject stale writes, allow empty content and keep generated rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-instructions-'));
  try {
    const store = new InstructionStore(join(dir, 'instructions.md'));
    const initial = store.read();
    assert.equal(initial.text, DEFAULT_INSTRUCTIONS);
    const updated = store.save('사용자 지침', initial.revision);
    assert.equal(readFileSync(store.path, 'utf8'), '사용자 지침');
    assert.equal(new InstructionStore(store.path).read().revision, updated.revision);
    assert.throws(() => store.save('덮어쓰기', initial.revision), /변경/);
    writeFileSync(store.path, '외부 편집');
    assert.throws(() => store.save('덮어쓰기', updated.revision), /변경/);
    assert.throws(() => store.save('한'.repeat(12000), store.read().revision), /32 KiB/);
    assert.throws(() => store.save('\0', store.read().revision), /텍스트/);
    store.save('', store.read().revision);
    assert.equal(new InstructionStore(store.path).read().text, '');
    assert.equal(deskInstructions(undefined, ''), '');
    assert.match(deskInstructions('/runner/plugin', '사용자 지침'), /^사용자 지침\n\[데스크 스킬 참조\]/);
    symlinkSync(store.path, join(dir, 'link'));
    assert.throws(() => new InstructionStore(join(dir, 'link')).read());
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('hub settings API owns its file, enforces origin and detects concurrent edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-instructions-api-'));
  const db = new Store(':memory:');
  const hub = new Hub(db, {skills:new SkillStore(join(dir, 'skills')), runner:()=>({connected:true,id:'fake',engines:new Set(),has:()=>false,handle:()=>{}})});
  const instructions = new InstructionStore(join(dir, 'instructions.md'));
  const server = createHttpServer(hub, new Access(join(dir, 'token'), 4317), join(dir, 'uploads'), {instructions});
  try {
    const url = await listen(server);
    const get = await fetch(url + '/api/instructions');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const saved = await get.json() as {revision:string};
    const put = (text:string, origin=url) => fetch(url + '/api/instructions', {method:'PUT',headers:{'content-type':'application/json',origin},body:JSON.stringify({text,revision:saved.revision})});
    assert.equal((await put('다른 사이트', 'http://evil.invalid')).status, 403);
    assert.equal((await put('허브 지침')).status, 200);
    assert.equal(hub.defaultInstructions(), '허브 지침');
    assert.equal((await put('덮어쓰기')).status, 409);
  } finally { await stop(server); hub.dispose(); db.database.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('shared execution receives the accepting hub snapshot, survives queue replay and keeps it on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-instruction-remote-'));
  const starts: StartOptions[] = [];
  const runtime = new SharedRuntime(join(dir, 'runner'), 'test@worker', {autoStart:false, start: opts => {
    starts.push(opts);
    return {send:()=>{},resolveApproval:()=>{},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},close:()=>{}};
  }});
  const server = runtime.workspace.server();
  const db = new Store(join(dir, 'gateway.db'));
  let links = new WorkspaceLinks(db);
  try {
    const url = await listen(server);
    runtime.exchange(); // Advertise runner capabilities before accepting custom instructions.
    const peer = runtime.workspace.grant('gateway');
    const link = await links.attach({name:'test', url, token:peer.token});
    links.instructions = () => '허브 A의 지침';
    const op = {id:randomUUID(),method:'POST',path:'/compose',body:{text:`@sample:test@worker:${dir} #claude 시작`}};
    links.enqueue(link.id, op);
    await links.close();
    links = new WorkspaceLinks(db);
    links.instructions = () => '수정한 지침';
    await links.flush(link.id);
    runtime.start();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].instructions, '허브 A의 지침');
    links.enqueue(link.id, op);
    await links.flush(link.id);
    assert.equal(starts.length, 1);
    const first = starts[0];
    runtime.agent.runner.handle({type:'close', sessionId:first.sessionId});
    runtime.exchange();
    const task = runtime.hub.store.listTasks()[0];
    runtime.hub.withInstructions('다른 허브의 지침', () => runtime.hub.sendMessage(task.id, '재개'));
    runtime.exchange();
    assert.equal(starts.at(-1)!.instructions, '허브 A의 지침');
    starts.at(-1)!.emit({type:'busy',sessionId:starts.at(-1)!.sessionId,busy:false}); runtime.exchange();
    runtime.hub.withInstructions('다른 지침', () => runtime.hub.resetContext(task.id, '문맥 재구성'));
    runtime.exchange();
    assert.equal(starts.at(-1)!.instructions, '허브 A의 지침');
    links.enqueue(link.id, {...op,id:randomUUID(),body:{text:`@second:test@worker:${dir} #claude 새 실행`}});
    await links.flush(link.id); runtime.exchange();
    assert.equal(starts.at(-1)!.instructions, '수정한 지침');
    assert.throws(()=>links.enqueue(link.id,{...op,id:randomUUID(),body:{...op.body,__desk_instructions:'위조'}}), /내부/);
    assert.throws(()=>runtime.hub.withInstructions(42,()=>{}), /텍스트/);
    const count = runtime.hub.store.listTasks().length;
    runtime.hub.store.database.prepare('UPDATE remote_runner SET instructions=0').run();
    assert.throws(()=>runtime.hub.withInstructions('새 지침',()=>runtime.hub.compose(`@old:test@worker:${dir} #claude 차단`)), /사용자 지침/);
    assert.equal(runtime.hub.store.listTasks().length, count);
  } finally { await links.close(); await stop(server); runtime.close(); db.database.close(); rmSync(dir,{recursive:true,force:true}); }
});
