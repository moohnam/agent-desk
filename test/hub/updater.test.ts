import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest, hubBlockers, registerRuntimeControl, requireAdmission, sessionBlockers } from '../../hub/src/runtime-control.ts';
import { Hub } from '../../hub/src/hub.ts';
import { assertTrustedPath, assertTrustedTree } from '../../hub/src/trusted-path.ts';
import { Store } from '../../hub/src/db.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { ConnectorAuthority } from '../../hub/src/connector-authority.ts';
import { ConnectorBroker } from '../../hub/src/connector-broker.ts';
import type { Connectors } from '../../hub/src/connectors.ts';
import type { HubToRunner, RunnerToHub } from '../../shared/protocol.ts';
import { readUpdateConfig, UpdateWorker, validateUpdateConfig, writePrivateJson, type UpdateConfig } from '../../hub/src/updater.ts';

test('maintenance control refuses busy work, checks ownership, blocks admission and expires abandoned leases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-control-')), socket = join(dir, 'ctl.sock');
  let busy = true, stopped = false;
  const server = await registerRuntimeControl({ role: 'shared', socket, commit: 'a'.repeat(40), leaseMs: 150,
    ready: () => true, blockers: () => busy ? ['실행 중인 턴'] : [], stop: () => { stopped = true; } });
  try {
    const state = (await controlRequest(socket, { action: 'status' })).status;
    assert.equal((await controlRequest(socket, { action: 'prepare', instance: state.instance })).ok, false);
    busy = false;
    assert.equal((await controlRequest(socket, { action: 'prepare', instance: 'wrong' })).ok, false);
    const prepared = await controlRequest(socket, { action: 'prepare', instance: state.instance });
    assert.equal(prepared.ok, true); assert.throws(requireAdmission, /업데이트/);
    assert.equal((await controlRequest(socket, { action: 'stop', instance: state.instance, lease: 'wrong' })).ok, false);
    await delay(180); assert.doesNotThrow(requireAdmission);
    assert.equal((await controlRequest(socket, { action: 'stop', instance: state.instance, lease: prepared.lease })).ok, false);
    assert.equal(stopped, false);
    const second = await controlRequest(socket, { action: 'prepare', instance: state.instance });
    busy = true;
    assert.equal((await controlRequest(socket, { action: 'stop', instance: state.instance, lease: second.lease })).ok, false);
    await controlRequest(socket, { action: 'cancel', instance: state.instance, lease: second.lease });
    assert.doesNotThrow(requireAdmission);
    assert.deepEqual(sessionBlockers([{ sessionId: 's', busy: false, approvals: [], background: [{ id: 'b', type: 'agent', description: 'running' }] }]), ['백그라운드 작업']);
  } finally { await new Promise<void>(resolve => server!.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('isolated Git releases build before idle replacement and preserve data across worker and runtime restarts', { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-update-')), source = join(dir, 'source'), data = join(dir, 'data'), deploy = join(dir, 'deploy');
  mkdirSync(join(source, 'hub/src/runner'), { recursive: true }); mkdirSync(data);
  copyFileSync(new URL('../../hub/src/runtime-control.ts', import.meta.url), join(source, 'hub/src/runtime-control.ts'));
  copyFileSync(new URL('../../hub/src/trusted-path.ts', import.meta.url), join(source, 'hub/src/trusted-path.ts'));
  copyFileSync(new URL('../../hub/src/errors.ts', import.meta.url), join(source, 'hub/src/errors.ts'));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const pkg = { name: 'update-fixture', version: '1.0.0', type: 'module', scripts: { typecheck: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } };
  writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }));
  const runtime = (version: string) => `import {registerRuntimeControl} from '../runtime-control.ts';
import {existsSync,appendFileSync} from 'node:fs'; import {dirname,join} from 'node:path';
const data=dirname(process.env.AGENT_DESK_DB); appendFileSync(join(data,'starts.txt'),${JSON.stringify(version)}+'\\n');
await registerRuntimeControl({role:'shared',ready:()=>true,blockers:()=>existsSync(join(data,'busy'))?['작업 중']:[],stop:()=>process.exit(0)});`;
  const commit = (version: string) => { writeFileSync(join(source, 'hub/src/runner/shared.ts'), runtime(version)); git('add', '.'); git('commit', '-m', version); return git('rev-parse', 'HEAD'); };
  const v1 = commit('one');
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const config: UpdateConfig = { version: 1, enabled: true, source, ref: 'main', deploymentDir: deploy, dataDir: data, roles: ['shared'], environment: { AGENT_DESK_SHARED_PORT: String(port) }, intervalMs: 1000 };
  writeFileSync(join(data, 'agent-desk.db'), '원본 DB 유지'); writeFileSync(join(data, 'instructions.md'), '사용자 지침 유지');
  let worker = new UpdateWorker(config); worker.claim();
  const apply = async (mode: 'immediate' | 'when-idle' = 'immediate') => { const commit = await worker.prepare(); worker.approve(commit, mode); return worker.cycle(); };
  try {
    assert.throws(() => new UpdateWorker(config).claim(), /이미/);
    await new Promise<void>(resolve => portProbe.listen(port, '127.0.0.1', resolve));
    await assert.rejects(apply(), /기존 프로세스/);
    assert.equal(existsSync(join(data, 'starts.txt')), false);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지');
    await new Promise<void>(resolve => portProbe.close(() => resolve()));
    assert.equal(await worker.cycle(), false); assert.equal(existsSync(join(data, 'starts.txt')), false, 'bootstrap requires explicit approval');
    assert.equal(await apply(), true); assert.equal(worker.state().current, v1);
    const first = (await worker.status())[0].runtime!;
    assert.equal(first.commit, v1); assert.equal(first.ready, true);
    await assert.rejects(new UpdateWorker({ ...config, deploymentDir: join(dir, 'other-deployment') }).status(), /소유자/);
    worker.close(); worker = new UpdateWorker(config); worker.claim();
    assert.equal(await worker.cycle(), false); assert.equal((await worker.status())[0].runtime!.pid, first.pid);
    writeFileSync(join(data, 'busy'), 'busy'); const v2 = commit('two');
    assert.equal(await apply(), false); assert.equal(worker.state().approval, undefined, 'apply now must not become a deferred approval');
    assert.equal(await worker.cycle(), false); assert.equal((await worker.status())[0].runtime!.pid, first.pid);
    assert.equal(await apply('when-idle'), false); assert.equal(worker.state().phase, 'waiting');
    assert.equal((await worker.status())[0].runtime!.pid, first.pid);
    assert.ok(existsSync(join(deploy, 'verified', v2 + '.json')));
    assert.equal(worker.cancelApproval(v1), false, 'an unrelated SHA cannot cancel the reviewed approval');
    const newer = commit('unapproved-three'); assert.equal(await worker.prepare(), newer);
    assert.equal(worker.state().approval?.commit, v2, 'new discoveries never replace the approved SHA');
    worker.close(); worker = new UpdateWorker(config); worker.claim();
    rmSync(join(data, 'busy')); assert.equal(await worker.cycle(), true);
    assert.equal(worker.state().current, v2); assert.notEqual((await worker.status())[0].runtime!.pid, first.pid);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지');
    assert.equal(readFileSync(join(data, 'instructions.md'), 'utf8'), '사용자 지침 유지');
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(worker.state().candidate, newer);
    pkg.scripts.build = 'node -e "process.exit(7)"'; writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    const bad = commit('bad-build'); await assert.rejects(worker.cycle());
    assert.equal((await worker.status())[0].runtime!.commit, v2); assert.equal(worker.state().current, v2);
    assert.equal(existsSync(join(deploy, 'verified', bad + '.json')), false);
    assert.equal(git('rev-parse', 'HEAD'), bad); assert.equal(git('status', '--porcelain'), '');
    // A candidate that changes data then fails startup must never trigger an old-binary/DB rollback.
    pkg.scripts.build = 'node -e "process.exit(0)"'; writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(source, 'hub/src/runner/shared.ts'), `import {appendFileSync} from 'node:fs';
appendFileSync(process.env.AGENT_DESK_DB,';forward-migration'); process.exit(17);`);
    git('add', '.'); git('commit', '-m', 'startup failure'); const broken = git('rev-parse', 'HEAD');
    await assert.rejects(apply(), /준비 전에 종료/);
    assert.equal(worker.state().phase, 'failed'); assert.equal(worker.state().candidate, broken);
    assert.equal(worker.state().approval, undefined, 'failed activation consumes its approval');
    assert.equal(await worker.cycle(), false, 'a failed SHA cannot restart without another explicit approval');
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지;forward-migration');
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\ntwo\n');
    const repaired = commit('four'); assert.equal(await apply(), true);
    assert.equal(worker.state().current, repaired);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지;forward-migration');
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\ntwo\nfour\n');
    // A failed candidate can remain alive with its control socket but never become ready.
    writeFileSync(join(source, 'hub/src/runner/shared.ts'), runtime('unready').replace('ready:()=>true', 'ready:()=>false'));
    git('add', '.'); git('commit', '-m', 'unready candidate'); const unready = git('rev-parse', 'HEAD');
    await assert.rejects(apply(), /준비 확인 시간이 초과/);
    const failed = (await worker.status())[0].runtime!;
    assert.equal(failed.ready, false); assert.equal(failed.commit, unready);
    assert.equal(worker.state().started?.shared?.instance, failed.instance);
    assert.equal((await controlRequest(worker.socket('shared'), {action:'prepare',instance:failed.instance})).ok, false);
    assert.equal((await controlRequest(worker.socket('shared'), {action:'prepare-failed-candidate',instance:failed.instance,owner:'wrong',commit:unready})).ok, false);
    assert.equal((await controlRequest(worker.socket('shared'), {action:'prepare-failed-candidate',instance:failed.instance,owner:failed.owner,commit:v1})).ok, false);
    // Ownership survives a supervisor restart; a non-idle candidate still cannot be cleaned up.
    worker.close(); worker = new UpdateWorker(config); worker.claim();
    writeFileSync(join(data, 'busy'), 'busy'); const next = commit('five');
    await assert.rejects(apply(), /미완료 작업/);
    assert.equal((await worker.status())[0].runtime!.instance, failed.instance);
    rmSync(join(data, 'busy')); assert.equal(await apply(), true);
    assert.equal(worker.state().current, next); assert.equal(worker.state().started, undefined);
    assert.notEqual((await worker.status())[0].runtime!.instance, failed.instance);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지;forward-migration');
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\ntwo\nfour\nunready\nfive\n');

  } finally {
    if (portProbe.listening) await new Promise<void>(resolve => portProbe.close(() => resolve()));
    try {
      const status = (await worker.status())[0].runtime;
      if (status) {
        const hold = await controlRequest(worker.socket('shared'), { action: 'prepare', instance: status.instance });
        if (hold.ok) await controlRequest(worker.socket('shared'), { action: 'stop', instance: status.instance, lease: hold.lease });
      }
      await delay(150);
    } finally { worker.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('real worker exits and crashes preserve detached runtimes, reclaim stale locks and recover forward after a failed start', {timeout: 90_000}, async () => {
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'desk-worker-process-'));
  const source = join(dir, 'source'), data = join(dir, 'data'), deploy = join(dir, 'deploy');
  mkdirSync(join(source, 'hub/src/runner'), {recursive: true}); mkdirSync(data);
  for (const name of ['runtime-control.ts', 'trusted-path.ts', 'errors.ts'])
    copyFileSync(new URL('../../hub/src/' + name, import.meta.url), join(source, 'hub/src', name));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const pkg = {name: 'worker-process-fixture', version: '1.0.0', type: 'module', scripts: {
    typecheck: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"',
  }};
  writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {'': {name: pkg.name, version: pkg.version}}}));
  const runtime = (version: string) => `import {registerRuntimeControl} from '../runtime-control.ts';
import {appendFileSync} from 'node:fs'; import {dirname,join} from 'node:path';
const data=dirname(process.env.AGENT_DESK_DB);
appendFileSync(join(data,'starts.jsonl'),JSON.stringify({version:${JSON.stringify(version)},environment:process.env.DESK_WORKER_PROCESS_TEST})+'\\n');
await registerRuntimeControl({role:'shared',ready:()=>true,blockers:()=>[],stop:()=>process.exit(0)});`;
  const commit = (text: string, message: string) => {
    writeFileSync(join(source, 'hub/src/runner/shared.ts'), text); git('add', '.'); git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const firstCommit = commit(runtime('first'), 'first');
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as {port: number}).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const config: UpdateConfig = {version: 1, enabled: true, source, ref: 'main', deploymentDir: deploy, dataDir: data,
    roles: ['shared'], environment: {AGENT_DESK_SHARED_PORT: String(port)}, intervalMs: 300_000};
  const configPath = join(dir, 'update.json'); writePrivateJson(configPath, config);
  writeFileSync(join(data, 'agent-desk.db'), 'original-data');
  const observer = new UpdateWorker(config), children: ChildProcess[] = [];
  const reports = new Map<ChildProcess, string>();
  let diagnostics = '';
  const launch = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../hub/src/update-cli.ts', import.meta.url)), 'run', configPath], {
      cwd: dir, env: {...process.env, DESK_WORKER_PROCESS_TEST: 'preserved'}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.on('error', error => { diagnostics += error.message; });
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
      diagnostics = (diagnostics + chunk).slice(-32_768);
      reports.set(child, ((reports.get(child) ?? '') + chunk).slice(-32_768));
    });
    return child;
  };
  const waitFor = async <T,>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const value = await read(); if (value) return value as NonNullable<T>;
      await delay(25);
    }
    throw new Error(label + '\n' + diagnostics);
  };
  const approveCommit = async (commit: string) => {
    await waitFor(() => observer.state().candidate === commit, 'candidate was not prepared');
    execFileSync(process.execPath, [fileURLToPath(new URL('../../hub/src/update-cli.ts', import.meta.url)), 'approve', configPath, commit, 'immediate'], {stdio: ['ignore', 'pipe', 'pipe']});
  };
  const active = async (commit: string) => {
    const state = observer.state();
    if (state.phase !== 'active' || state.current !== commit) return;
    const runtime = (await observer.status())[0].runtime;
    return runtime?.ready && runtime.commit === commit ? runtime : undefined;
  };
  const stopWorker = async (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'worker did not exit');
  };
  try {
    const firstWorker = launch();
    await approveCommit(firstCommit);
    const firstRuntime = await waitFor(() => active(firstCommit), 'first runtime did not become ready');
    await stopWorker(firstWorker, 'SIGTERM');
    assert.equal(firstWorker.exitCode, 0); assert.equal(existsSync(join(deploy, 'worker.lock')), false);
    assert.equal((await observer.status())[0].runtime?.pid, firstRuntime.pid, 'SIGTERM must leave the runtime alive');

    const secondWorker = launch();
    await waitFor(() => reports.get(secondWorker)?.includes('"activated":false') && existsSync(join(deploy, 'worker.lock'))
      && JSON.parse(readFileSync(join(deploy, 'worker.lock'), 'utf8')).pid === secondWorker.pid, 'replacement worker did not claim the deployment');
    assert.equal((await observer.status())[0].runtime?.instance, firstRuntime.instance);
    await stopWorker(secondWorker, 'SIGKILL');
    assert.equal(secondWorker.signalCode, 'SIGKILL'); assert.equal(existsSync(join(deploy, 'worker.lock')), true);
    assert.equal((await observer.status())[0].runtime?.pid, firstRuntime.pid, 'a worker crash must leave the runtime alive');

    const brokenCommit = commit(`import {appendFileSync} from 'node:fs';
appendFileSync(process.env.AGENT_DESK_DB,';forward-migration');process.exit(17);`, 'fails after forward migration');
    const thirdWorker = launch();
    await approveCommit(brokenCommit);
    await waitFor(() => {const state = observer.state(); return state.phase === 'failed' && state.candidate === brokenCommit;}, 'startup failure was not recorded');
    await stopWorker(thirdWorker, 'SIGTERM');
    assert.equal(thirdWorker.exitCode, 0);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), 'original-data;forward-migration');
    assert.equal((await observer.status())[0].runtime, undefined, 'the old binary must not restart after migration');

    const repairedCommit = commit(runtime('repaired'), 'forward repair');
    const fourthWorker = launch();
    await approveCommit(repairedCommit);
    const repairedRuntime = await waitFor(() => active(repairedCommit), 'restarted worker did not recover with the forward repair');
    await stopWorker(fourthWorker, 'SIGTERM');
    assert.equal(fourthWorker.exitCode, 0); assert.notEqual(repairedRuntime.pid, firstRuntime.pid);
    assert.equal((await observer.status())[0].runtime?.instance, repairedRuntime.instance);
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), 'original-data;forward-migration');
    const starts = readFileSync(join(data, 'starts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(starts, [{version: 'first', environment: 'preserved'}, {version: 'repaired', environment: 'preserved'}]);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stopWorker(child, 'SIGKILL');
    const runtime = (await observer.status())[0].runtime;
    if (runtime) {
      const hold = await controlRequest(observer.socket('shared'), {action: 'prepare', instance: runtime.instance});
      assert.equal(hold.ok, true);
      await controlRequest(observer.socket('shared'), {action: 'stop', instance: runtime.instance, lease: hold.lease});
      await waitFor(async () => {
        try {return !(await observer.status())[0].runtime;}
        catch (error) {
          // A connection accepted immediately before process exit can end without a status reply.
          if ((error as Error).message === '런타임 제어 응답이 끊겼습니다' || (error as NodeJS.ErrnoException).code === 'ECONNRESET') return false;
          throw error;
        }
      }, 'fixture runtime did not stop');
    }
    rmSync(dir, {recursive: true, force: true});
  }
});

