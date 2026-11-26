import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, type Session } from '../../hub/src/db.ts';
import { Subagents } from '../../hub/src/subagents.ts';
import { workspaceApi, workspaceRoute } from '../../hub/src/workspace-api.ts';
import type { Hub } from '../../hub/src/hub.ts';
import type { SubagentStatus } from '../../shared/protocol.ts';

function fixture() {
  const store = new Store(':memory:');
  store.database.exec('PRAGMA foreign_keys = OFF');
  const subagents = new Subagents(store, () => {});
  const session = (id: string, task_id = 'task') => ({ id, task_id }) as Session;
  const report = (s: Session, id: string, status: SubagentStatus, type = 'agent') =>
    subagents.report(s, { id, status, type, description: id });
  const event = (s: Session, id: string, sourceId = 'source') =>
    subagents.event(s, id, { kind: 'assistant', text: id, sourceId });
  return { store, subagents, session, report, event };
}

test('task subagent history joins identities, filters commands and running agents, and follows current state', () => {
  const f = fixture();
  try {
    const a = f.session('a'), b = f.session('b'), other = f.session('other', 'other-task');
    for (const status of ['completed', 'failed', 'stopped', 'ended', 'unknown', 'running'] as const) {
      f.report(a, status, status); f.event(a, status); f.event(a, status);
    }
    f.report(b, 'completed', 'running'); f.event(b, 'completed');
    f.report(other, 'completed', 'completed'); f.event(other, 'completed');
    for (const type of ['shell', 'local_bash']) { f.report(a, type, 'completed', type); f.event(a, type); }
    let page = f.subagents.history('task');
    assert.deepEqual(page.events.map(e => e.subagent_id), ['completed', 'failed', 'stopped', 'ended', 'unknown']);
    assert.ok(page.events.every(e => e.session_id === 'a' && e.task_id === 'task'));
    assert.equal(page.more, false);
    const stored = f.store.database.prepare('SELECT count(*) AS n FROM subagent_event').get();
    f.report(a, 'completed', 'running');
    assert.ok(!f.subagents.history('task').events.some(e => e.subagent_id === 'completed'));
    f.report(b, 'completed', 'ended');
    assert.equal(f.subagents.history('task').events.at(-1)?.session_id, 'b');
    f.report(a, 'completed', 'stopped');
    page = f.subagents.history('task');
    assert.equal(page.events.filter(e => e.subagent_id === 'completed').length, 2);
    assert.deepEqual(f.store.database.prepare('SELECT count(*) AS n FROM subagent_event').get(), stored, 'state changes do not copy or delete steps');
    assert.equal(f.subagents.history('other-task').events.length, 1);
    assert.deepEqual(f.subagents.history('missing'), { events: [], more: false });
  } finally { f.store.database.close(); }
});

test('workspace history API shares local and remote routing and pages 500 whole events without duplicates', () => {
  const f = fixture();
  try {
    const s = f.session('a');
    f.report(s, 'agent:a', 'completed');
    for (let i = 0; i < 1001; i++) f.event(s, 'agent:a', String(i));
    const hub = { subagents: f.subagents } as Hub;
    const path = '/tasks/task/subagents/history';
    assert.equal(workspaceRoute('GET', path), 'GET /tasks/:id/subagents/history');
    const get = (query = '') => workspaceApi(hub, 'GET', new URL('http://x' + path + query));
    const latest = get();
    assert.equal(latest.status, 200);
    assert.equal(latest.body.events.length, 500); assert.equal(latest.body.more, true);
    const middle = get('?before=' + latest.body.events[0].id).body;
    const oldest = get('?before=' + middle.events[0].id).body;
    assert.equal(middle.events.length, 500); assert.equal(middle.more, true);
    assert.equal(oldest.events.length, 1); assert.equal(oldest.more, false);
    assert.deepEqual([...oldest.events, ...middle.events, ...latest.body.events].map(e => e.id),
      Array.from({ length: 1001 }, (_, i) => i + 1));
    assert.deepEqual(get('?before=1').body, { events: [], more: false });
    for (const cursor of ['-1', '0', '1.5', 'NaN', '9007199254740992']) assert.throws(() => get('?before=' + cursor), /before/);
  } finally { f.store.database.close(); }
});
