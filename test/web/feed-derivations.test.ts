import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeedLayout, createModelLookup } from '../../web/src/feedDerivations.ts';
import { modelsOf, newestPerTask } from '../../web/src/layout.ts';
import { buildPosts, matches, placeFeed } from '../../web/src/posts.ts';
import type { ColumnDef, HubEvent, TaskView } from '../../web/src/types.ts';
const task = (id: string, extra: Partial<TaskView> = {}) => ({id, title: 'Alpha', project_id: 'p', status: 'running', ...extra} as TaskView);
const event = (id: number, task_id = 'a', payload = {text: 'hello'} as Record<string, any>, kind = 'assistant') =>
  ({id, task_id, kind, payload} as HubEvent);
const posts = buildPosts([event(1), event(2, 'b'), event(3), event(4)]).reverse();
const base: ColumnDef = {id: 'all', title: 'All', filter: {}};

test('unchanged posts reuse placement across unrelated task and header updates', () => {
  const layout = createFeedLayout(), tasks = new Map([['a', task('a')], ['b', task('b')]]);
  const first = layout(posts, base, tasks);
  assert.deepEqual(first, placeFeed(posts));
  tasks.set('a', task('a', {status: 'done', title: 'renamed'}));
  assert.equal(layout(posts, {...base, title: 'Renamed column'}, tasks), first);
  assert.notEqual(layout([...posts], base, tasks), first);
});

test('filter-dependent task changes invalidate layout, including deletion and title search', () => {
  const layout = createFeedLayout(), tasks = new Map([['a', task('a')], ['b', task('b')]]);
  for (const filter of [{statuses: ['running']}, {projectIds: ['p']}, {query: 'alpha'}] as ColumnDef['filter'][]) {
    tasks.set('a', task('a')); tasks.set('b', task('b'));
    const def = {...base, filter};
    const first = layout(posts, def, tasks);
    tasks.set('a', task('a', {engine: 'codex'}));
    tasks.set('unrelated', task('unrelated', {status: 'done'}));
    assert.equal(layout(posts, def, tasks), first);
    tasks.set('a', task('a', {status: 'done', project_id: 'other', title: 'Beta'}));
    assert.deepEqual(layout(posts, def, tasks), placeFeed(posts.filter(p => matches(filter, p, tasks.get(p.taskId)))));
    tasks.delete('b');
    assert.deepEqual(layout(posts, def, tasks), placeFeed(posts.filter(p => matches(filter, p, tasks.get(p.taskId)))));
    tasks.set('b', task('b'));
    assert.deepEqual(layout(posts, def, tasks), placeFeed(posts.filter(p => matches(filter, p, tasks.get(p.taskId)))));
  }
});

test('filter edits, grouping, input replacement and overlapping column filters preserve placement', () => {
  const layout = createFeedLayout(), tasks = new Map([['a', task('a')], ['b', task('b')]]);
  const filters: ColumnDef['filter'][] = [{}, {taskIds: ['a']}, {kinds: ['user']}, {query: 'hello'}, {query: 'alpha'}, {statuses: ['done']}, {projectIds: ['p']}];
  for (let i = 0; i < 100; i++) {
    const filter = filters[i % filters.length], byTask = i % 2 === 0;
    tasks.set('a', task('a', {status: i % 3 === 0 ? 'done' : 'running'}));
    const input = i % 5 === 0 ? buildPosts([event(i + 10, 'a', {text: 'changed'}), event(i + 11, 'b')]).reverse() : posts;
    const wanted = input.filter(p => matches(filter, p, tasks.get(p.taskId)));
    assert.deepEqual(layout(input, {...base, filter, byTask}, tasks), byTask ? newestPerTask(wanted) : placeFeed(wanted));
  }
});

test('model cache preserves list precedence, updates and removals without retaining stale models', () => {
  const lookup = createModelLookup();
  const a = [event(1, 'a', {state: 'started', detail: {model: 'one'}}, 'status')];
  const b = [event(2, 'a', {state: 'model_changed', detail: {model: 'two'}}, 'status')];
  const first = lookup(a, b);
  assert.deepEqual(first, modelsOf(a, b));
  assert.equal(lookup(a, b, [event(3)]), first);
  assert.deepEqual(lookup(b, a), modelsOf(b, a));
  const replaced = [event(1, 'b', {state: 'started', detail: {model: 'other'}}, 'status')];
  assert.deepEqual(lookup(replaced), modelsOf(replaced));
  assert.deepEqual(lookup(), new Map());
  assert.deepEqual(first, new Map([['a', 'two']]), 'published results stay immutable');
});

test('shared query results keep both ordinary and grouped column layouts', () => {
  const layout=createFeedLayout(),tasks=new Map([['a',task('a')],['b',task('b')]]);
  const ordinary=layout(posts,base,tasks),grouped=layout(posts,{...base,byTask:true},tasks);
  assert.equal(layout(posts,base,tasks),ordinary);
  assert.equal(layout(posts,{...base,byTask:true},tasks),grouped);
});
