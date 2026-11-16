import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../hub/src/hub.ts';
import { Store } from '../../hub/src/db.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { DocumentPermissionError, workspaceFile } from '../../hub/src/shared-files.ts';
import { DocumentPreviews } from '../../hub/src/document-previews.ts';

// Put every fixture in the system temp directory, then narrow the tested temporary-file allowance.
test('outside document approval matches one canonical file and never grants its neighbors or redirected target', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'desk-document-permission-')));
  const project = join(dir, 'project'), temporary = join(dir, 'temporary'), outside = join(dir, 'outside');
  const oldTemp = process.env.TMPDIR;
  t.after(async () => { if (oldTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemp; await rm(dir, {recursive: true, force: true}); });
  await Promise.all([mkdir(project), mkdir(temporary), mkdir(outside)]);
  process.env.TMPDIR = temporary;
  const hub = {cwdOf: (task: string) => task === 'task' ? project : undefined} as unknown as Hub;
  const first = join(outside, 'first.html'), second = join(outside, 'second.md'), secret = join(outside, 'secret.txt');
  await Promise.all([writeFile(first, '<h1>first</h1>'), writeFile(second, '# second'), writeFile(secret, 'fixture only')]);
  const alias = join(project, 'link.html'); await symlink(first, alias);
  const permission = (path: string) => (error: unknown) => error instanceof DocumentPermissionError && error.status === 403 && error.code === 'document_permission_required' && error.path === path;
  await assert.rejects(workspaceFile(hub, 'task', alias), permission(first));
  const ready = await workspaceFile(hub, 'task', alias, undefined, first);
  try { assert.equal(await ready.file.readFile('utf8'), '<h1>first</h1>'); } finally { await ready.file.close(); }
  await assert.rejects(workspaceFile(hub, 'missing-task', alias, undefined, first), {status: 404});
  await assert.rejects(workspaceFile(hub, 'task', second, undefined, first), permission(second));
  await assert.rejects(workspaceFile(hub, 'task', first, undefined, outside), permission(first));
  await assert.rejects(workspaceFile(hub, 'task', first, alias, first), /부속 파일/);
  await assert.rejects(workspaceFile(hub, 'task', secret, undefined, secret), error => !(error instanceof DocumentPermissionError) && (error as {status: number}).status === 403);
  await unlink(alias); await symlink(second, alias);
  await assert.rejects(workspaceFile(hub, 'task', alias, undefined, first), permission(second));
  const changed = await workspaceFile(hub, 'task', alias, undefined, second);
  try { assert.equal(await changed.file.readFile('utf8'), '# second'); } finally { await changed.file.close(); }
  await unlink(alias); await symlink(secret, alias);
  await assert.rejects(workspaceFile(hub, 'task', alias), error => !(error instanceof DocumentPermissionError) && (error as {status: number}).status === 403);
});

test('approved preview cache stays separate, revalidates each prepare and blocks all relative assets', async () => {
  let canonical = '/outside/report.html';
  const calls: {source: string; task: string; approved: string | undefined}[] = [];
  const cache = new DocumentPreviews(async (source, task, _href, _base, receive, approved) => {
    calls.push({source, task, approved});
    if (approved !== canonical) throw new DocumentPermissionError(canonical);
    return receive(new Response('ok', {headers: {'content-length': '2', 'x-desk-filename': 'report.html'}}));
  });
  const open = (source = 'runner-a', task = 'task-a', approved?: string) => cache.prepare(source, task, '/project/link.html', false, () => true, approved);
  try {
    await assert.rejects(open(), DocumentPermissionError);
    const approved = await open('runner-a', 'task-a', canonical);
    await assert.rejects(open(), DocumentPermissionError);
    await assert.rejects(open('runner-b'), DocumentPermissionError);
    await assert.rejects(open('runner-a', 'task-b'), DocumentPermissionError);
    const before = calls.length;
    await assert.rejects(cache.serve(approved.url.split('/')[2], 'style.css', {} as ServerResponse, 'http://localhost'), /부속 파일/);
    await assert.rejects(cache.serve(approved.url.split('/')[2], 'neighbor.html', {} as ServerResponse, 'http://localhost'), /부속 파일/);
    assert.equal(calls.length, before, 'assets must be rejected before any source read');
    canonical = '/outside/changed.html';
    await assert.rejects(open('runner-a', 'task-a', '/outside/report.html'), error => error instanceof DocumentPermissionError && error.path === canonical);
    const replacement = await open('runner-a', 'task-a', canonical); assert.equal(replacement.kind, 'html');
    await assert.rejects(open('runner-a', 'task-a', '../relative.html'), {status: 400});
  } finally { await cache.close(); }
});

