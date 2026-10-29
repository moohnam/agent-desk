import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedParams, parseFeedParams } from '../../shared/api.ts';
import { ENGINES, ENGINE_MODELS, MODEL_TAGS, RESERVED_TAGS, TAG_HELP, effortNote, modelEngine, modelTagsOf } from '../../shared/compose.ts';

test('every built-in tag has a help line, and no other tag does', () => {
  assert.deepEqual(TAG_HELP.map((t) => t.tag).sort(), [...RESERVED_TAGS].sort());
});

test('each model belongs to exactly one engine', () => {
  for (const m of MODEL_TAGS) assert.equal(ENGINES.filter((e) => ENGINE_MODELS[e].includes(m)).length, 1, m);
  assert.equal(modelEngine('astra'), 'codex');
  assert.equal(modelTagsOf('claude'), '#opus #sonnet #haiku');
  assert.equal(effortNote(), '#ultra는 Codex만');
});

test('a feed filter survives the trip through query parameters', () => {
  const f = { taskIds: ['t1', 't2'], projectIds: ['p1'], statuses: ['running'], kinds: ['user', 'assistant'], q: '빌드' };
  const p = feedParams(f);
  assert.deepEqual(parseFeedParams((n) => p[n] ?? null), f);
  assert.deepEqual(p, { task: 't1,t2', project: 'p1', status: 'running', kind: 'user,assistant', q: '빌드' });
  assert.deepEqual(parseFeedParams(() => null), { taskIds: undefined, projectIds: undefined, statuses: undefined, kinds: undefined, q: undefined });
});