test('update configuration requires opt-in and separates deploy code from stable data', () => {
  const config: UpdateConfig = { version: 1, enabled: true, source: '/source', ref: 'main', deploymentDir: '/deploy', dataDir: '/data', roles: ['shared'], environment: {}, intervalMs: 1000 };
  assert.throws(() => validateUpdateConfig({ ...config, enabled: false }));
  assert.throws(() => validateUpdateConfig({ ...config, dataDir: '/deploy/data' }), /분리/);
  assert.throws(() => validateUpdateConfig({ ...config, deploymentDir: '/source/releases' }), /분리/);
  assert.throws(() => validateUpdateConfig({ ...config, roles: ['daemon'] }), /함께/);
  assert.throws(() => validateUpdateConfig({ ...config, environment: { AGENT_DESK_DB: '/deploy/release/db' } }), /절대 경로/);
  assert.throws(() => validateUpdateConfig({ ...config, environment: { AGENT_DESK_UPLOADS: '/deploy/releases/uploads' } }), /절대 경로/);
  assert.throws(() => validateUpdateConfig({ ...config, environment: { AGENT_DESK_UPLOADS: 'uploads' } }), /절대 경로/);
  assert.equal(validateUpdateConfig({ ...config, environment: { AGENT_DESK_UPLOADS: '/data/uploads' } }).environment.AGENT_DESK_UPLOADS, '/data/uploads');
  assert.throws(() => validateUpdateConfig({ ...config, environment: { NODE_OPTIONS: '--inspect' } }), /지원하지/);
  assert.deepEqual(validateUpdateConfig(config).roles, ['shared']);
});


