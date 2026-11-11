import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactFeed, IDLE_FEED_LIMIT, LIVE_FEED_LIMIT } from '../../web/src/feedCache.ts';
import { mergeEvents } from '../../web/src/posts.ts';
import type { HubEvent } from '../../web/src/types.ts';

const event = (id: number, task = 'live'): HubEvent => ({
  id, task_id: task, session_id: 'session', ts: '2026-11-10T00:00:00Z', kind: 'assistant', payload: { text: `body-${id}` },
});
const gone = new Set<string>();

test('live feed windows stay bounded and trimmed history remains pageable', () => {
  const original = { events: Array.from({ length: LIVE_FEED_LIMIT }, (_, i) => event(i + 1)), more: false };
  const recent = compactFeed({ ...original, events: mergeEvents(original.events, [event(LIVE_FEED_LIMIT + 1)]) }, LIVE_FEED_LIMIT, gone);
  assert.equal(recent.events.length, LIVE_FEED_LIMIT);
  assert.equal(recent.events[0].id, 2);
  assert.equal(recent.more, true);
  assert.equal(original.events[0].id, 1, 'do not mutate a reading snapshot');
  const earlier = compactFeed({ events: mergeEvents(recent.events, [event(1)]), more: false }, Infinity, gone);
  assert.equal(earlier.events[0].id, 1, 'explicitly reading an older page bypasses the recent-window limit');
});

test('hidden feeds drop old bodies while untouched entries preserve memo identity', () => {
  const entry = { events: Array.from({ length: LIVE_FEED_LIMIT }, (_, i) => event(i + 1)), more: false };
  const hidden = compactFeed(entry, IDLE_FEED_LIMIT, gone);
  assert.equal(hidden.events.length, IDLE_FEED_LIMIT);
  assert.equal(hidden.events[0].id, LIVE_FEED_LIMIT - IDLE_FEED_LIMIT + 1);
  assert.equal(hidden.more, true);
  assert.equal(compactFeed(hidden, IDLE_FEED_LIMIT, gone), hidden);
});

test('deleted task bodies are removed even when reading history is protected or a stale page arrives', () => {
  const deleted = new Set(['deleted']);
  const events = [event(1, 'deleted'), event(2), event(3, 'deleted')];
  const clean = compactFeed({ events, more: false }, Infinity, deleted);
  assert.deepEqual(clean.events.map(e => e.id), [2]);
  const stale = compactFeed({ events: mergeEvents(clean.events, [event(1, 'deleted'), event(4)]), more: false }, LIVE_FEED_LIMIT, deleted);
  assert.deepEqual(stale.events.map(e => e.id), [2, 4]);
});