const listen = (server: Server) => new Promise<string>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as {port: number}).port}`)); });
const stop = (server: Server) => new Promise<void>(resolve => {server.closeAllConnections(); server.close(() => resolve());});

test('local and remote HTTP previews require explicit canonical approval and keep ordinary downloads restricted', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'desk-document-http-')));
  const project = join(dir, 'project'), temporary = join(dir, 'temporary'), outside = join(dir, 'outside');
  await Promise.all([mkdir(project), mkdir(temporary), mkdir(outside)]);
  const oldTemp = process.env.TMPDIR; process.env.TMPDIR = temporary;
  t.after(async () => {if (oldTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemp; await rm(dir, {recursive: true, force: true});});
  const make = (name: string) => {
    const store = new Store(join(dir, name, 'desk.db'));
    const hub = new Hub(store, {skills: new SkillStore(join(dir, name, 'skills')), runner: () => ({connected: true, id: 'fixture', engines: new Set(['claude']), has: () => true, handle: () => {}})});
    return {store, hub, task: hub.compose(`@document:${project} #claude fixture`)};
  };
  const local = make('local'), remote = make('remote');
  const authority = new SharedWorkspace(remote.hub), peer = authority.grant('preview'), runner = authority.server();
  const links = new WorkspaceLinks(local.store);
  const gateway = createHttpServer(local.hub, new Access(join(dir, 'access-token'), 4317), join(dir, 'uploads'), {workspaces: links});
  try {
    const runnerUrl = await listen(runner), url = await listen(gateway);
    const source = await links.attach({name: 'fixture', url: runnerUrl, token: peer.token});
    const headers = {authorization: `Bearer ${peer.token}`, 'x-workspace-id': authority.id};
    const identity = await fetch(runnerUrl + '/v1/identity', {headers}).then(r => r.json()) as any;
    assert.equal(identity.capabilities.file_permission, 1);
    const first = join(outside, 'first.html'), second = join(outside, 'second.html'), alias = join(project, 'report.html');
    await Promise.all([writeFile(first, '<h1>first fixture</h1>'), writeFile(second, '<h1>second fixture</h1>'), writeFile(join(outside, 'style.css'), 'h1{}')]);
    const post = async (input: Record<string, unknown>) => {
      const response = await fetch(url + '/api/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input)});
      return {status: response.status, body: await response.json() as any};
    };
    for (const [owner, task] of [['', local.task.id], [source.id, remote.task.id]]) {
      await unlink(alias).catch(() => {}); await symlink(first, alias);
      const input = {source: owner, task_id: task, href: alias};
      const denied = await post(input); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'document_permission_required'); assert.equal(denied.body.path, first);
      for (const approved_path of ['relative.html', '/bad\0path.html', '/' + 'a'.repeat(4096), null]) assert.equal((await post({...input, approved_path})).status, 400);
      const allowed = await post({...input, approved_path: first}); assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      assert.equal(await fetch(url + allowed.body.url).then(r => r.text()), '<html><head></head><body><h1>first fixture</h1></body></html>');
      assert.equal((await fetch(url + allowed.body.url.replace(/[^/]*$/, 'style.css'))).status, 403);
      assert.equal((await post(input)).status, 403, 'an approved cache must not satisfy an unapproved request');
      await unlink(alias); await symlink(second, alias);
      const changed = await post({...input, approved_path: first}); assert.equal(changed.status, 403); assert.equal(changed.body.path, second);
      const replacement = await post({...input, approved_path: second}); assert.equal(replacement.status, 200);
      assert.equal(await fetch(url + replacement.body.url).then(r => r.text()), '<html><head></head><body><h1>second fixture</h1></body></html>');
    }
    await assert.rejects(links.fetchFile(source.id, remote.task.id, alias), {status: 403});
    const invalid = await fetch(runnerUrl + '/v1/file?' + new URLSearchParams({task_id: remote.task.id, href: alias, approved_path: 'relative.html'}), {headers});
    assert.equal(invalid.status, 400);
    const asset = await fetch(runnerUrl + '/v1/file?' + new URLSearchParams({task_id: remote.task.id, href: alias, base: alias, approved_path: second}), {headers});
    assert.equal(asset.status, 403);
  } finally {
    await stop(gateway); await links.close(); await stop(runner);
    local.hub.dispose(); local.store.database.close(); remote.hub.dispose(); remote.store.database.close();
  }
});

test('remote permission responses stay bounded and old runners cannot receive approval overrides', async () => {
  const store = new Store(':memory:'), links = new WorkspaceLinks(store);
  let capability = false, mode = 'typed', fileCalls = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/identity') return res.end(JSON.stringify({version: 1, workspace_id: 'fixture', capabilities: {file_preview: 1, ...(capability ? {file_permission: 1} : {})}}));
    fileCalls++; res.statusCode = 403;
    res.end(mode === 'oversized' ? JSON.stringify({code: 'document_permission_required', path: '/outside/report.html', padding: 'x'.repeat(20 * 1024)})
      : mode === 'relative' ? JSON.stringify({code: 'document_permission_required', path: '../secret.html'})
      : mode === 'malformed' ? '{invalid-json'
      : mode === 'generic' ? JSON.stringify({error: 'private-runner-details'})
      : JSON.stringify({code: 'document_permission_required', path: '/outside/report.html', error: 'private-runner-details'}));
  });
  try {
    const url = await listen(server), source = await links.attach({name: 'fake', url, token: 'a'.repeat(32)});
    await assert.rejects(links.previewFile(source.id, 'task', 'report.html', undefined, async () => '', '/outside/report.html'), /러너를 업데이트/);
    assert.equal(fileCalls, 0);
    capability = true;
    await assert.rejects(links.previewFile(source.id, 'task', 'report.html', undefined, async () => ''), error => error instanceof DocumentPermissionError && error.path === '/outside/report.html' && !error.message.includes('private-runner-details'));
    for (mode of ['oversized', 'relative', 'malformed', 'generic']) {
      await assert.rejects(links.previewFile(source.id, 'task', 'report.html', undefined, async () => ''), error => !(error instanceof DocumentPermissionError) && (error as {status: number}).status === 403 && !(error as Error).message.includes('private-runner-details'));
    }
  } finally {await links.close(); await stop(server); store.database.close();}
});