test('prepared runtime rejects handoff and cross-agent dispatch without recording or losing input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-update-admission-')), socket = join(dir, 'ctl.sock');
  const store = new Store(':memory:'), sent: HubToRunner[] = []; let receive!: (message: RunnerToHub) => void;
  const hub = new Hub(store, {skills: new SkillStore(join(dir, 'skills')), runner: onMessage => {
    receive = onMessage;
    return {connected: true, id: 'fixture', engines: new Set(['claude']), has: () => true, handle: command => {sent.push(command);}};
  }});
  const from = hub.compose(`@from:${dir} #claude origin`), target = hub.compose(`@target:${dir} #claude target`);
  const originSession = store.latestSession(from.id)!, targetSession = store.latestSession(target.id)!;
  receive({type: 'busy', sessionId: originSession.id, busy: false}); receive({type: 'busy', sessionId: targetSession.id, busy: false});
  const authority = new ConnectorAuthority(store.database, {connections: () => []} as unknown as Connectors);
  const broker = new ConnectorBroker(store.database, 'fixture');
  const server = await registerRuntimeControl({role: 'hub', socket, commit: 'a'.repeat(40), ready: () => true, blockers: () => hubBlockers(hub), stop: () => {}});
  const status = (await controlRequest(socket, {action: 'status'})).status;
  const hold = await controlRequest(socket, {action: 'prepare', instance: status.instance});
  try {
    assert.equal(hold.ok, true); const before = sent.length, events = store.listEvents(target.id).length;
    assert.throws(() => hub.requestHandoff(target.id, {}), {status: 503});
    assert.throws(() => hub.atomic(() => hub.requests.receiveCross('fixture-request', {text: 'a new question', toTaskId: target.id,
      from: {task_id: from.id, session_id: originSession.id, project_name: 'from', seq: from.seq, title: from.title, cwd: dir}})), {status: 503});
    const context = {capability: 'a'.repeat(43), workspaceId: 'fixture', requestId: 'request', taskId: target.id, sessionId: targetSession.id};
    await assert.rejects(authority.tools({...context, service: 'slack'}), {status: 503});
    await assert.rejects(authority.call({...context, callId: 'call', service: 'slack', tool: 'read', arguments: {}}), {status: 503});
    await assert.rejects(broker.invoke('a'.repeat(43), 'list', {}), {status: 503});
    assert.equal(sent.length, before); assert.equal(store.listEvents(target.id).length, events);
    assert.equal(store.getRequest('fixture-request'), undefined); assert.equal(store.queued({}).length, 0);
    await controlRequest(socket, {action: 'cancel', instance: status.instance, lease: hold.lease});
    assert.deepEqual(hub.requestHandoff(target.id, {}), {queued: false}); assert.equal(sent.length, before + 1);
  } finally {
    if (hold.lease) await controlRequest(socket, {action: 'cancel', instance: status.instance, lease: hold.lease});
    await new Promise<void>(resolve => server!.close(() => resolve())); authority.close(); broker.close(); hub.dispose(); store.database.close(); rmSync(dir, {recursive: true, force: true});
  }
});


