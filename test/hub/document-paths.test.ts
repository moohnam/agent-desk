import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Hub } from '../../hub/src/hub.ts';
import { Store } from '../../hub/src/db.ts';
import { filePath } from '../../hub/src/open.ts';
import { workspaceDocumentPath, workspaceFile, DocumentPermissionError } from '../../hub/src/shared-files.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + (server.address() as {port:number}).port)));
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test('source path normalization removes line references, resolves bases, and rejects other file hosts and URL schemes', () => {
  assert.equal(filePath('../report.md:12:3', '/work/docs'), '/work/report.md');
  assert.equal(filePath('file:///work/%ED%95%9C%20%EA%B8%80.md#L3-L5', undefined), '/work/한 글.md');
  assert.equal(filePath('file:///work/literal%2520.md', undefined), '/work/literal%20.md', 'decode exactly once');
  assert.equal(filePath('~/report.md#L2', '/ignored'), join(homedir(), 'report.md'));
  assert.throws(() => filePath('relative.md', undefined), /기준 폴더/);
  for (const href of ['https://example.com/report.md', 'ssh:host:/report.md', 'file://other-host/work/report.md'])
    assert.throws(() => filePath(href, '/work'), {status:400});
});

test('metadata resolves the source real path within existing document permissions without a size or content read', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'desk-document-path-'))), oldTemp = process.env.TMPDIR;
  const project = join(dir, 'project'), temporary = join(dir, 'temp'), outside = join(dir, 'outside');
  await Promise.all([mkdir(project), mkdir(temporary), mkdir(outside)]); process.env.TMPDIR = temporary;
  t.after(async () => { if (oldTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemp; await rm(dir,{recursive:true,force:true}); });
  const source = join(project, '원본 문서.md'), external = join(outside, 'external.html');
  await Promise.all([writeFile(source, '# original'), writeFile(external, '<h1>outside</h1>'), mkdir(join(project,'directory.md'))]);
  await symlink(source, join(project, 'alias.md'));
  const hub = {store:{getTask:(id:string)=>id==='idle-task'?{project_id:'project'}:undefined,
    getProject:()=>({root_path:'user@runner:'+project})},cwdOf:(task:string)=>task === 'remote-task' ? 'user@runner:' + project : undefined} as unknown as Hub;
  assert.equal(await workspaceDocumentPath(hub,'remote-task','alias.md:12'), source);
  await assert.rejects(workspaceDocumentPath(hub,'idle-task','alias.md:50'),{status:409});
  assert.equal(await workspaceDocumentPath(hub,'idle-task','alias.md:50',undefined,true),source);
  await assert.rejects(workspaceFile(hub,'idle-task',source,join(project,'directory.md'),undefined,true),{status:403});
  await assert.rejects(workspaceDocumentPath(hub,'idle-task',external,undefined,true),DocumentPermissionError);
  assert.equal(await workspaceDocumentPath(hub,'idle-task',external,external,true),external);
  assert.equal(await workspaceDocumentPath(hub,'remote-task',new URL('file://' + source).href), source);
  await assert.rejects(workspaceDocumentPath(hub,'missing-task','alias.md'), {status:404});
  await assert.rejects(workspaceDocumentPath(hub,'remote-task',external), DocumentPermissionError);
  assert.equal(await workspaceDocumentPath(hub,'remote-task',external,external), external);
  await assert.rejects(workspaceDocumentPath(hub,'remote-task',source,external), DocumentPermissionError);
  await assert.rejects(workspaceDocumentPath(hub,'remote-task','directory.md'), /일반 파일/);
  for (const href of ['missing.pdf','image.png','code.ts','https://example.com/report.md'])
    await assert.rejects(workspaceDocumentPath(hub,'remote-task',href), {status:400});
});

test('old runners never receive path requests and metadata reads do not enter the operation outbox', async () => {
  let supported = false, pathRequests = 0;
  const server = createServer((req,res) => {
    res.setHeader('content-type','application/json');
    if (req.url === '/v1/identity') return res.end(JSON.stringify({version:1,workspace_id:'workspace',capabilities:supported ? {file_path:1} : {}}));
    if (req.url?.startsWith('/v1/file-path?')) { pathRequests++; return res.end(JSON.stringify({path:'/remote/original.md'})); }
    res.statusCode = 404; res.end('{}');
  });
  const store = new Store(':memory:'), links = new WorkspaceLinks(store);
  try {
    const link = await links.attach({name:'remote',url:await listen(server),token:'x'.repeat(43)});
    await assert.rejects(links.documentPath(link.id,'task','relative.md'), /러너를 업데이트/);
    assert.equal(pathRequests,0); supported = true;
    assert.equal(await links.documentPath(link.id,'task','relative.md'), '/remote/original.md');
    assert.equal(pathRequests,1);
    assert.equal((store.database.prepare('SELECT count(*) n FROM workspace_delivery').get() as {n:number}).n,0);
  } finally { await links.close(); await stop(server); store.database.close(); }
});
