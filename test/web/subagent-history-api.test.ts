import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../../web/src/api.ts';
import { discoverSources, eventId, scopeId } from '../../web/src/federation.ts';

test('subagent history maps remote task, session and event identities and native paging cursor', async t => {
  const calls: string[] = [], source = 'history-remote', index = 14;
  const event = { id: 7, task_id: 'task', session_id: 'session', subagent_id: 'agent:a', ts: '2026-01-01T00:00:00Z', kind: 'assistant', payload: { text: 'whole' } };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = String(input); calls.push(path);
    if (path === '/api/workspaces') return Response.json([{ id: source, view_index: index, name: source }]);
    return Response.json({ events: [event], more: true });
  });
  await discoverSources(true);
  const result = await api.subagentHistory(scopeId(source, 'task'), eventId(index, 12));
  assert.equal(calls.at(-1), `/api/workspaces/${source}/tasks/task/subagents/history?before=12`);
  assert.equal(result.more, true);
  assert.deepEqual(result.events[0], { ...event, id: eventId(index, 7), task_id: scopeId(source, 'task'), session_id: scopeId(source, 'session') });
  const local = await api.subagentHistory('task');
  assert.equal(calls.at(-1), '/api/tasks/task/subagents/history');
  assert.deepEqual(local.events[0], event);
});
