import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import { UpdateService } from '../../hub/src/update-service.ts';
import { writePrivateJson, type UpdateApproval, type UpdateConfig, type UpdateState } from '../../hub/src/updater.ts';
import type { RuntimeStatus } from '../../hub/src/runtime-control.ts';
import { Access } from '../../hub/src/access.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { createHttpServer } from '../../hub/src/http.ts';

const old = 'a'.repeat(40), next = 'b'.repeat(40);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'desk-update-ui-'));
  const configPath = join(dir, 'update.json');
  const config: UpdateConfig = { version: 1, enabled: true, source: 'https://invalid.example/private-repo', ref: 'main',
    deploymentDir: join(dir, 'deployment'), dataDir: join(dir, 'data'), roles: ['hub'], environment: { AGENT_DESK_TOKEN_FILE: join(dir, 'SECRET_TOKEN_FILE') }, intervalMs: 1000 };
  writePrivateJson(configPath, config);
  const state: UpdateState = { phase: 'waiting', candidate: next };
  let managed = true, checks = 0, launches = 0, observations = 0, discoveries = 0;
  const runtime: RuntimeStatus = { version: 1, role: 'hub', commit: old, pid: process.pid, owner: 'secret-owner', instance: 'secret-instance', ready: true, reasons: [], prepared: false };
  const worker = { state: () => ({ ...state }), status: async () => { observations++; return [{ role: 'hub' as const, runtime: managed ? runtime : undefined }]; },
    approve: (commit: string, mode: UpdateApproval['mode']) => {
      if (state.approval || state.candidate !== commit) throw Error('private rejection /secret/path');
      return state.approval = { commit, mode, token: 'secret-token' };
    },
    cancelApproval: (commit?: string, token?: string) => {
      if (!state.approval || commit && state.approval.commit !== commit || token && state.approval.token !== token) return false;
      delete state.approval; return true;
    } };
  const options = { configPath, current: old, worker: () => worker, runCheck: async () => { checks++; },
    launchApproval: async () => { launches++; }, discover: async () => { discoveries++; return next; } };
  const service = new UpdateService(options);
  return { dir, config, configPath, state, worker, service, options, setManaged: (value: boolean) => { managed = value; },
    counts: () => ({ checks, launches, observations, discoveries }), close: () => { service.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('update view reports missing/unsafe config without exposing paths, environment or identities', async () => {
  const f = fixture();
  try {
    const absent = new UpdateService({ configPath: join(f.dir, 'absent'), current: null });
    assert.equal((await absent.view()).phase, 'not-configured');
    await assert.rejects(absent.check(), /업데이트 설정/);
    const result = await f.service.view();
    assert.equal(result.current, old); assert.equal(result.canApply, true); assert.equal(result.phase, 'ready'); assert.deepEqual(result.targets, ['hub']);
    const encoded = JSON.stringify(result);
    for (const privateValue of [f.dir, 'SECRET_TOKEN_FILE', 'secret-owner', 'secret-instance', 'secret-token', f.config.source]) assert.equal(encoded.includes(privateValue), false);
    f.state.error = 'prepare failed under /private/path';
    const refused = await f.service.view();
    assert.equal(refused.phase, 'failed');
    assert.doesNotMatch(JSON.stringify(refused), /\/private\/path/);
    f.state.error = '작업이 유휴 상태가 아닙니다';
    assert.equal((await f.service.view()).phase, 'waiting');
    writeFileSync(f.configPath, '{"environment":"secret-value"}', { mode: 0o600 });
    const unsafe = await f.service.view();
    assert.equal(unsafe.phase, 'failed'); assert.equal(JSON.stringify(unsafe).includes('secret-value'), false);
  } finally { f.close(); }
});

test('polling only discovers versions, coalesces status and never prepares or applies', async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 8 }, () => f.service.view()));
    await tick();
    assert.equal((await f.service.view()).latest, next);
    assert.deepEqual(f.counts(), { checks: 0, launches: 0, observations: 1, discoveries: 1 });
    assert.equal(f.state.approval, undefined);
  } finally { f.close(); }
});

test('check returns while preparation runs, deduplicates concurrent requests and sanitizes failure', async () => {
  const f = fixture();
  let reject!: (error: Error) => void, calls = 0;
  const service = new UpdateService({ ...f.options, runCheck: () => { calls++; return new Promise<void>((_, fail) => { reject = fail; }); } });
  try {
    const views = await Promise.all([service.check(), service.check(), service.check()]);
    assert.equal(calls, 1); assert.ok(views.every(view => view.checking));
    await assert.rejects(service.approve(next, 'immediate'), /검증하는 중/);
    reject(new Error('stderr password=SECRET /private/path')); await tick();
    const failed = await service.view();
    assert.equal(failed.checking, false); assert.match(failed.error!, /준비하지 못했습니다/);
    assert.equal(JSON.stringify(failed).includes('SECRET'), false);
  } finally { service.close(); f.close(); }
});