test('stable data environment paths cannot reach a release through an existing parent symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-update-path-'));
  const source = join(dir, 'source'), deploymentDir = join(dir, 'deploy'), dataDir = join(dir, 'data'), alias = join(dir, 'looks-stable');
  for (const path of [source, deploymentDir, dataDir]) mkdirSync(path);
  symlinkSync(deploymentDir, alias);
  const config: UpdateConfig = {version: 1, enabled: true, source, ref: 'main', deploymentDir, dataDir, roles: ['shared'], environment: {}, intervalMs: 1000};
  try {
    for (const key of ['AGENT_DESK_DB', 'AGENT_DESK_UPLOADS', 'AGENT_DESK_SKILLS_HOME']) {
      const worker = new UpdateWorker({...config, environment: {[key]: join(alias, 'future', 'data')}});
      assert.throws(() => worker.claim(), /실제 저장 경로/);
      assert.equal(existsSync(join(deploymentDir, 'worker.lock')), false);
    }
    const good = new UpdateWorker({...config, environment: {AGENT_DESK_UPLOADS: join(dataDir, 'future', 'uploads')}});
    good.claim(); good.close();
  } finally {rmSync(dir, {recursive: true, force: true});}
});


test('runtime blockers include live connector work but exclude expired, revoked, completed and orphaned rows', () => {
  const store = new Store(':memory:'), db = store.database;
  const hub = {store, busy: new Set(), background: new Map()} as unknown as Hub;
  const now = Date.now();
  try {
    assert.deepEqual(hubBlockers(hub), []);
    db.exec("CREATE TABLE connector_job (status TEXT, expires_at INTEGER); INSERT INTO connector_job VALUES ('pending',0)");
    assert.deepEqual(hubBlockers(hub), []);
    db.prepare('UPDATE connector_job SET expires_at=?').run(now + 60000); assert.deepEqual(hubBlockers(hub), ['외부 조회 처리 중']);
    db.exec("UPDATE connector_job SET status='done'"); assert.deepEqual(hubBlockers(hub), []);
    db.exec(`CREATE TABLE connector_grant (capability_hash TEXT,expires_at INTEGER,revoked INTEGER);
      CREATE TABLE connector_call (capability_hash TEXT,result TEXT,error TEXT);
      INSERT INTO connector_call VALUES ('orphan',NULL,NULL);`);
    assert.deepEqual(hubBlockers(hub), []);
    db.exec("INSERT INTO connector_grant VALUES ('orphan',0,0)"); assert.deepEqual(hubBlockers(hub), []);
    db.prepare('UPDATE connector_grant SET expires_at=?,revoked=1').run(now + 60000); assert.deepEqual(hubBlockers(hub), []);
    db.exec('UPDATE connector_grant SET revoked=0'); assert.deepEqual(hubBlockers(hub), ['외부 조회 처리 중']);
    db.exec("UPDATE connector_call SET result='null'"); assert.deepEqual(hubBlockers(hub), []);
    db.exec("UPDATE connector_call SET result=NULL,error='failed'"); assert.deepEqual(hubBlockers(hub), []);
    hub.connectorQueriesPending = () => true; assert.deepEqual(hubBlockers(hub), ['외부 조회 처리 중']);
    hub.connectorQueriesPending = () => false; assert.deepEqual(hubBlockers(hub), []);
  } finally {db.close();}
});


