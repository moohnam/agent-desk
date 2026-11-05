import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPosts, matches, mergeEvents } from '../../web/src/posts.ts';
import type { EventKind, HubEvent, TaskView } from '../../web/src/types.ts';

let nextId = 1;
const ev = (kind: EventKind, payload: Record<string, any>, task_id = 't1'): HubEvent =>
  ({ id: nextId++, session_id: `s-${task_id}`, task_id, ts: '2026-10-29T10:00:00.000Z', kind, payload });

test('tool calls and routine status attach to the post before them', () => {
  const posts = buildPosts([
    ev('user', { text: '해 줘' }),
    ev('tool', { toolUseId: 'u1', name: 'Bash', input: {} }),
    ev('tool_result', { toolUseId: 'u1', isError: false, text: 'ok' }),
    ev('assistant', { text: '했어요' }),
    ev('status', { state: 'turn_done', detail: { num_turns: 1 } }),
  ]);
  assert.deepEqual(posts.map((p) => [p.kind, p.activity.length]), [['user', 2], ['assistant', 1]]);
});

test('an approval decision folds into its request; warnings and errors are alerts', () => {
  const posts = buildPosts([
    ev('approval', { approvalId: 'a1', toolName: 'Bash', input: {}, decision: 'pending' }),
    ev('approval', { approvalId: 'a1', toolName: 'Bash', decision: 'allowed' }),
    ev('status', { state: 'warning', detail: { message: '경고' } }),
    ev('status', { state: 'error', detail: { message: '실패' } }),
  ]);
  assert.deepEqual(posts.map((p) => p.kind), ['approval', 'alert', 'alert']);
});

test('posts of different tasks do not take each other\'s activity', () => {
  const posts = buildPosts([
    ev('user', { text: 'a' }, 't1'),
    ev('user', { text: 'b' }, 't2'),
    ev('tool', { toolUseId: 'u1', name: 'Read', input: {} }, 't1'),
  ]);
  assert.deepEqual(posts.map((p) => [p.taskId, p.activity.length]), [['t1', 1], ['t2', 0]]);
});

test('one reply resolves the whole async question batch without changing another task', () => {
  const questions = [{ title: '환경?', options: ['개발'] }, { title: '시점?', options: ['내일'] }];
  const other = ev('assistant', { text: '다른 질문', questions }, 't2');
  const ask = ev('assistant', { text: '두 질문', questions });
  const reply = ev('user', { text: '1. 개발\n\n2. 내일' });
  const posts = buildPosts([other, ask, reply]);
  assert.equal(posts[0].resolution, undefined);
  assert.equal(posts[1].resolution, reply);
  assert.equal(posts[1].event.payload.questions.length, 2);
});

test('merging keeps id order, drops duplicates and caps to the newest', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((id) => ({ ...ev('user', { text: String(id) }), id }));
  assert.deepEqual(mergeEvents([a, b], [c, d]).map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(mergeEvents([a, c], [b, c, d], 3).map((e) => e.id), [2, 3, 4]);
});

test('merging a page already held keeps the same objects, unless it brings a cut event whole', () => {
  const [a, b] = [1, 2].map((id) => ({ ...ev('tool', { name: 'Bash', clipped: true }), id }));
  const held = [a, b];
  assert.equal(mergeEvents(held, [{ ...a }, { ...b }]), held);
  const whole = { ...ev('tool', { name: 'Bash' }), id: 2 };
  const merged = mergeEvents(held, [{ ...a }, whole]);
  assert.equal(merged[0], a);
  assert.equal(merged[1], whole);
  assert.equal(mergeEvents([whole], [b])[0], whole);
});

test('a column filter matches by task, kind, status and text', () => {
  const [post] = buildPosts([ev('assistant', { text: 'Fixed the build' })]);
  const task = { id: 't1', project_id: 'p1', status: 'done', title: 'CI' } as TaskView;
  assert.ok(matches({ taskIds: ['t1'], kinds: ['assistant'], statuses: ['done'], query: 'build' }, post, task));
  assert.ok(!matches({ statuses: ['running'] }, post, task));
  assert.ok(matches({ query: 'ci' }, post, task), 'the task title counts');
  assert.ok(!matches({ query: 'deploy' }, post, task));
});
