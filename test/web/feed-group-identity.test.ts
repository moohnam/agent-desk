import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleFeedGroups, groupsOf } from '../../web/src/layout.ts';
import { buildPosts, placeFeed } from '../../web/src/posts.ts';
import type { HubEvent } from '../../web/src/types.ts';
const event = (id: number, task_id = 'a') => ({ id, task_id, session_id: 'test-session', ts: '2026-01-01T00:00:00.000Z', kind: 'assistant', payload: { text: String(id) } } satisfies HubEvent);
const placed = (events: HubEvent[]) => placeFeed(buildPosts(events).reverse());
test('a sliding render window preserves the existing run key when new posts arrive', () => {
  const original = placed(Array.from({ length: 12 }, (_, i) => event(i + 1)));
  const next = placed(Array.from({ length: 13 }, (_, i) => event(i + 1)));
  const keyFor = (list: typeof original, count: number, id: number) => visibleFeedGroups(list, count).find(g => g.posts.some(p => p.post.id === id))!.key;
  assert.equal(keyFor(original, 8, 6), keyFor(next, 8, 6), 'the clipped tail run must keep its identity');
  assert.equal(keyFor(original, 8, 12), keyFor(next, 8, 12), 'a new run above must not replace an older run');
  assert.equal(keyFor(original, 8, 6), keyFor(original, 12, 6));
  assert.deepEqual(visibleFeedGroups(next, 8).flatMap(g => g.posts.map(p => p.post.id)), [13,12,11,10,9,8,7,6]);
});
test('interleaved tasks retain grouping and unique keys at every render boundary', () => {
  const full = placed([event(1),event(2),event(3,'b'),event(4),event(5),event(6,'b')]);
  for(let count = 0; count <= full.length + 1; count++) {
    const visible = visibleFeedGroups(full, count);
    assert.deepEqual(visible.map(g=>g.posts), groupsOf(full.slice(0,count)));
    assert.equal(new Set(visible.map(g=>g.key)).size, visible.length);
  }
});