test('release retention protects runtime and recovery anchors, recent worktrees, source, data and external symlinks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-prune-')), source = join(dir, 'source'), deploy = join(dir, 'deploy'), data = join(dir, 'data');
  mkdirSync(source); mkdirSync(data); mkdirSync(deploy);
  const git = (...args: string[]) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const sourceGit = (...args: string[]) => git('-C', source, ...args);
  sourceGit('init', '-b', 'main'); sourceGit('config', 'user.name', 'Fixture'); sourceGit('config', 'user.email', 'fixture@example.invalid');
  const commits: string[] = [];
  for (let index = 0; index < 9; index++) {writeFileSync(join(source, 'source.txt'), String(index)); sourceGit('add', '.'); sourceGit('commit', '-m', String(index)); commits.push(sourceGit('rev-parse', 'HEAD'));}
  const mirror = join(deploy, 'repository.git'); git('clone', '--mirror', source, mirror);
  mkdirSync(join(deploy, 'releases'));
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]; git('--git-dir', mirror, 'worktree', 'add', '--detach', join(deploy, 'releases', commit), commit);
    const marker = join(deploy, 'verified', commit + '.json'); writePrivateJson(marker, {commit}); utimesSync(marker, 1000 + index, 1000 + index);
  }
  writeFileSync(join(data, 'stable.txt'), 'stable');
  symlinkSync(data, join(deploy, 'releases', commits[4], 'external-data'));
  const config: UpdateConfig = {version: 1, enabled: true, source, ref: 'main', deploymentDir: deploy, dataDir: data, roles: ['shared'], environment: {}, intervalMs: 1000};
  const worker = new UpdateWorker(config); worker.claim();
  const owner = createHash('sha256').update(deploy).digest('hex'), oldOwner = process.env.AGENT_DESK_UPDATE_OWNER;
  process.env.AGENT_DESK_UPDATE_OWNER = owner;
  const server = await registerRuntimeControl({role: 'shared', socket: worker.socket('shared'), commit: commits[3], ready: () => true, blockers: () => [], stop: () => {}});
  let closed = false;
  try {
    writePrivateJson(worker.statePath, {current: commits[0], candidate: commits[1], phase: 'failed', started: {shared: {owner, commit: commits[2], instance: 'recorded-candidate', pid: 123}}});
    const unsafe = join(deploy, 'releases', 'f'.repeat(40)); symlinkSync(source, unsafe);
    await assert.rejects(worker.pruneReleases(), /개발 체크아웃·데이터·외부 경로/);
    assert.equal(readFileSync(join(source, 'source.txt'), 'utf8'), '8'); assert.ok(existsSync(join(deploy, 'releases', commits[4]))); unlinkSync(unsafe);
    const verified = join(deploy, 'verified'), retained = join(deploy, 'verified-retained'), external = join(dir, 'external-verified');
    mkdirSync(external); const protectedMarker = join(external, commits[4] + '.json'); writeFileSync(protectedMarker, 'external marker');
    renameSync(verified, retained); symlinkSync(external, verified);
    await assert.rejects(worker.pruneReleases(), /일반 배포 디렉터리/);
    assert.equal(readFileSync(protectedMarker, 'utf8'), 'external marker'); assert.ok(existsSync(join(deploy, 'releases', commits[4])));
    unlinkSync(verified); renameSync(retained, verified);
    // Persisted gateway/token paths are effective runtime data even without direct environment overrides.
    const modeFile = join(data, 'local-mode.json');
    for (const key of ['gatewayDbPath', 'tokenFile']) {
      const protectedData = join(deploy, 'releases', commits[4], 'persistent-' + key);
      writeFileSync(protectedData, 'must survive');
      writeFileSync(modeFile, JSON.stringify({authorityUrl: 'http://127.0.0.1:4321/', tokenFile: join(data, 'token'), gatewayDbPath: join(data, 'gateway.db'), [key]: protectedData}));
      await assert.rejects(worker.pruneReleases(), /데이터/);
      assert.equal(readFileSync(protectedData, 'utf8'), 'must survive');
    }
    writeFileSync(modeFile, 'broken-json');
    await assert.rejects(worker.pruneReleases(), /읽을 수 없습니다/);
    unlinkSync(modeFile);
    const removed = await worker.pruneReleases(); assert.deepEqual(new Set(removed), new Set([commits[4], commits[5]]));
    for (const commit of [commits[0], commits[1], commits[2], commits[3], ...commits.slice(6)]) assert.ok(existsSync(join(deploy, 'releases', commit)));
    for (const commit of removed) {assert.equal(existsSync(join(deploy, 'releases', commit)), false); assert.equal(existsSync(join(deploy, 'verified', commit + '.json')), false);}
    assert.equal(readFileSync(join(source, 'source.txt'), 'utf8'), '8'); assert.equal(sourceGit('status', '--porcelain'), '');
    assert.equal(readFileSync(join(data, 'stable.txt'), 'utf8'), 'stable');
    await new Promise<void>(resolve => server!.close(() => resolve())); closed = true;
    await assert.rejects(worker.pruneReleases(), /실행 상태를 확인하지 못해/);
  } finally {
    if (!closed) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (oldOwner === undefined) delete process.env.AGENT_DESK_UPDATE_OWNER; else process.env.AGENT_DESK_UPDATE_OWNER = oldOwner;
    worker.close(); rmSync(dir, {recursive: true, force: true});
  }
});


test('updater rejects indirect release data and malformed local settings before taking ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-indirect-protect-'));
  const deploymentDir = join(dir, 'deploy'), dataDir = join(dir, 'data');
  mkdirSync(deploymentDir); mkdirSync(dataDir);
  const modeFile = join(dataDir, 'local-mode.json');
  const config: UpdateConfig = {version: 1, enabled: true, source: 'https://example.invalid/repo', ref: 'main', deploymentDir, dataDir, roles: ['shared'], environment: {}, intervalMs: 1000};
  try {
    for (const key of ['gatewayDbPath', 'tokenFile']) {
      writeFileSync(modeFile, JSON.stringify({authorityUrl: 'http://127.0.0.1:4321/', tokenFile: join(dataDir, 'token'), gatewayDbPath: join(dataDir, 'gateway.db'), [key]: join(deploymentDir, 'releases', 'future', 'data')}));
      assert.throws(() => new UpdateWorker(config).claim(), /실제 저장 경로/);
      assert.equal(existsSync(join(deploymentDir, 'worker.lock')), false);
    }
    writeFileSync(modeFile, JSON.stringify({authorityUrl: 'http://127.0.0.1:4321/', tokenFile: join(dataDir, 'token'), gatewayDbPath: join(deploymentDir, 'ignored.db')}));
    const partial = new UpdateWorker({...config, environment: {AGENT_DESK_GATEWAY_DB: join(dataDir, 'override.db')}});
    partial.claim(); partial.close();
    writeFileSync(modeFile, '{');
    assert.throws(() => new UpdateWorker(config).claim(), /읽을 수 없습니다/);
    // Runtime ignores the persisted settings only if all three explicit values exist.
    const explicit = new UpdateWorker({...config, environment: {AGENT_DESK_GATEWAY_DB: join(dataDir, 'explicit.db'), AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE: join(dataDir, 'explicit.token'), AGENT_DESK_LOCAL_AUTHORITY_URL: 'http://127.0.0.1:4321/'}});
    explicit.claim(); explicit.close();
    unlinkSync(modeFile); symlinkSync(join(dataDir, 'missing'), modeFile);
    assert.throws(() => new UpdateWorker(config).claim(), /심볼릭 링크/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('updater and runtime refuse writable roots, writable ancestors and replaceable config paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-trust-'));
  const deploymentDir = join(dir, 'deploy'), dataDir = join(dir, 'data'), settings = join(dir, 'settings');
  for (const path of [deploymentDir, dataDir, settings]) mkdirSync(path, {mode: 0o700});
  const config: UpdateConfig = {version: 1, enabled: true, source: 'https://example.invalid/repo', ref: 'main', deploymentDir, dataDir, roles: ['shared'], environment: {}, intervalMs: 1000};
  const configPath = join(settings, 'update.json'); writePrivateJson(configPath, config);
  try {
    for (const mode of [0o777, 0o770]) for (const path of [deploymentDir, dataDir, dir]) {
      chmodSync(path, mode);
      assert.throws(() => new UpdateWorker(config).claim(), /쓰기 권한/);
      assert.equal(existsSync(join(deploymentDir, 'worker.lock')), false);
      chmodSync(path, 0o700);
    }
    chmodSync(settings, 0o777);
    assert.throws(() => readUpdateConfig(configPath), /쓰기 권한/);
    assert.throws(() => writePrivateJson(configPath, config), /쓰기 권한/);
    const alias = join(dir, 'alias'); symlinkSync(settings, alias);
    assert.throws(() => readUpdateConfig(join(alias, 'update.json')), /쓰기 권한/);
    await assert.rejects(registerRuntimeControl({role: 'shared', socket: join(settings, 'control', 'ctl.sock'), ready: () => true, blockers: () => [], stop: () => {}}), /쓰기 권한/);
    assert.equal(existsSync(join(settings, 'control')), false);
    chmodSync(settings, 0o700);
    assert.deepEqual(readUpdateConfig(configPath), config);
    const worker = new UpdateWorker(config); worker.claim(); worker.close();
  } finally {rmSync(dir, {recursive: true, force: true});}
});


