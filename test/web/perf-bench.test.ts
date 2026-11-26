import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePerformance, compareSummaries } from '../../perf-bench/compare.mts';
const normal = { p95FeedbackMs: 50, maxFrameGapMs: 17, framesOver50ms: 0, motionMs: 280,
  p95MotionMs: 300, p95FirstMotionMs: 50, p95TailMotionMs: 280 };
test('a slow tail cannot hide behind an unchanged median', () => {
  assert.equal(comparePerformance('columns', normal, { ...normal, p95MotionMs: 800 }).passed, false);
  assert.equal(comparePerformance('repeat', normal, { ...normal, p95TailMotionMs: 800 }).passed, false);
  assert.equal(comparePerformance('repeat', normal, { ...normal, p95FirstMotionMs: 200 }).passed, false);
});
test('a phase regression fails the report even when overall metrics pass', () => {
  const baseline = { current: normal, phases: { 'first-pass': normal, return: normal } };
  assert.equal(compareSummaries('columns', baseline, baseline).passed, true);
  const after = { current: normal, phases: { ...baseline.phases, return: { ...normal, p95MotionMs: 800 } } };
  assert.equal(compareSummaries('columns', baseline, after).passed, false);
  assert.throws(() => compareSummaries('columns', baseline, { current: normal, phases: { return: normal } }));
});
test('column animation regressions fail even when focus feedback is unchanged', () => {
  assert.equal(comparePerformance('columns', normal, { ...normal, motionMs: 400 }).passed, false);
  assert.equal(comparePerformance('columns', normal, { ...normal, motionMs: 300 }).passed, true);
});
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
test('a subagent pane regression fails in its own phase, and only the same input compares', () => {
  const open = { openMs: 400, maxFrameGapMs: 100, framesOver50ms: 4 }, older = { pages: 11, posts: 140, p95PageMs: 200 }, visit = { columns: 4, medianVisitMs: 140, p95VisitMs: 150 };
  const live = { sent: 50, latencySamples: 50, p95LatencyMs: 75, maxFrameGapMs: 67, framesOver50ms: 40 };
  const baseline = { current: { openMs: 400, maxFrameGapMs: 100, framesOver50ms: 44 }, phases: { open, visit, older, live } };
  assert.equal(compareSummaries('subagents', baseline, baseline).passed, true);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit: { ...visit, medianVisitMs: 400 }, older, live } }).passed, true);
  assert.throws(() => compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit: { ...visit, columns: 3 }, older, live } }), /입력량/);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open: { ...open, openMs: 600 }, visit, older, live } }).passed, false);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older: { ...older, p95PageMs: 400 }, live } }).passed, false);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older, live: { ...live, p95LatencyMs: 200 } } }).passed, false);
  assert.throws(() => compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older, live: { ...live, sent: 49 } } }), /입력량/);
  // 표시 지연 표본 수가 다르면 그 지표만 비교 불가로 남기고, 다른 지표는 그대로 판정한다.
  const fewer = compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older, live: { ...live, latencySamples: 5, p95LatencyMs: 900 } } });
  assert.deepEqual([fewer.passed, 'incomparable' in fewer && fewer.incomparable], [true, ['live.p95LatencyMs']]);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older, live: { ...live, latencySamples: 5, framesOver50ms: 90 } } }).passed, false);
  assert.throws(() => compareSummaries('subagents', baseline, { ...baseline, phases: { open, visit, older: { ...older, posts: 139 }, live } }), /입력량/);
});
