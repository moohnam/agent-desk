import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { SkillStore } from '../../hub/src/skills.ts';
import { applySkillBundle, collectSkillBundle, collectSkillVersion, peerSkillManifest, peerSkillStore, restoreSkillBundle, skillDigest, syncSkillVersion } from '../../hub/src/shared-skill-sync.ts';
import { SharedRuntime } from '../../hub/src/runner/shared-runtime.ts';
import { Store } from '../../hub/src/db.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import type { StartOptions } from '../../hub/src/runner/engine.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-skill-sync-'));
  const source = new SkillStore(join(dir, 'source'));
  const target = new SkillStore(join(dir, 'target'));
  const db = new DatabaseSync(join(dir, 'target.db'));
  const parent = source.create('parent');
  source.writeFile(parent.name, 'SKILL.md', '---\nname: parent\ndescription: Parent\n---\nUse #child when needed. `#ignored` is an example.\n```\n#code\n```\n');
  source.writeFile(parent.name, 'scripts/run.sh', '#!/bin/sh\necho parent\n', true);
  source.create('child');
  source.writeFile('child', 'SKILL.md', '---\nname: child\ndescription: Child\n---\nFollow the child procedure.\n');
  source.create('ignored');
  return { dir, source, target, db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('selected skill and conditional child remain pinned while equal names from two peers stay separate', () => {
  const f = fixture();
  try {
    assert.equal(collectSkillBundle(f.source, 'plain text'), null);
    assert.equal(collectSkillBundle(f.source, '#auto #now only control tags'), null);
    const bundle = collectSkillBundle(f.source, '#parent 작업')!;
    assert.deepEqual(Object.keys(bundle.hashes), ['child', 'ignored', 'parent']);
    assert.ok(bundle.files.some(file => file.name === 'ignored'), 'inline names are available without activating them');
    assert.deepEqual(bundle.selected,['parent']);
    syncSkillVersion(f.db,f.target,'peer-a',collectSkillVersion(f.source,'parent'));
    applySkillBundle(f.db, f.target, 'peer-a', 'old-op', bundle);
    assert.equal(peerSkillStore(f.db,f.target,'peer-a','parent').readFile('parent','scripts/run.sh').content,'#!/bin/sh\necho parent\n');
    assert.equal(restoreSkillBundle(f.target,'peer-a',bundle)?.digest,bundle.digest);
    assert.deepEqual(peerSkillManifest(f.db,f.target,'peer-a'),{parent:bundle.hashes.parent});
    f.source.writeFile('parent', 'scripts/run.sh', '#!/bin/sh\necho revised\n', true);
    const revised = collectSkillBundle(f.source, '#parent 작업')!;
    syncSkillVersion(f.db,f.target,'peer-b',collectSkillVersion(f.source,'parent'));
    assert.equal(peerSkillStore(f.db,f.target,'peer-a','parent').readFile('parent','scripts/run.sh').content,'#!/bin/sh\necho parent\n');
    assert.equal(peerSkillStore(f.db,f.target,'peer-b','parent').readFile('parent','scripts/run.sh').content,'#!/bin/sh\necho revised\n');
    assert.equal(restoreSkillBundle(f.target,'peer-a',bundle)?.digest,bundle.digest);
    assert.notEqual(peerSkillManifest(f.db,f.target,'peer-a').parent,peerSkillManifest(f.db,f.target,'peer-b').parent);
  } finally { f.close(); }
});

test('same peer keeps an old queued version after the latest manifest changes', () => {
  const f = fixture();
  try {
    const original = collectSkillBundle(f.source, '#parent')!;
    syncSkillVersion(f.db,f.target,'gateway-peer',collectSkillVersion(f.source,'parent'));
    applySkillBundle(f.db,f.target,'gateway-peer','queued-old',original);
    f.source.writeFile('parent', 'scripts/run.sh', '#!/bin/sh\necho after migration\n', true);
    const revised = collectSkillBundle(f.source, '#parent')!;
    syncSkillVersion(f.db,f.target,'gateway-peer',collectSkillVersion(f.source,'parent'));
    assert.equal(peerSkillManifest(f.db,f.target,'gateway-peer').parent,revised.hashes.parent);
    assert.equal(restoreSkillBundle(f.target,'gateway-peer',original)?.digest,original.digest);
    assert.throws(()=>applySkillBundle(f.db,f.target,'gateway-peer','queued-old',revised),/같은 명령 ID/);
  } finally { f.close(); }
});

test('same operation repairs a missing or altered cached version from frozen bytes', () => {
  const f = fixture();
  try {
    const first = collectSkillBundle(f.source, '#parent')!;
    const op=randomUUID();
    applySkillBundle(f.db,f.target,'peer',op,first);
    const home=join(f.target.home,'.skill-sync','peers',createHash('sha256').update('peer').digest('hex').slice(0,32),'parent',first.hashes.parent);
    rmSync(join(home,'skills','parent'),{recursive:true,force:true});
    assert.equal(restoreSkillBundle(f.target,'peer',first),null);
    applySkillBundle(f.db,f.target,'peer',op,first);
    writeFileSync(join(home,'skills','parent','SKILL.md'),'changed');
    assert.equal(restoreSkillBundle(f.target,'peer',first),null);
    applySkillBundle(f.db,f.target,'peer',op,first);
    assert.equal(restoreSkillBundle(f.target,'peer',first)?.digest,first.digest);
    assert.equal(skillDigest(first.files.filter(file=>file.name==='parent')),first.hashes.parent);
  } finally { f.close(); }
});

test('tampered bundle or unsafe file path is rejected before creating target files', () => {
  const f = fixture();
  try {
    const good = collectSkillBundle(f.source, '#parent')!;
    assert.throws(() => applySkillBundle(f.db, f.target, 'peer', randomUUID(), { ...good, digest: 'wrong' }), /지문/);
    assert.throws(() => applySkillBundle(f.db, f.target, 'peer', randomUUID(), {
      ...good, files: [{ ...good.files[0], path: '../escape' }, ...good.files.slice(1)],
    }), /형식/);
    assert.deepEqual(f.target.names(), []);
  } finally { f.close(); }
});

test('an oversized skill closure is rejected at collection before it enters a queue', () => {
  const f=fixture();
  try {
    for(let i=0;i<5;i++)f.source.writeFile('parent',`assets/${i}.txt`,'x'.repeat(900_000));
    assert.throws(()=>collectSkillBundle(f.source,'#parent'),(error:any)=>error.status===413);
  } finally {f.close();}
});

test('gateway freezes the selected files at enqueue while offline and stores prompt only once', async () => {
  const f=fixture();
  const store=new Store(join(f.dir,'gateway.db'));
  const links=new WorkspaceLinks(store,f.source);
  try {
    store.database.prepare('INSERT INTO workspace_link VALUES (?,?,?,?,?)')
      .run('remote','remote','http://127.0.0.1:1/','remote-workspace','a'.repeat(43));
    const op={id:randomUUID(),method:'POST',path:'/compose',body:{text:'#parent first version'}};
    links.enqueue('remote',op);
    f.source.writeFile('parent','scripts/run.sh','#!/bin/sh\necho second\n',true);
    const row=store.database.prepare('SELECT payload,prepared_payload FROM workspace_delivery WHERE id=?').get(op.id) as
      {payload:string;prepared_payload:string};
    const frozen=JSON.parse(row.prepared_payload);
    assert.equal(frozen.files.find((file:{name:string;path:string})=>file.name==='parent'&&file.path==='scripts/run.sh').content,
      '#!/bin/sh\necho parent\n');
    assert.deepEqual(frozen.selected,['parent']);
    assert.equal(JSON.parse(row.payload).body.text,op.body.text);
    assert.equal(row.prepared_payload.includes(op.body.text),false);
  } finally {await links.close();store.database.close();f.close();}
});

test('an older target receives plain work but keeps tagged work with a clear update error', async () => {
  const f=fixture(),store=new Store(join(f.dir,'legacy-gateway.db'));
  const links=new WorkspaceLinks(store,f.source);
  let operations=0;
  const old=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/identity')return res.end(JSON.stringify({version:1,workspace_id:'legacy-target'}));
    if(req.url==='/v1/skills/manifest'){res.statusCode=404;return res.end('{}');}
    if(req.url==='/v1/operation'){operations++;res.statusCode=201;return res.end(JSON.stringify({id:'accepted'}));}
    res.statusCode=404;res.end('{}');
  });
  const listen=(server:Server)=>new Promise<string>((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    });
  });
  try {
    const url=await listen(old);
    const link=await links.attach({name:'old',url,token:'a'.repeat(43)});
    const tagged={id:randomUUID(),method:'POST',path:'/compose',body:{text:'#parent run'}};
    links.enqueue(link.id,tagged);await links.flush(link.id);
    const blocked=store.database.prepare('SELECT status,result,payload FROM workspace_delivery WHERE id=?').get(tagged.id) as
      {status:number;result:string;payload:string};
    assert.equal(blocked.status,409);
    assert.match(JSON.parse(blocked.result).error,/업데이트/);
    assert.equal(JSON.parse(blocked.payload).body.text,tagged.body.text);
    assert.equal(operations,0);
    const plain={id:randomUUID(),method:'POST',path:'/compose',body:{text:'plain work'}};
    links.enqueue(link.id,plain);await links.flush(link.id);
    assert.equal((store.database.prepare('SELECT status FROM workspace_delivery WHERE id=?').get(plain.id) as {status:number}).status,201);
    assert.equal(operations,1);
  } finally {
    await links.close();store.database.close();
    old.closeAllConnections();await new Promise<void>(resolve=>old.close(()=>resolve()));f.close();
  }
});