test('trusted paths allow sticky system temp ancestors and reject a different UID at the protected leaf', () => {
  const dir = mkdtempSync('/tmp/desk-trusted-root-');
  try {
    assert.doesNotThrow(() => assertTrustedPath(dir, {kind: 'directory', private: true}));
    if (process.getuid?.() !== 0) assert.throws(() => assertTrustedPath('/', {kind: 'directory'}), /소유 UID/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});


test('effective external data files and derived shared databases must have trusted ownership and modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-data-trust-'));
  const deploymentDir = join(dir, 'deploy'), dataDir = join(dir, 'data'), external = join(dir, 'external');
  for (const path of [deploymentDir, dataDir, external]) mkdirSync(path);
  const config: UpdateConfig = {version: 1, enabled: true, source: 'https://example.invalid/repo', ref: 'main', deploymentDir, dataDir, roles: ['shared'], environment: {}, intervalMs: 1000};
  try {
    chmodSync(external, 0o777);
    assert.throws(() => new UpdateWorker({...config, environment: {AGENT_DESK_SHARED_DIR: external}}).claim(), /쓰기 권한/);
    chmodSync(external, 0o700);
    const file = join(external, 'persistent'); writeFileSync(file, 'preserve'); chmodSync(file, 0o666);
    for (const key of ['AGENT_DESK_DB', 'AGENT_DESK_TOKEN_FILE', 'AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE'])
      assert.throws(() => new UpdateWorker({...config, environment: {[key]: file}}).claim(), /쓰기 권한/);
    for (const key of ['gatewayDbPath', 'tokenFile']) {
      writeFileSync(join(dataDir, 'local-mode.json'), JSON.stringify({authorityUrl: 'http://127.0.0.1:4321/', gatewayDbPath: join(dataDir, 'gateway.db'), tokenFile: join(dataDir, 'token'), [key]: file}));
      assert.throws(() => new UpdateWorker(config).claim(), /쓰기 권한/);
    }
    unlinkSync(join(dataDir, 'local-mode.json'));
    const database = join(external, 'delivery.db'); writeFileSync(database, 'preserve'); chmodSync(database, 0o666);
    assert.throws(() => new UpdateWorker({...config, environment: {AGENT_DESK_SHARED_DIR: external}}).claim(), /쓰기 권한/);
    assert.equal(existsSync(join(deploymentDir, 'worker.lock')), false);
    assert.equal(readFileSync(file, 'utf8'), 'preserve'); assert.equal(readFileSync(database, 'utf8'), 'preserve');
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('prepare and activate reject writable Git metadata, release trees, markers and entry files before execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-code-trust-'));
  const source = join(dir, 'source'), deploymentDir = join(dir, 'deploy'), dataDir = join(dir, 'data');
  for (const path of [source, deploymentDir, dataDir]) mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const sourceGit = (...args: string[]) => git('-C', source, ...args);
  let worker: UpdateWorker | undefined;
  try {
    sourceGit('init', '-b', 'main'); sourceGit('config', 'user.name', 'Fixture'); sourceGit('config', 'user.email', 'fixture@example.invalid');
    const executed = join(dir, 'executed');
    const command = 'node -e ' + JSON.stringify('require("fs").writeFileSync(' + JSON.stringify(executed) + ',"executed")');
    const pkg = {name: 'fixture', version: '1.0.0', scripts: {typecheck: command, build: command, test: command}};
    writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify({name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {'': {name: pkg.name, version: pkg.version}}}));
    mkdirSync(join(source, 'hub/src/runner'), {recursive: true}); writeFileSync(join(source, 'hub/src/runner/shared.ts'), '');
    sourceGit('add', '.'); sourceGit('commit', '-m', 'fixture'); const commit = sourceGit('rev-parse', 'HEAD');
    const mirror = join(deploymentDir, 'repository.git'), releases = join(deploymentDir, 'releases'), verified = join(deploymentDir, 'verified');
    git('clone', '--mirror', source, mirror); mkdirSync(releases); mkdirSync(verified);
    const release = join(releases, commit), marker = join(verified, commit + '.json');
    git('--git-dir', mirror, 'worktree', 'add', '--detach', release, commit);
    worker = new UpdateWorker({version: 1, enabled: true, source, ref: 'main', deploymentDir, dataDir, roles: ['shared'], environment: {}, intervalMs: 1000});
    worker.claim();
    for (const path of [mirror, join(mirror, 'config'), releases, verified, release, join(release, 'package.json'), join(release, 'hub/src/runner/shared.ts')]) {
      const directory = !path.endsWith('config') && !path.endsWith('.json') && !path.endsWith('.ts');
      chmodSync(path, directory ? 0o777 : 0o666);
      await assert.rejects(worker.prepare(), /쓰기 권한/);
      assert.equal(existsSync(executed), false);
      chmodSync(path, directory ? 0o755 : 0o644);
    }
    writePrivateJson(marker, {commit, policy: createHash('sha256').update(JSON.stringify({source, node: process.version, checks: 1})).digest('hex')});
    chmodSync(marker, 0o666); await assert.rejects(worker.prepare(), /쓰기 권한/); chmodSync(marker, 0o600);
    const entry = join(release, 'hub/src/runner/shared.ts'); chmodSync(entry, 0o666);
    await assert.rejects(worker.prepare(), /쓰기 권한/); // Cached verification must not bypass the tree check.
    writePrivateJson(worker.statePath, {candidate: commit, phase: 'waiting'});
    await assert.rejects(async () => {worker!.approve(commit, 'immediate'); await worker!.activate(commit);}, /쓰기 권한/);
    assert.equal(existsSync(executed), false);
    chmodSync(entry, 0o644);
    const internal = join(release, 'internal-link'); symlinkSync(entry, internal);
    assert.doesNotThrow(() => assertTrustedTree(release));
    unlinkSync(internal); symlinkSync(dataDir, internal);
    assert.throws(() => assertTrustedTree(release), /검증 경로 밖/);
    const aliasDir = join(dir, 'replaceable-alias'); mkdirSync(aliasDir); chmodSync(aliasDir, 0o777);
    const alias = join(aliasDir, 'entry'); symlinkSync(entry, alias);
    unlinkSync(internal); symlinkSync(alias, internal);
    assert.throws(() => assertTrustedTree(release), /쓰기 권한/);
  } finally {worker?.close(); rmSync(dir, {recursive: true, force: true});}
});

/** A disposable Git source and fake npm: no real package install, model or production service. */
function prepareGuardFixture() {
  const dir=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'desk-prepare-'));
  const source=join(dir,'source'),data=join(dir,'data'),deploy=join(dir,'deploy'),bin=join(dir,'bin');
  mkdirSync(join(source,'hub/src/runner'),{recursive:true});mkdirSync(data);mkdirSync(bin);
  const git=(...args:string[])=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(source,'package.json'),JSON.stringify({name:'prepare-fixture',version:'1.0.0',type:'module'}));
  writeFileSync(join(source,'package-lock.json'),'{}');writeFileSync(join(source,'hub/src/runner/shared.ts'),'process.exit(0)');
  git('add','.');git('commit','-m','fixture');const commit=git('rev-parse','HEAD');
  const npm=join(bin,'npm'),marker=join(deploy,'prepare.pending.json');
  const fakeNpm=(body:string)=>writeFileSync(npm,`#!${process.execPath}\n${body}\n`,{mode:0o755});
  const config:UpdateConfig={version:1,enabled:true,source,ref:'main',deploymentDir:deploy,dataDir:data,roles:['shared'],environment:{AGENT_DESK_SHARED_PORT:'65431'},intervalMs:1000};
  return {dir,data,deploy,bin,marker,config,commit,fakeNpm};
}

