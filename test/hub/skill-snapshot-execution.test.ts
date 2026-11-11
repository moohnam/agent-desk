import assert from 'node:assert/strict';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubToRunner, RunnerToHub } from '../../shared/protocol.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import type { RunnerPort } from '../../hub/src/runner/client.ts';
import { RunnerClient } from '../../hub/src/runner/client.ts';
import { collectSkillBundle } from '../../hub/src/shared-skill-sync.ts';
import { materializeSkillSnapshot, steeringSkillText } from '../../hub/src/runner/skill-input.ts';
import { SkillStore } from '../../hub/src/skills.ts';

test('queued input retains its accepted skill and child files after source updates', () => {
  const temp = mkdtempSync(join(tmpdir(), 'desk-frozen-'));
  const skills = new SkillStore(join(temp, 'skills-home'));
  skills.create('parent', 'parent');
  skills.create('child', 'child');
  skills.writeFile('parent', 'SKILL.md', '---\nname: parent\ndescription: parent\n---\n\nUse #child only if needed. version one');
  skills.writeFile('child', 'scripts/run.sh', '#!/bin/sh\necho one\n');
  const sent: HubToRunner[] = [];
  let say!: (message: RunnerToHub) => void;
  let snapshotSupported = true;
  const live = new Set<string>();
  const runner: RunnerPort = { connected: true, id: 'local-test', engines: new Set(['codex']),
    get skillSnapshotSupported() { return snapshotSupported; },
    has: id => live.has(id), handle: cmd => { sent.push(cmd); if (cmd.type === 'start') live.add(cmd.sessionId); } };
  const hub = new Hub(new Store(':memory:'), { skills, runner: onMessage => {
    say = message => { if (message.type === 'closed') live.delete(message.sessionId); onMessage(message); };
    return runner;
  }, graceMs: 60_000 });
  try {
    const project = hub.createProject('test', temp);
    const task = hub.createTask(project.id, '', '#codex first');
    const session = hub.store.latestSession(task.id)!;
    say({ type: 'busy', sessionId: session.id, busy: true });
    hub.sendMessage(task.id, '#parent queued');
    hub.sendMessage(task.id, '#parent promoted');
    const queued = hub.store.queued({ sessionId: session.id })[0];
    const promoted = hub.store.queued({ sessionId: session.id })[1];
    assert.equal(queued.skill_snapshot?.selected[0], 'parent');
    assert.match(queued.skill_snapshot?.files.find(f => f.name === 'parent' && f.path === 'SKILL.md')?.content ?? '', /version one/);
    assert.match(queued.skill_snapshot?.files.find(f => f.name === 'child' && f.path === 'scripts\/run.sh')?.content ?? '', /echo one/);
    skills.writeFile('parent', 'SKILL.md', '---\nname: parent\ndescription: parent\n---\n\nversion two');
    skills.writeFile('child', 'scripts/run.sh', '#!/bin/sh\necho two\n');
    snapshotSupported = false;
    assert.throws(() => hub.sendQueuedNow(task.id, promoted.id), /고정 스킬 버전/);
    assert.equal(hub.store.queued({ sessionId: session.id }).length, 2);
    snapshotSupported = true;
    hub.sendQueuedNow(task.id, promoted.id);
    const promotedCommand = sent.at(-1)!;
    assert.equal(promotedCommand.type, 'send');
    if (promotedCommand.type === 'send') {
      assert.equal(promotedCommand.steer, true);
      assert.equal(promotedCommand.skillSnapshot?.digest, promoted.skill_snapshot?.digest);
      assert.match(promotedCommand.skillSnapshot?.files.find(f => f.name === 'parent' && f.path === 'SKILL.md')?.content ?? '', /version one/);
    }
    snapshotSupported = false;
    say({ type: 'busy', sessionId: session.id, busy: false });
    assert.equal(hub.store.queued({ sessionId: session.id }).length, 1);
    assert.equal(sent.at(-1), promotedCommand);
    snapshotSupported = true;
    say({ type: 'busy', sessionId: session.id, busy: false });
    const command = sent.at(-1)!;
    assert.equal(command.type, 'send');
    if (command.type !== 'send') return;
    assert.equal(command.skillSnapshot?.digest, queued.skill_snapshot?.digest);
    const home = materializeSkillSnapshot(skills.home, command.skillSnapshot!);
    assert.match(readFileSync(join(home, 'skills', 'parent', 'SKILL.md'), 'utf8'), /version one/);
    assert.match(readFileSync(join(home, 'skills', 'child', 'scripts', 'run.sh'), 'utf8'), /echo one/);
    const prompt = steeringSkillText(command.text, command.skills, home);
    assert.match(prompt, /이번 입력의 하위 스킬 참조/);
    assert.ok(prompt.includes(join(home, 'skills')));
    writeFileSync(join(home, 'skills', 'child', 'scripts', 'run.sh'), 'tampered');
    materializeSkillSnapshot(skills.home, command.skillSnapshot!);
    assert.match(readFileSync(join(home, 'skills', 'child', 'scripts', 'run.sh'), 'utf8'), /echo one/);
    hub.sendMessage(task.id, '#parent #now 즉시 실행');
    const steered = sent.at(-1)!;
    assert.equal(steered.type, 'send');
    if (steered.type === 'send') {
      assert.equal(steered.steer, true);
      assert.match(steered.skillSnapshot?.files.find(f => f.name === 'parent' && f.path === 'SKILL.md')?.content ?? '', /version two/);
    }
    say({ type: 'engine_session', sessionId: session.id, engineSessionId: 'engine-1' });
    const forkId = hub.sendMessage(task.id, '#fork #parent 분기 실행');
    assert.notEqual(forkId, task.id);
    const forked = sent.at(-1)!;
    assert.equal(forked.type, 'start');
    if (forked.type === 'start') {
      assert.equal(forked.fork, true);
      assert.match(forked.skillSnapshot?.files.find(f => f.name === 'parent' && f.path === 'SKILL.md')?.content ?? '', /version two/);
    }
    say({ type: 'closed', sessionId: session.id, busy: false, reason: 'idle' });
    hub.sendMessage(task.id, '#parent 재개 실행');
    const resumed = sent.at(-1)!;
    assert.equal(resumed.type, 'start');
    if (resumed.type === 'start') {
      assert.equal(resumed.resume, 'engine-1');
      assert.match(resumed.skillSnapshot?.files.find(f => f.name === 'parent' && f.path === 'SKILL.md')?.content ?? '', /version two/);
    }
  } finally {
    hub.dispose(); hub.store.database.close(); rmSync(temp, { recursive: true, force: true });
  }
});

