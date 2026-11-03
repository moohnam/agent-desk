import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOrder, defaultColumn, viewColumnLimit, viewColumns, VIEW_MAX } from '../../web/src/views.ts';
import type { Project, TaskView } from '../../web/src/types.ts';

const date = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;
const projects: Project[] = Array.from({ length: 26 }, (_, i) => ({
  id: `p${i + 1}`, name: `project-${i + 1}`, root_path: '/tmp', created_at: date(i + 1),
}));
const tasks = new Map(Array.from({ length: 25 }, (_, i) => {
  const t = { id: `t${i + 1}`, project_id: `p${i + 1}`, project_name: `project-${i + 1}`, seq: 1,
    title: `task-${i + 1}`, created_at: date(i + 1), updated_at: date(i + 1), status: 'done', background: [] } as unknown as TaskView;
  return [t.id, t];
}));
const cols = (view: 'project' | 'task', data = tasks, limit = VIEW_MAX) =>
  viewColumns(view, data, projects, new Set(), new Set(), {}, limit);

test('project finder includes hidden metadata and expands only through the selected project', () => {
  assert.equal(cols('project').length, 12);
  const all = cols('project', tasks, Infinity);
  assert.equal(all.length, 25, 'a project without tasks is not a column');
  const id = all[19].id;
  assert.ok(!cols('project').some((c) => c.id === id));
  const limit = viewColumnLimit('project', id, tasks, projects, VIEW_MAX);
  assert.equal(limit, 20);
  assert.ok(cols('project', tasks, limit!).some((c) => c.id === id));
  assert.ok(!cols('project', tasks, limit! - 1).some((c) => c.id === id));
  assert.ok(applyOrder(cols('project', tasks, limit!), 'name', () => '').some((c) => c.id === id));
});

test('task finder uses membership priority even when a hidden task is first in full display order', () => {
  const data = new Map([...tasks].map(([id, t], i) => [id, i < 14 ? { ...t, status: 'running' as const } : t]));
  const id = 'v:t:t25'; // Newest activity, but fourteen running tasks are selected before it.
  assert.equal(cols('task', data, Infinity)[0].id, id);
  assert.ok(!cols('task', data).some((c) => c.id === id));
  const limit = viewColumnLimit('task', id, data, projects, VIEW_MAX);
  assert.equal(limit, 15);
  assert.ok(cols('task', data, limit!).some((c) => c.id === id));
  assert.ok(!cols('task', data, limit! - 1).some((c) => c.id === id));
});

test('finding an already included column never shrinks the limit; missing targets do not expand it', () => {
  assert.equal(viewColumnLimit('task', 'v:t:t25', tasks, projects, 24), 24);
  assert.equal(viewColumnLimit('task', 'v:t:t25', tasks, projects, 36), 36);
  assert.equal(viewColumnLimit('task', 'v:t:deleted', tasks, projects, 12), null);
  assert.equal(viewColumnLimit('project', 'v:p:p26', tasks, projects, 12), null);
  assert.equal(viewColumnLimit('project', 'v:p:p1', new Map(), [], 12), null);
  assert.equal(viewColumnLimit('custom', 'all', tasks, projects, 12), null);
  assert.equal(viewColumnLimit('status', 'v:s:run', tasks, projects, 12), null);
});

test('every view defaults to its first populated column, waiting for earlier feeds to finish', () => {
  for (const prefix of ['custom', 'v:p', 'v:t', 'v:s']) {
    const cols = [{ id: `${prefix}:empty`, posts: [] }, { id: `${prefix}:first`, posts: [{}] }, { id: `${prefix}:later`, posts: [{}] }];
    assert.equal(defaultColumn(cols, () => true), `${prefix}:first`);
    assert.equal(defaultColumn(cols, (id) => id !== `${prefix}:empty`), undefined);
    assert.equal(defaultColumn(cols.slice(1), () => false), `${prefix}:first`, 'cached content needs no extra wait');
  }
  assert.equal(defaultColumn([], () => true), null);
  assert.equal(defaultColumn([{ id: 'empty', posts: [] }], () => true), null);
});