test('approval is exact, cross-process cancellable and never reused after failure or an unapproved interrupted switch', async () => {
  const f = prepareGuardFixture(), previousPath = process.env.PATH;
  f.fakeNpm('process.exit(0)'); process.env.PATH = f.bin + ':' + previousPath;
  const worker = new UpdateWorker(f.config); worker.claim();
  const configPath = join(f.dir, 'update.json'); writePrivateJson(configPath, f.config);
  try {
    assert.equal(await worker.cycle(), false); assert.equal(worker.state().candidate, f.commit);
    await assert.rejects(worker.activate(f.commit), /명시적 업데이트 승인/);
    assert.throws(() => worker.approve(f.commit.slice(0, 7), 'immediate'), /40자/);
    assert.throws(() => worker.approve('a'.repeat(40), 'when-idle'), /후보/);
    const first = worker.approve(f.commit, 'when-idle');
    assert.equal(new UpdateWorker(f.config).state().approval?.token, first.token);
    assert.throws(() => worker.approve(f.commit, 'immediate'), /먼저 취소/);
    assert.equal(worker.cancelApproval(f.commit, 'stale-token'), false);
    const result = execFileSync(process.execPath, [fileURLToPath(new URL('../../hub/src/update-cli.ts', import.meta.url)), 'cancel', configPath, f.commit], {encoding: 'utf8'});
    assert.equal(JSON.parse(result).cancelled, true, 'cancellation works while the worker lock remains owned');
    const second = worker.approve(f.commit, 'immediate');
    assert.notEqual(second.token, first.token);
    assert.equal(worker.cancelApproval(f.commit, first.token), false);
    const internal = worker as unknown as {activateApproved: () => Promise<boolean>};
    internal.activateApproved = async () => {throw new Error('fixture activation failed');};
    await assert.rejects(worker.cycle(), /fixture activation failed/);
    assert.equal(worker.state().approval, undefined);
    worker.approve(f.commit, 'immediate'); writePrivateJson(f.marker, {pid: process.pid});
    await assert.rejects(worker.cycle(), /이전 업데이트 준비/);
    assert.equal(worker.state().phase, 'failed'); assert.match(worker.state().error!, /이전 업데이트 준비/);
    assert.equal(worker.state().approval, undefined); unlinkSync(f.marker);
    const competing = worker.approve(f.commit, 'immediate'), approvalLock = join(f.deploy, 'approval.lock');
    internal.activateApproved = async () => {writePrivateJson(approvalLock, {pid: process.pid}, true); throw new Error('fixture competing writer');};
    await assert.rejects(worker.cycle(), /승인 변경 잠금/);
    assert.equal(worker.state().spentApproval, competing.token);
    unlinkSync(approvalLock);
    await assert.rejects(worker.cycle(), /이미 사용한 업데이트 승인/, 'cleanup contention cannot make a failed approval reusable');
    assert.equal(worker.cancelApproval(f.commit), true);
    writePrivateJson(worker.statePath, {candidate: f.commit, attempted: f.commit, phase: 'switching'});
    assert.throws(() => worker.cancelApproval(f.commit), /적용 중이라 취소/);
    assert.equal(await worker.cycle(), false, 'an interrupted switch cannot launch without its original approval');
    assert.equal(worker.state().attempted, f.commit);
  } finally {worker.close(); process.env.PATH = previousPath; rmSync(f.dir, {recursive: true, force: true});}
});

test('cancellation during maintenance preparation prevents the first runtime stop', async () => {
  const f = prepareGuardFixture(), previousPath = process.env.PATH, previousOwner = process.env.AGENT_DESK_UPDATE_OWNER;
  f.fakeNpm('process.exit(0)'); process.env.PATH = f.bin + ':' + previousPath;
  const worker = new UpdateWorker(f.config); worker.claim();
  process.env.AGENT_DESK_UPDATE_OWNER = createHash('sha256').update(f.deploy).digest('hex');
  let server: Awaited<ReturnType<typeof registerRuntimeControl>>, observations = 0, stops = 0;
  try {
    await worker.prepare(); worker.approve(f.commit, 'immediate');
    server = await registerRuntimeControl({role: 'shared', socket: worker.socket('shared'), commit: 'a'.repeat(40), ready: () => true,
      blockers: () => {if (++observations === 3) assert.equal(worker.cancelApproval(f.commit), true); return [];},
      stop: () => {stops++;}});
    await assert.rejects(worker.cycle(), /승인이 취소/);
    assert.equal(stops, 0); assert.equal(worker.state().approval, undefined);
    assert.doesNotThrow(requireAdmission, 'the cancelled attempt releases its maintenance hold');
  } finally {
    if (server!) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (previousOwner === undefined) delete process.env.AGENT_DESK_UPDATE_OWNER; else process.env.AGENT_DESK_UPDATE_OWNER = previousOwner;
    worker.close(); process.env.PATH = previousPath; rmSync(f.dir, {recursive: true, force: true});
  }
});

test('prepare crash guard blocks a replacement worker while orphan npm remains and allows explicit recovery only after it ends',{timeout:30_000},async()=>{
  const f=prepareGuardFixture(),configPath=join(f.dir,'update.json'),capture=join(f.data,'npm.jsonl');
  writePrivateJson(configPath,f.config);
  f.fakeNpm(`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');setInterval(()=>{},1000);`);
  const workers:ChildProcess[]=[];let reports='';
  const rows=()=>existsSync(capture)?readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {pid:number;args:string[]}):[];
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const wait=async(read:()=>boolean,label:string)=>{for(let i=0;i<400;i++){if(read())return;await delay(25);}throw new Error(label+'\n'+reports);};
  const launch=()=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../../hub/src/update-cli.ts',import.meta.url)),'run',configPath],{cwd:f.dir,env:{...process.env,PATH:f.bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
    workers.push(child);for(const stream of [child.stdout!,child.stderr!])stream.on('data',chunk=>{reports=(reports+chunk).slice(-32_768);});return child;
  };
  try {
    const first=launch();await wait(()=>rows().length===1,'initial fake npm did not start');
    const orphan=rows()[0].pid;first.kill('SIGKILL');await wait(()=>first.signalCode==='SIGKILL','worker did not crash');
    assert.equal(alive(orphan),true);assert.equal(existsSync(f.marker),true);
    const second=launch();await wait(()=>reports.includes('이전 업데이트 준비의 프로세스 종료를 확인하지 못해'),'replacement did not report its prepare guard');
    await delay(150);assert.equal(rows().length,1,'no second npm may build the same release');assert.equal(alive(orphan),true);
    second.kill('SIGTERM');await wait(()=>second.exitCode!==null||second.signalCode!==null,'replacement did not stop');
    process.kill(orphan,'SIGKILL');await wait(()=>!alive(orphan),'orphan npm did not exit');
    // Only this fixture's known process has been stopped; emulate the documented operator recovery.
    unlinkSync(f.marker);f.fakeNpm('process.exit(0)');
    const previousPath=process.env.PATH;process.env.PATH=f.bin+':'+previousPath;
    const recovered=new UpdateWorker(f.config);recovered.claim();
    try {assert.equal(await recovered.prepare(),f.commit);assert.equal(existsSync(f.marker),false);}
    finally {recovered.close();process.env.PATH=previousPath;}
  } finally {
    for(const child of workers)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    for(const row of rows())if(alive(row.pid))try{process.kill(row.pid,'SIGKILL');}catch{}
    await delay(100);rmSync(f.dir,{recursive:true,force:true});
  }
});