test('old local daemon rejects pinned skills and continues to accept plain input', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'desk-old-runner-'));
  const skills = new SkillStore(join(temp, 'skills-home'));
  skills.create('parent', 'parent');
  skills.writeFile('parent', 'SKILL.md', '---\nname: parent\ndescription: parent\n---\nversion one');
  const snapshot = collectSkillBundle(skills, ['parent'])!;
  const commands: HubToRunner[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const value = JSON.parse(line) as HubToRunner;
        if (value.type === 'auth') socket.write(JSON.stringify({ type: 'hello', runnerId: 'local-fake', host: 'test',
          capabilities: { engines: ['codex'], close: true }, sessions: [], protocolVersion: 1 }) + '\n');
        else commands.push(value);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new RunnerClient(() => {}, () => {}, { host: '127.0.0.1', port: (server.address() as { port: number }).port,
    token: () => 'test-token', spawnIfMissing: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const end = Date.now() + 1000;
      const poll = () => client.connected ? resolve() : Date.now() >= end ? reject(new Error('runner hello timeout')) : setTimeout(poll, 5);
      poll();
    });
    skills.writeFile('parent', 'SKILL.md', '---\nname: parent\ndescription: parent\n---\nversion two');
    assert.throws(() => client.handle({ type: 'start', sessionId: 's', engine: 'codex', cwd: temp, prompt: '원문', permissionMode: 'default',
      skills: ['parent'], skillsHome: skills.home, skillSnapshot: snapshot }), /고정 스킬 버전/);
    assert.equal(client.has('s'), false);
    client.handle({ type: 'start', sessionId: 's', engine: 'codex', cwd: temp, prompt: '일반 원문', permissionMode: 'default' });
    assert.throws(() => client.handle({ type: 'send', sessionId: 's', text: '추가 원문', skills: ['parent'], steer: true, skillSnapshot: snapshot }), /고정 스킬 버전/);
    client.handle({ type: 'send', sessionId: 's', text: '일반 추가', steer: true });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(commands.length, 2);
    const [start, send] = commands;
    assert.equal(start.type, 'start'); assert.equal(send.type, 'send');
    if (start.type !== 'start' || send.type !== 'send') return;
    assert.equal(start.skillSnapshot, undefined);
    assert.equal(send.skillSnapshot, undefined);
    assert.equal(send.steer, true);
    assert.equal(start.prompt, '일반 원문'); assert.equal(send.text, '일반 추가');
    assert.equal(existsSync(join(skills.home, '.snapshots', snapshot.digest)), false);
  } finally {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});

