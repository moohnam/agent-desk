import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openReferenceFile, readReferences, referenceEvents, referenceOrder, toggleReference } from '../../web/src/threadReferences.ts';
import type { HubEvent } from '../../web/src/types.ts';

test('each thread keeps its own chosen order across storage reload and removal', () => {
  let state = toggleReference({}, 'thread-a', 90);
  state = toggleReference(state, 'thread-a', 20);
  state = toggleReference(state, 'thread-b', 70);
  state = readReferences(JSON.stringify(state));
  assert.deepEqual(state['thread-a'].ids, [20, 90]);
  assert.equal(state['thread-a'].open, false);
  assert.deepEqual(referenceOrder(state['thread-b']), [{ kind: 'event', id: 70 }]);
  state = toggleReference(state, 'thread-a', 90);
  state = toggleReference(state, 'thread-a', 90);
  assert.deepEqual(state['thread-a'].ids, [90, 20], 're-adding goes to the top of the reading stack');
  assert.deepEqual(state['thread-b'].ids, [70]);
  assert.equal(JSON.stringify(state).includes('payload'), false);
});

test('closing the reading window retains choices; selecting another post opens it again', () => {
  const held = { 'thread-a': { ids: [10], open: false } };
  const restored = readReferences(JSON.stringify(held));
  assert.deepEqual(restored, held);
  assert.deepEqual(toggleReference(restored, 'thread-a', 30)['thread-a'], { ids: [30, 10], order: [{kind:'event',id:30},{kind:'event',id:10}], open: true });
  assert.deepEqual(toggleReference(restored, 'thread-a', 10)['thread-a'], { ids: [], order: [], open: false });
});

test('damaged preferences cannot introduce invalid IDs or inherited thread keys', () => {
  for (const raw of ['null', '[]', 'wrong json', '"text"']) assert.deepEqual(readReferences(raw), {});
  const state = readReferences('{"a":{"ids":[3,3,0,-1,1.5,"4",7],"open":true},"b":null}');
  assert.deepEqual(state, { a: { ids: [3, 7], open: false } });
  assert.equal(toggleReference(state, 'a', NaN), state);
  assert.equal(toggleReference(state, 'a', -1), state);
  assert.deepEqual(toggleReference({}, 'constructor', 42).constructor, { ids: [42], order: [{kind:'event',id:42}], open: true });
});

test('files and posts form one recent-choice stack and reopening a file never duplicates it', () => {
  let state = openReferenceFile({}, 'a', '/one.md');
  state = toggleReference(state, 'a', 10);
  state = openReferenceFile(state, 'a', '/two.html');
  state = openReferenceFile(state, 'a', '/one.md');
  const expected = [{kind:'file',href:'/one.md'},{kind:'file',href:'/two.html'},{kind:'event',id:10}];
  assert.deepEqual(referenceOrder(state.a), expected);
  assert.deepEqual(state.a.files, ['/one.md', '/two.html']);
  assert.deepEqual(referenceOrder(readReferences(JSON.stringify(state)).a), expected);
  state = toggleReference(state, 'a', 10);
  assert.deepEqual(referenceOrder(state.a), expected.slice(0, 2));
});

test('old preferences preserve their displayed order and invalid order entries cannot restore removed data', () => {
  const old = readReferences(JSON.stringify({a:{ids:[1,2],files:['/old.md','/older.md'],open:true}}));
  assert.deepEqual(referenceOrder(old.a), [{kind:'file',href:'/old.md'},{kind:'file',href:'/older.md'},{kind:'event',id:1},{kind:'event',id:2}]);
  const corrupt = readReferences(JSON.stringify({a:{ids:[1],files:['/a.md'],order:[null,{kind:'file',href:'/gone.md'},{kind:'event',id:2},{kind:'file',href:'/a.md'},{kind:'file',href:'/a.md'}]}}));
  assert.deepEqual(referenceOrder(corrupt.a), [{kind:'file',href:'/a.md'},{kind:'event',id:1}]);
  let state = old;
  for (let n=0; n<22; n++) state=openReferenceFile(state,'a',`/${n}.md`);
  assert.equal(state.a.files?.length,20);
  assert.equal(referenceOrder(state.a).filter(entry=>entry.kind==='file').length,20);
  assert.deepEqual(state.a.files?.slice(0,2), ['/21.md','/20.md']);
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
