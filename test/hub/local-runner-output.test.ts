import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import type { RunnerMessageListener } from '../../hub/src/runner/client.ts';
import { LocalRunnerOutbox } from '../../hub/src/runner/local-outbox.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import type { RunnerToHub } from '../../shared/protocol.ts';

const output = (text: string, sessionId = 'session'): RunnerToHub =>
  ({ type: 'event', sessionId, event: { kind: 'assistant', text } });
const busy: RunnerToHub = { type: 'busy', sessionId: 'session', busy: false };

test('the session ID survives when a previous output could not be acknowledged', () => {
  const outbox = new LocalRunnerOutbox();
  const first = outbox.enqueue(output('first')).entry;
  const session: RunnerToHub = { type: 'engine_session', sessionId: 'session', engineSessionId: 'engine-id' };
  const identity = outbox.enqueue(session).entry;
  outbox.flush(true, () => true);
  const replayed: unknown[] = [];
  outbox.flush(true, line => { replayed.push(JSON.parse(line)); return true; });
  assert.deepEqual(replayed, [
    { type: 'output', sequence: first.sequence, message: output('first') },
    { type: 'output', sequence: identity.sequence, message: session },
  ]);
});

test('reconnecting replays only unconfirmed outputs and keeps the legacy packet format', () => {
  const outbox = new LocalRunnerOutbox();
  const first = outbox.enqueue(output('first')).entry;
  outbox.enqueue(busy);
  const second = outbox.enqueue(output('second')).entry;
  const packets: unknown[] = [];
  const write = (line: string) => { packets.push(JSON.parse(line)); return true; };
  assert.equal(outbox.flush(true, write), second.sequence);
  assert.deepEqual(packets.splice(0), [
    { type: 'output', sequence: first.sequence, message: output('first') }, busy,
    { type: 'output', sequence: second.sequence, message: output('second') },
  ]);
  outbox.acknowledge(first.sequence);
  assert.equal(outbox.flush(true, write), second.sequence);
  assert.deepEqual(packets.splice(0), [{ type: 'output', sequence: second.sequence, message: output('second') }]);
  assert.equal(outbox.flush(false, write), second.sequence);
  assert.deepEqual(packets.splice(0), [output('second')]);
  assert.equal(outbox.flush(true, write), 0);
  assert.deepEqual(packets, []);
});

test('the outbox keeps control messages ahead of evictable output when full', () => {
  const outbox = new LocalRunnerOutbox(2, 512);
  outbox.enqueue(output('old'));
  outbox.enqueue(busy);
  const retained = outbox.enqueue(output('retained'));
  assert.equal(retained.dropped, true);
  assert.equal(outbox.enqueue(output('큰'.repeat(200))).dropped, true, 'bounds UTF-8 bytes without evicting other records');
  const packets: unknown[] = [];
  outbox.flush(true, line => { packets.push(JSON.parse(line)); return true; });
  assert.deepEqual(packets, [busy, { type: 'output', sequence: retained.entry.sequence, message: output('retained') }]);
  outbox.acknowledge(retained.entry.sequence);
  assert.equal(outbox.flush(true, () => assert.fail('oversized offline output should have been dropped')), 0);
});

test('draining a slow connection sends the remaining outputs in order without resending earlier writes', () => {
  const outbox = new LocalRunnerOutbox();
  const first = outbox.enqueue(output('first')).entry;
  outbox.enqueue(busy);
  const other = outbox.enqueue(output('later')).entry;
  const packets: unknown[] = [];
  const through = outbox.flush(true, line => { packets.push(JSON.parse(line)); return false; });
  assert.equal(through, first.sequence);
  assert.deepEqual(packets.splice(0), [{ type: 'output', sequence: first.sequence, message: output('first') }]);
  assert.equal(outbox.flush(true, line => { packets.push(JSON.parse(line)); return true; }, through), other.sequence);
  assert.deepEqual(packets, [busy, { type: 'output', sequence: other.sequence, message: output('later') }]);
});

test('local output and its receipt roll back together and survive an authority restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-output-'));
  const runnerId = 'local-fixture';
  function open() {
    const store = new Store(join(dir, 'desk.db'));
    let receive!: RunnerMessageListener;
    const hub = new Hub(store, { skills: new SkillStore(join(dir, 'skills')), runner: handler => {
      receive = handler;
      return { connected: true, id: runnerId, engines: new Set(['claude']), has: () => true, handle() {} };
    } });
    return { hub, store, receive, close: () => { hub.dispose(); store.database.close(); } };
  }
  let authority: ReturnType<typeof open> | undefined;
  try {
    authority = open();
    const task = authority.hub.compose(`@fixture:${dir} #claude first`);
    const session = authority.store.latestSession(task.id)!;
    const message = output('durable output', session.id);
    const receipt = { runnerId, stream: 'daemon-one', sequence: 7 };
    const store = authority.store;
    const addEvent = store.addEvent.bind(store);
    store.addEvent = (...args) => {
      addEvent(...args);
      throw new Error('injected failure after the event insert');
    };
    assert.throws(() => authority!.receive(message, receipt), /injected failure/);
    assert.equal(store.listEvents(task.id).filter(e => e.kind === 'assistant').length, 0);
    store.addEvent = addEvent;
    authority.receive(message, receipt);
    authority.close();
    authority = undefined;
    authority = open();
    authority.receive(message, receipt);
    authority.receive(output('from a new daemon', session.id), { ...receipt, stream: 'daemon-two', sequence: 1 });
    assert.deepEqual(authority.store.listEvents(task.id).filter(e => e.kind === 'assistant').map(e => (e.payload as { text: string }).text),
      ['durable output', 'from a new daemon']);
  } finally {
    authority?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