test('cache admission preserves active roots and refuses an oversized new version', () => {
  const temp = mkdtempSync(join(tmpdir(), 'desk-snapshot-cap-'));
  try {
    const skills = new SkillStore(join(temp, 'skills-home'));
    skills.create('parent', 'parent');
    const snapshot = collectSkillBundle(skills, ['parent'])!;
    const protectedHome = join(skills.home, '.snapshots', 'a'.repeat(64));
    mkdirSync(protectedHome, { recursive: true });
    const protectedFile = join(protectedHome, 'active-file');
    const fd = openSync(protectedFile, 'w');
    try { ftruncateSync(fd, 512 * 1024 * 1024); } finally { closeSync(fd); }
    assert.throws(() => materializeSkillSnapshot(skills.home, snapshot, [protectedHome]), /캐시 용량/);
    assert.ok(existsSync(protectedFile));
    assert.equal(existsSync(join(skills.home, '.snapshots', snapshot.digest)), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('reconnected old daemon rejects pinned input without deleting an old live session cache', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'desk-old-live-'));
  const skills = new SkillStore(join(temp, 'skills-home'));
  skills.create('parent', 'parent');
  const snapshot = collectSkillBundle(skills, ['parent'])!;
  const cache = join(skills.home, '.snapshots');
  for (let i = 0; i < 128; i++) {
    const root = join(cache, i.toString(16).padStart(64, '0'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'active'), 'keep');
  }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => socket.write(JSON.stringify({ type: 'hello', runnerId: 'local-fake', host: 'test',
      capabilities: { engines: ['codex'], close: true },
      sessions: [{ sessionId: 's', busy: true, approvals: [] }], protocolVersion: 1 }) + '\n'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new RunnerClient(() => {}, () => {}, { host: '127.0.0.1', port: (server.address() as { port: number }).port,
    token: () => 'test-token', spawnIfMissing: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const end = Date.now() + 1000;
      const poll = () => client.connected ? resolve() : Date.now() >= end ? reject(new Error('runner hello timeout')) : setTimeout(poll, 5);
      poll();
    });
    assert.throws(() => client.handle({ type: 'send', sessionId: 's', text: '계속', skills: ['parent'], skillSnapshot: snapshot }), /고정 스킬 버전/);
    assert.ok(existsSync(join(cache, '0'.repeat(64), 'active')));
    assert.ok(existsSync(join(cache, '7f'.padStart(64, '0'), 'active')));
  } finally {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});
