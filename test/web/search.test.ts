import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearch, taskSearchQuery } from '../../web/src/search.ts';
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

test('a thread search scopes a phrase to exactly its task, including quoted project names', () => {
  for (const name of ['web', 'my app', 'app "quoted"', 'app\\folder', 'app "quoted"\\folder']) {
    const project = { ...projects[0], name };
    const task = { id: 'target', project_id: project.id, project_name: name, seq: 7 } as TaskView;
    const others = [{ ...task, id: 'another', seq: 8 }, { ...task, id: 'other-project', project_id: 'p2' }];
    assert.deepEqual(parseSearch(taskSearchQuery(task) + '오래된 내용', [project, projects[1]], [task, ...others]), {
      filter: { taskIds: ['target'], query: '오래된 내용' }, unknown: [],
    });
  }
});

test('plain search text keeps literal backslashes while quoted values accept escaped quotes', () => {
  assert.equal(parseSearch('\\\\server\\folder', projects, tasks).filter.query, '\\\\server\\folder');
  assert.equal(parseSearch('"say \\"hello\\""', projects, tasks).filter.query, 'say "hello"');
});
