import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearch } from '../../web/src/search.ts';
import type { Project, TaskView } from '../../web/src/types.ts';

const projects: Project[] = [{ id: 'p1', name: 'web', root_path: '/w', created_at: '' }, { id: 'p2', name: 'Hub', root_path: '/h', created_at: '' }];
const tasks = [{ id: 't1', project_id: 'p1', seq: 2 }] as TaskView[];

test('filters by #key:value (names case-blind, Korean labels too), the rest is the phrase', () => {
  assert.deepEqual(parseSearch('#project:hub #status:실행중 #kind:질문 빌드 실패', projects, tasks), {
    filter: { projectIds: ['p2'], statuses: ['running'], kinds: ['question'], query: '빌드 실패' }, unknown: [],
  });
  assert.deepEqual(parseSearch('#task:web#2', projects, tasks).filter, { taskIds: ['t1'] });
});

test('a filter naming nothing known is reported, not applied', () => {
  assert.deepEqual(parseSearch('#project:nope #status:x', projects, tasks), { filter: {}, unknown: ['#project:nope', '#status:x'] });
});