for(const mode of ['exit','signal','maxBuffer','timeout'] as const)test(`prepare guard handles ${mode} without treating uncertain process termination as a normal retry`,{timeout:15_000},async()=>{
  const f=prepareGuardFixture(),previousPath=process.env.PATH;
  const scripts={exit:'process.exit(7)',signal:"process.kill(process.pid,'SIGTERM')",maxBuffer:"process.stdout.write('x'.repeat(3*1024*1024))",timeout:'setInterval(()=>{},1000)'};
  f.fakeNpm(scripts[mode]);process.env.PATH=f.bin+':'+previousPath;
  const worker=new UpdateWorker(f.config,{commandTimeoutMs:1000});worker.claim();
  try {
    await assert.rejects(worker.prepare());
    if(mode==='exit') {
      assert.equal(existsSync(f.marker),false,'a confirmed nonzero command exit preserves automatic retry');
      f.fakeNpm('process.exit(0)');assert.equal(await worker.prepare(),f.commit);
      assert.equal(await worker.prepare(),f.commit,'a verified cache hit also clears its temporary guard');
      assert.equal(existsSync(f.marker),false);
    } else {
      assert.equal(existsSync(f.marker),true);assert.equal(readFileSync(f.marker,'utf8').includes('"pid": '+process.pid),true);
      await assert.rejects(worker.prepare(),/이전 업데이트 준비/);
      await assert.rejects(worker.activate(f.commit),/이전 업데이트 준비/);
      await assert.rejects(worker.pruneReleases(),/이전 업데이트 준비/);
    }
  } finally {worker.close();process.env.PATH=previousPath;rmSync(f.dir,{recursive:true,force:true});}
});

test('prepare guard preserves a changed owner marker instead of clearing an unconfirmed preparation',{timeout:10_000},async()=>{
  const f=prepareGuardFixture(),previousPath=process.env.PATH;
  f.fakeNpm(`import{readFileSync,writeFileSync}from'node:fs';const marker=${JSON.stringify(f.marker)};const saved=JSON.parse(readFileSync(marker,'utf8'));saved.token='different-owner';writeFileSync(marker,JSON.stringify(saved),{mode:0o600});`);
  process.env.PATH=f.bin+':'+previousPath;const worker=new UpdateWorker(f.config);worker.claim();
  try {
    await assert.rejects(worker.prepare(),/소유권/);
    assert.equal(JSON.parse(readFileSync(f.marker,'utf8')).token,'different-owner');
    await assert.rejects(worker.prepare(),/이전 업데이트 준비/);
  } finally {worker.close();process.env.PATH=previousPath;rmSync(f.dir,{recursive:true,force:true});}
});

test('start brings back the activated release after its runtime is gone, never another version or a failed switch', { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-start-')), source = join(dir, 'source'), data = join(dir, 'data'), deploy = join(dir, 'deploy');
  mkdirSync(join(source, 'hub/src/runner'), { recursive: true }); mkdirSync(data);
  for (const name of ['runtime-control.ts', 'trusted-path.ts', 'errors.ts']) copyFileSync(new URL(`../../hub/src/${name}`, import.meta.url), join(source, 'hub/src', name));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const pkg = { name: 'start-fixture', version: '1.0.0', type: 'module', scripts: { typecheck: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } };
  writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }));
  const runtime = `import {registerRuntimeControl} from '../runtime-control.ts';
import {appendFileSync} from 'node:fs'; import {dirname,join} from 'node:path';
appendFileSync(join(dirname(process.env.AGENT_DESK_DB),'starts.txt'),'one\\n');
await registerRuntimeControl({role:'shared',ready:()=>true,blockers:()=>[],stop:()=>process.exit(0)});`;
  const commit = (message: string, body: string) => { writeFileSync(join(source, 'hub/src/runner/shared.ts'), body); git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  const v1 = commit('one', runtime);
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const config: UpdateConfig = { version: 1, enabled: true, source, ref: 'main', deploymentDir: deploy, dataDir: data, roles: ['shared'], environment: { AGENT_DESK_SHARED_PORT: String(port) }, intervalMs: 1000 };
  writeFileSync(join(data, 'agent-desk.db'), '원본 DB 유지');
  const worker = new UpdateWorker(config); worker.claim();
  // A runtime on its way out answers with a cut reply first; wait until its socket is really gone.
  const gone = async () => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await delay(50)) {
      try { if (!(await worker.status())[0].runtime) return; } catch { /* exiting */ }
    }
    throw new Error('runtime did not exit');
  };
  try {
    await assert.rejects(worker.startCurrent(), /활성화한 릴리스가 없습니다/);
    worker.approve(await worker.prepare(), 'immediate'); assert.equal(await worker.cycle(), true);
    assert.equal(readlinkSync(join(deploy, 'current')), join('releases', v1));
    assert.deepEqual(await worker.startCurrent(), [], 'a ready runtime of the current release is left alone');
    const running = (await worker.status())[0].runtime!;
    // The runtime is gone (a reboot): it is stopped through its own control socket here.
    const hold = await controlRequest(worker.socket('shared'), { action: 'prepare', instance: running.instance });
    await controlRequest(worker.socket('shared'), { action: 'stop', instance: running.instance, lease: hold.lease });
    await gone();
    assert.deepEqual(await worker.startCurrent(), ['shared']);
    const restarted = (await worker.status())[0].runtime!;
    assert.equal(restarted.commit, v1); assert.equal(restarted.ready, true); assert.notEqual(restarted.pid, running.pid);
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\none\n');
    assert.equal(readFileSync(join(data, 'agent-desk.db'), 'utf8'), '원본 DB 유지');
    // A switch whose candidate failed to start is not undone by start: a fixed successor commit recovers it.
    commit('broken', 'process.exit(17);');
    worker.approve(await worker.prepare(), 'immediate');
    await assert.rejects(worker.cycle(), /준비 전에 종료/);
    await gone();
    await assert.rejects(worker.startCurrent(), /끝나지 않은 교체/);
    assert.equal(readFileSync(join(data, 'starts.txt'), 'utf8'), 'one\none\n');
  } finally {
    try {
      const status = (await worker.status())[0].runtime;
      if (status) {
        const hold = await controlRequest(worker.socket('shared'), { action: 'prepare', instance: status.instance });
        if (hold.ok) await controlRequest(worker.socket('shared'), { action: 'stop', instance: status.instance, lease: hold.lease });
      }
      await delay(150);
    } finally { worker.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
