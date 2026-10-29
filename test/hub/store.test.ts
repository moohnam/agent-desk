import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventKind } from '../../shared/events.ts';
import { Store } from '../../hub/src/db.ts';
import { buildPosts } from '../../web/src/posts.ts';
import type { HubEvent } from '../../web/src/types.ts';

const TS = '2026-10-29T10:00:00.000Z';

/** A store with one project and one task (and its session) per id in `tasks`. */
function store(tasks = ['t1']) {
  const s = new Store(':memory:');
  s.createProject({ id: 'p1', name: 'web', root_path: '/tmp/web', created_at: TS });
  for (const id of tasks) {
    s.createTask({ id, project_id: 'p1', title: id, status: 'running', checkpoint_md: null, created_by: 'me', created_at: TS, updated_at: TS });
    s.createSession({
      id: `s-${id}`, task_id: id, engine: 'claude', engine_session_id: null, cwd: '/tmp/web', source: 'app', status: 'running',
      runner_id: 'r', created_at: TS, permission_mode: 'default', model: null, effort: null,
    });
  }
  return s;
}

/** One of each event shape a task records, posts and the events that fold into them. */
const EVENTS: [EventKind, Record<string, unknown>][] = [
  ['user', { text: '해 줘' }],
  ['status', { kind: 'status', state: 'started', detail: {} }],
  ['tool', { kind: 'tool', toolUseId: 'u1', name: 'Bash', input: {} }],
  ['tool_result', { kind: 'tool_result', toolUseId: 'u1', isError: false, text: 'ok' }],
  ['approval', { approvalId: 'a1', toolName: 'Bash', input: {}, decision: 'pending' }],
  ['approval', { approvalId: 'a1', toolName: 'Bash', decision: 'allowed' }],
  ['assistant', { kind: 'assistant', text: '했어요' }],
  ['status', { kind: 'status', state: 'warning', detail: { message: '경고' } }],
  ['status', { kind: 'status', state: 'turn_done', detail: { num_turns: 2 } }],
  ['question', { questionId: 'q1', text: '어느 쪽?', decision: 'pending' }],
  ['question', { questionId: 'q1', decision: 'answered', answer: '왼쪽' }],
  ['status', { kind: 'status', state: 'error', detail: { message: '실패' } }],
  ['status', { kind: 'status', state: 'interrupted' }],
  ['status', { kind: 'status', state: 'queue_dropped', detail: { message: '버림', texts: ['x'] } }],
  ['status', { kind: 'status', state: 'mode', detail: { mode: 'auto' } }],
  ['update', { text: '진행 상황' }],
];

test('the hub counts as posts exactly the events the web makes posts of', () => {
  const s = store();
  for (const [kind, payload] of EVENTS) s.addEvent('s-t1', 't1', kind, payload);
  const events = s.listFeed() as unknown as HubEvent[];
  assert.equal(events.length, EVENTS.length);
  assert.equal(s.countFeed().posts, buildPosts(events).length);
});

test('feed filters narrow by task and by search text', () => {
  const s = store(['t1', 't2']);
  s.addEvent('s-t1', 't1', 'user', { text: 'alpha' });
  s.addEvent('s-t2', 't2', 'user', { text: 'beta' });
  s.addEvent('s-t2', 't2', 'assistant', { kind: 'assistant', text: 'alpha too' });
  assert.deepEqual(s.listFeed(100, undefined, { taskIds: ['t2'] }).map((e) => e.task_id), ['t2', 't2']);
  assert.deepEqual(s.listFeed(100, undefined, { q: 'alpha' }).map((e) => (e.payload as { text: string }).text), ['alpha', 'alpha too']);
  assert.deepEqual({ ...s.countFeed({ q: 'alpha' }) }, { posts: 2, tasks: 2 });
});

test('deleting a task removes its events, sessions and the requests it asked', () => {
  const s = store(['t1', 't2']);
  s.addEvent('s-t1', 't1', 'user', { text: 'x' });
  s.createRequest({
    id: 'r1', from_task_id: 't1', from_session_id: 's-t1', to_task_id: 't2', to_session_id: 's-t2', text: '?', status: 'approval',
    answer: null, approval_id: null, queued_id: null, prompt_event_id: null, created_at: TS, answered_at: null,
  });
  s.deleteTasks(['t1']);
  assert.equal(s.getTask('t1'), undefined);
  assert.deepEqual(s.listSessions('t1'), []);
  assert.deepEqual(s.listEvents('t1'), []);
  assert.equal(s.getRequest('r1'), undefined);
  assert.ok(s.getTask('t2'));
});

test('task numbers count up per project', () => {
  const s = store(['t1', 't2']);
  assert.deepEqual([s.getTask('t1')?.seq, s.getTask('t2')?.seq], [1, 2]);
  assert.equal(s.taskBySeq('p1', 2)?.id, 't2');
});
