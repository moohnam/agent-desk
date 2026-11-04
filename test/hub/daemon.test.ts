import { ENGINES } from '../../shared/compose.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { PROTOCOL_VERSION, checkHubToRunner, checkRunnerToHub } from '../../shared/protocol.ts';
import { runnerToken } from '../../hub/src/runner/wire.ts';

// A real runner daemon on a spare port with its own token and pid files, so the handshake is tested
// as the hub meets it. No session is started: no engine runs.
const dir = mkdtempSync(join(tmpdir(), 'desk-daemon-'));
const port = 40000 + Math.floor(Math.random() * 20000);
const tokenFile = join(dir, 'runner-token');
let daemon: ChildProcess;

before(async () => {
  daemon = spawn(process.execPath, [resolve(import.meta.dirname, '../../hub/src/runner/daemon.ts')], {
    env: { ...process.env, RUNNER_PORT: String(port), RUNNER_TOKEN_FILE: tokenFile, RUNNER_PID_FILE: join(dir, 'pid') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((res) => {
      const s = connect(port, '127.0.0.1', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon did not start');
});

after(() => { daemon.kill(); rmSync(dir, { recursive: true, force: true }); });

/** A connection that sends `first` and collects what comes back until it closes or `ms` passes. */
function session(first: unknown) {
  const lines: any[] = [];
  let closed = false;
  const socket: Socket = connect(port, '127.0.0.1', () => socket.write(JSON.stringify(first) + '\n'));
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i))); });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => {});
  return { lines, socket, get closed() { return closed; }, wait: (ms = 300) => new Promise((r) => setTimeout(r, ms)) };
}

test('the token file is made readable by this user only', () => {
  assert.equal(runnerToken(tokenFile).length, 64);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
});

test('a hub with the token gets the hello with the version and engines', async () => {
  const s = session({ type: 'auth', token: runnerToken(tokenFile), protocolVersion: PROTOCOL_VERSION });
  await s.wait();
  assert.equal(s.lines[0]?.type, 'hello');
  assert.equal(s.lines[0].protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(s.lines[0].capabilities.engines, ENGINES);
  s.socket.destroy();
});

test('a connection without the token is dropped and leaves the hub connected', async () => {
  const hub = session({ type: 'auth', token: runnerToken(tokenFile), protocolVersion: PROTOCOL_VERSION });
  await hub.wait();
  const intruder = session({ type: 'start', sessionId: 's1', engine: 'claude', cwd: '/tmp', prompt: 'x', permissionMode: 'auto' });
  const wrong = session({ type: 'auth', token: 'x'.repeat(64), protocolVersion: PROTOCOL_VERSION });
  await hub.wait();
  assert.ok(intruder.closed && wrong.closed);
  assert.deepEqual(intruder.lines, []);
  assert.ok(!hub.closed, 'the hub keeps its connection');
  hub.socket.destroy();
});

test('a second hub with the token replaces the first', async () => {
  const auth = { type: 'auth', token: runnerToken(tokenFile), protocolVersion: PROTOCOL_VERSION };
  const first = session(auth);
  await first.wait();
  const second = session(auth);
  await second.wait();
  assert.ok(first.closed);
  assert.equal(second.lines[0]?.type, 'hello');
  second.socket.destroy();
});

test('malformed commands and runner messages are named, not passed on', () => {
  assert.equal(typeof checkHubToRunner({ type: 'start', sessionId: 's', engine: 'claude', cwd: 'rel', prompt: '', permissionMode: 'auto' }), 'string');
  assert.equal(typeof checkHubToRunner({ type: 'set_mode', sessionId: 's', permissionMode: 'yolo' }), 'string');
  assert.equal(typeof checkHubToRunner({ type: 'nope', sessionId: 's' }), 'string');
  assert.equal(typeof checkHubToRunner({ type: 'send', sessionId: 's', text: 'hi' }), 'object');
  assert.equal(typeof checkRunnerToHub({ type: 'busy', sessionId: 's', busy: 'yes' }), 'string');
  assert.equal(typeof checkRunnerToHub({ type: 'hello', runnerId: 'r', sessions: [], capabilities: {} }), 'string');
  assert.equal(typeof checkRunnerToHub({ type: 'event', sessionId: 's', event: { kind: 'assistant', text: 'hi' } }), 'object');
});
