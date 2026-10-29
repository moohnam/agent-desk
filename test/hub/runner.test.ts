import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineAdapter, HubToRunner, RunnerToHub } from '../../hub/src/runner/protocol.ts';
import { Runner } from '../../hub/src/runner/runner.ts';

type Start = NonNullable<ConstructorParameters<typeof Runner>[2]>['start'];

const start = (sessionId: string, engine = 'claude'): HubToRunner =>
  ({ type: 'start', sessionId, engine: engine as 'claude', cwd: '/tmp', prompt: 'hi', permissionMode: 'default' });

/** A runner whose sessions run `adapter`; `emit` is what the adapter can send. */
function setup(adapter: Partial<EngineAdapter> = {}, idleMs = 60_000) {
  const out: RunnerToHub[] = [];
  let emit!: Parameters<NonNullable<Start>>[0]['emit'];
  const fake: Start = (o) => {
    emit = o.emit;
    return {
      send() {}, interrupt: async () => {}, setMode: async () => {}, setModel: async () => {}, resolveApproval() {}, close() {},
      ...adapter,
    };
  };
  const runner = new Runner('test', (m) => out.push(m), { idleMs, start: fake });
  return { runner, out, emit: (m: RunnerToHub) => emit(m) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('an engine the runner does not know closes the session instead of running another engine', () => {
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m));
  runner.handle(start('s1', 'gemini'));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'closed');
  assert.match((out[0] as { error?: string }).error ?? '', /gemini/);
  assert.deepEqual(runner.snapshot(), []);
});

test('an adapter that throws on start closes its session', () => {
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m), { start: () => { throw new Error('boom'); } });
  runner.handle(start('s1'));
  assert.deepEqual(out, [{ type: 'closed', sessionId: 's1', busy: false, error: 'boom' }]);
  assert.deepEqual(runner.snapshot(), []);
});

test('a rejected interrupt becomes a warning on the session, not an unhandled rejection', async () => {
  const { runner, out } = setup({ interrupt: () => Promise.reject(new Error('turn ended')) });
  runner.handle(start('s1'));
  runner.handle({ type: 'interrupt', sessionId: 's1' });
  await tick();
  assert.deepEqual(out, [{
    type: 'event', sessionId: 's1', event: { kind: 'status', state: 'warning', detail: { message: '중단 실패: turn ended' } },
  }]);
});

test('approvals are tracked for a reconnecting hub until answered', () => {
  const answered: string[] = [];
  const { runner, emit } = setup({ resolveApproval: (id) => { answered.push(id); } });
  runner.handle(start('s1'));
  emit({ type: 'busy', sessionId: 's1', busy: true });
  emit({ type: 'approval_request', sessionId: 's1', approvalId: 'a1', toolName: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(runner.snapshot(), [{
    sessionId: 's1', busy: true, approvals: [{ approvalId: 'a1', toolName: 'Bash', input: { command: 'ls' } }],
  }]);
  runner.handle({ type: 'approval_result', sessionId: 's1', approvalId: 'a1', allow: true });
  assert.deepEqual(answered, ['a1']);
  assert.deepEqual(runner.snapshot()[0].approvals, []);
});

test('an idle session is closed after the idle time; a busy one is not', async () => {
  const { runner, out, emit } = setup({}, 20);
  runner.handle(start('idle'));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(out, [{ type: 'closed', sessionId: 'idle', busy: false, reason: 'idle' }]);

  out.length = 0;
  runner.handle(start('busy'));
  emit({ type: 'busy', sessionId: 'busy', busy: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(out.filter((m) => m.type === 'closed'), []);
});

test('closed reports whether the session ended mid-turn', () => {
  const { runner, out, emit } = setup();
  runner.handle(start('s1'));
  emit({ type: 'busy', sessionId: 's1', busy: true });
  emit({ type: 'closed', sessionId: 's1' });
  assert.deepEqual(out.at(-1), { type: 'closed', sessionId: 's1', busy: true });
  assert.deepEqual(runner.snapshot(), []);
});

test('a replaced session\'s later messages are dropped', () => {
  const emits: ((m: RunnerToHub) => void)[] = [];
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m), { start: (o) => {
    emits.push(o.emit);
    return { send() {}, interrupt: async () => {}, setMode: async () => {}, setModel: async () => {}, resolveApproval() {}, close() {} };
  } });
  runner.handle(start('s1'));
  runner.handle(start('s1'));
  emits[0]({ type: 'busy', sessionId: 's1', busy: true });
  assert.deepEqual(out, []);
  emits[1]({ type: 'busy', sessionId: 's1', busy: true });
  assert.deepEqual(out, [{ type: 'busy', sessionId: 's1', busy: true }]);
});