test('an existing shared runner receives the local Hub skill before its tagged task starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-skill-shared-'));
  const project = join(dir, 'project'); mkdirSync(project);
  const sourceSkills = new SkillStore(join(dir, 'local-skills'));
  sourceSkills.create('parent');
  sourceSkills.writeFile('parent', 'SKILL.md', '---\nname: parent\ndescription: Parent\n---\nUse #child when needed.\n');
  sourceSkills.create('child');
  sourceSkills.writeFile('child', 'SKILL.md', '---\nname: child\ndescription: Child\n---\nBe concise.\n');
  const starts: StartOptions[] = [];
  const runtime = new SharedRuntime(join(dir, 'remote'), 'shared@worker', { start: options => {
    starts.push(options);
    options.emit({ type: 'engine_session', sessionId: options.sessionId, engineSessionId: 'fake-engine' });
    options.emit({ type: 'busy', sessionId: options.sessionId, busy: true });
    return { send: () => {}, resolveApproval: () => {}, interrupt: async () => {},
      setMode: async () => {}, setModel: async () => {}, close: () => {} };
  } });
  const received:Record<string,unknown>[]=[];
  const execute=runtime.workspace.execute.bind(runtime.workspace);
  runtime.workspace.execute=(peer,input)=>{received.push(input as Record<string,unknown>);return execute(peer,input);};
  const targetServer = runtime.workspace.server();
  const gatewayStore = new Store(join(dir, 'gateway.db'));
  const links = new WorkspaceLinks(gatewayStore, sourceSkills);
  const listen = (server: Server) => new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject);
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`); });
  });
  try {
    const url = await listen(targetServer), grant = runtime.workspace.grant('existing-hub'), token=grant.token;
    const link = await links.attach({ name: 'existing shared', url, token });
    await links.syncSkills(link.id);
    assert.equal(peerSkillManifest(runtime.hub.store.database,runtime.hub.skills,grant.id).parent,
      collectSkillVersion(sourceSkills,'parent').hashes.parent);
    const pinned=collectSkillBundle(sourceSkills,'#parent')!;
    const cache=join(runtime.hub.skills.home,'.skill-sync','peers',createHash('sha256').update(grant.id).digest('hex').slice(0,32),
      'parent',pinned.hashes.parent);
    rmSync(cache,{recursive:true,force:true});
    const op = { id: randomUUID(), method: 'POST', path: '/compose',
      body: { text: `@demo:shared@worker:${project} #parent #claude 해 주세요` } };
    links.enqueue(link.id, op);
    await links.flush(link.id);
    const row = gatewayStore.database.prepare('SELECT status,payload,prepared_payload,digest FROM workspace_delivery WHERE id=?')
      .get(op.id) as { status: number; payload: string; prepared_payload: string | null; digest: string };
    assert.equal(row.status, 201);
    assert.ok(received.length>=1);
    assert.equal(received.length,2,'missing cache requires one prepare and a retry of the same operation');
    assert.equal(received[0].id,received[1].id);
    assert.ok((received[0].body as Record<string,unknown>).__desk_skill_ref);
    assert.equal((received[0].body as Record<string,unknown>).__desk_skill_bundle,undefined);
    assert.equal(row.prepared_payload, null);
    assert.equal(JSON.parse(row.payload).body, undefined, 'confirmed payload no longer stores the prompt or bundle');
    assert.deepEqual(runtime.hub.skills.names(), [], 'peer files do not pollute the target hub global skills');
    assert.equal(restoreSkillBundle(runtime.hub.skills,grant.id,collectSkillBundle(sourceSkills,'#parent')!)?.selected[0],'parent');
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 3000;
      const check = () => { if (starts.length) resolve();
        else if (Date.now() > until) reject(Error('runner did not start')); else setTimeout(check, 20); };
      check();
    });
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].skills, ['parent']);
    assert.equal(runtime.hub.store.listTasks().length, 1);
    assert.equal(gatewayStore.listTasks().length, 0);
    assert.equal(runtime.workspace.execute(grant.id,received[0]).status,201,'lost ACK replays the receipt');
    assert.equal(runtime.hub.store.listTasks().length,1,'a receipt replay cannot start a second task');
    sourceSkills.writeFile('parent','SKILL.md','---\nname: parent\ndescription: Updated\n---\nNew instructions.\n');
    await links.syncSkills(link.id,true);
    assert.equal(peerSkillManifest(runtime.hub.store.database,runtime.hub.skills,grant.id).parent,
      collectSkillVersion(sourceSkills,'parent').hashes.parent);
    assert.equal(restoreSkillBundle(runtime.hub.skills,grant.id,pinned)?.digest,pinned.digest,
      'the old operation keeps its original bytes after a direct source edit');
  } finally {
    await links.close(); gatewayStore.database.close();
    targetServer.closeAllConnections(); await new Promise<void>(resolve => targetServer.close(() => resolve()));
    runtime.close(); rmSync(dir, { recursive: true, force: true });
  }
});