test('unmanaged and stale approvals are refused, exact approvals persist before detached launch', async () => {
  const f = fixture();
  try {
    f.setManaged(false);
    assert.match((await f.service.view()).reason!, /수동 서비스/);
    await assert.rejects(f.service.approve(next, 'immediate'), /수동 서비스/);
    assert.equal(f.counts().launches, 0);
    const managed = new UpdateService({ ...f.options, launchApproval: async (_path, token) => {
      assert.equal(f.state.approval?.commit, next);
      assert.equal(token, f.state.approval?.token);
    } });
    f.setManaged(true);
    await assert.rejects(managed.approve(old, 'when-idle'), /바뀌었습니다/);
    await assert.rejects(managed.approve(next.slice(0, 8), 'when-idle'), /40자리/);
    const accepted = await managed.approve(next, 'when-idle');
    assert.deepEqual(accepted.approval, { commit: next, mode: 'when-idle' });
    assert.equal(JSON.stringify(accepted).includes('secret-token'), false);
    await assert.rejects(managed.cancel(old), /대기 중인 승인/);
    assert.equal((await managed.cancel(next)).approval, null);
    managed.close();
  } finally { f.close(); }
});

test('launch failure revokes only the approval token created by that request', async () => {
  const f = fixture();
  const service = new UpdateService({ ...f.options, launchApproval: async () => { throw Error('/secret executable'); } });
  try {
    await assert.rejects(service.approve(next, 'immediate'), /시작하지 못했습니다/);
    assert.equal(f.state.approval, undefined);
    const replaced = new UpdateService({ ...f.options, launchApproval: async () => {
      f.state.approval = { commit: next, mode: 'when-idle', token: 'another-approval' }; throw Error('failed');
    } });
    await assert.rejects(replaced.approve(next, 'immediate'));
    assert.equal(f.worker.state().approval?.token, 'another-approval'); replaced.close();
  } finally { service.close(); f.close(); }
});

test('local Git discovery and summary distinguish new remote SHA from prepared candidate', async () => {
  const f = fixture(), source = join(f.dir, 'source'); mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('-C', source, 'init', '-b', 'main'); git('-C', source, 'config', 'user.name', 'Fixture'); git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(source, 'shared')); writeFileSync(join(source, 'shared/api.ts'), 'old'); git('-C', source, 'add', '.'); git('-C', source, 'commit', '-m', 'old'); const first = git('-C', source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'shared/api.ts'), 'new'); git('-C', source, 'add', '.'); git('-C', source, 'commit', '-m', 'shared change'); const second = git('-C', source, 'rev-parse', 'HEAD');
    mkdirSync(f.config.deploymentDir); git('clone', '--mirror', source, join(f.config.deploymentDir, 'repository.git'));
    writePrivateJson(f.configPath, { ...f.config, source }); f.state.candidate = second;
    const service = new UpdateService({ ...f.options, current: first, discover: undefined });
    let view = await service.view();
    for (let attempt = 0; !view.latest && attempt < 100; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); view = await service.view(); }
    assert.equal(view.latest, second); assert.equal(view.available, second);
    assert.deepEqual(view.summary, { commits: [{ sha: second, subject: 'shared change' }], files: 1, hub: true, runner: true });
    service.close();
  } finally { f.close(); }
});

test('HTTP update mutations require local ownership and same origin; authenticated devices may read status', async () => {
  const f = fixture(), store = new Store(':memory:');
  const hub = new Hub(store, { skills: new SkillStore(join(f.dir, 'skills')),
    runner: () => ({ connected: false, id: null, engines: new Set(), has: () => false, handle: () => { throw Error('unexpected runner'); } }) });
  const access = new Access(join(f.dir, 'access-token'), 4317, undefined, ['remote.example']);
  const server = createHttpServer(hub, access, join(f.dir, 'uploads'), { updates: f.service });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const status = await fetch(origin + '/api/updates');
    assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
    const cross = await fetch(origin + '/api/updates/check', { method: 'POST', headers: { origin: 'https://attacker.example' } });
    assert.equal(cross.status, 403);
    const remote = (path: string, method: string) => new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin + path, { method, headers: { host: 'remote.example', authorization: `Bearer ${access.token}` } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    assert.equal(await remote('/api/updates', 'GET'), 200);
    for (const action of ['check', 'approve', 'cancel']) assert.equal(await remote(`/api/updates/${action}`, 'POST'), 403);
    assert.equal(f.counts().checks, 0); assert.equal(f.counts().launches, 0);
    const accepted = await fetch(origin + '/api/updates/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commit: next, mode: 'when-idle' }) });
    assert.equal(accepted.status, 202); assert.equal((await accepted.json()).approval.commit, next);
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    hub.remotes.close(); store.database.close(); f.close();
  }
});
