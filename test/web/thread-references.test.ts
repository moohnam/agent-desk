import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReferences, referenceEvents, toggleReference } from '../../web/src/threadReferences.ts';
import type { HubEvent } from '../../web/src/types.ts';

test('each thread keeps its own chosen order across storage reload and removal', () => {
  let state = toggleReference({}, 'thread-a', 90);
  state = toggleReference(state, 'thread-a', 20);
  state = toggleReference(state, 'thread-b', 70);
  state = readReferences(JSON.stringify(state));
  assert.deepEqual(state['thread-a'], { ids: [90, 20], open: false });
  assert.deepEqual(state['thread-b'], { ids: [70], open: false });
  state = toggleReference(state, 'thread-a', 90);
  state = toggleReference(state, 'thread-a', 90);
  assert.deepEqual(state['thread-a'].ids, [20, 90], 're-adding goes to the end of the reading stack');
  assert.deepEqual(state['thread-b'].ids, [70]);
  assert.equal(JSON.stringify(state).includes('payload'), false);
});

test('closing the reading window retains choices; selecting another post opens it again', () => {
  const held = { 'thread-a': { ids: [10], open: false } };
  const restored = readReferences(JSON.stringify(held));
  assert.deepEqual(restored, held);
  assert.deepEqual(toggleReference(restored, 'thread-a', 30)['thread-a'], { ids: [10, 30], open: true });
  assert.deepEqual(toggleReference(restored, 'thread-a', 10)['thread-a'], { ids: [], open: false });
});

test('damaged preferences cannot introduce invalid IDs or inherited thread keys', () => {
  for (const raw of ['null', '[]', 'wrong json', '"text"']) assert.deepEqual(readReferences(raw), {});
  const state = readReferences('{"a":{"ids":[3,3,0,-1,1.5,"4",7],"open":true},"b":null}');
  assert.deepEqual(state, { a: { ids: [3, 7], open: false } });
  assert.equal(toggleReference(state, 'a', NaN), state);
  assert.equal(toggleReference(state, 'a', -1), state);
  assert.deepEqual(toggleReference({}, 'constructor', 42).constructor, { ids: [42], open: true });
});

test('reference originals must belong to this thread and arrive whole, including old unloaded IDs', () => {
  const event = (id: number, task_id: string, clipped = false): HubEvent => ({
    id, task_id, session_id: 'session', ts: '2026-11-10T00:00:00Z', kind: 'assistant', payload: { text: 'original '+id, ...(clipped && { clipped: true }) },
  });
  const old = event(1, 'thread-a'), recent = event(900, 'thread-a');
  const found = referenceEvents('thread-a', [1, 30, 900], [old, event(30, 'thread-b'), event(900, 'thread-a', true)]);
  assert.deepEqual([...found.keys()], [1]);
  assert.equal(found.get(1), old);
  assert.deepEqual([...referenceEvents('thread-a', [1, 900], [old, recent, event(900, 'thread-a', true)]).keys()], [1, 900]);
});
