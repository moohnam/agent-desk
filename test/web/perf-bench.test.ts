import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePerformance } from '../../perf-bench/compare.mts';
const normal = { p95FeedbackMs: 50, maxFrameGapMs: 17, framesOver50ms: 0 };
test('continuous wheel stalls fail even when initial feedback is unchanged', () => {
  assert.equal(comparePerformance('wheel', normal, { ...normal, maxFrameGapMs: 200 }).passed, false);
  assert.equal(comparePerformance('columns', { ...normal, maxFrameGapMs: 67 }, { ...normal, maxFrameGapMs: 67, framesOver50ms: 5 }).passed, false);
});
test('frame jitter tolerance and initial feedback regressions are separate', () => {
  assert.equal(comparePerformance('wheel', normal, { ...normal, maxFrameGapMs: 24, framesOver50ms: 2 }).passed, true);
  assert.equal(comparePerformance('wheel', normal, { ...normal, p95FeedbackMs: 61 }).passed, false);
  assert.throws(() => comparePerformance('wheel', normal, { ...normal, maxFrameGapMs: NaN }));
});
test('thread completion regression still fails', () => {
  assert.equal(comparePerformance('thread', { settledMs: 100 }, { settledMs: 121 }).passed, false);
});
