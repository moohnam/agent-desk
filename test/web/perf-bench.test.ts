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
test('a subagent pane regression fails in its own phase', () => {
  const open = { openMs: 400, maxFrameGapMs: 100, framesOver50ms: 4 }, live = { maxFrameGapMs: 67, framesOver50ms: 40 };
  const baseline = { current: { openMs: 400, maxFrameGapMs: 100, framesOver50ms: 44 }, phases: { open, live } };
  assert.equal(compareSummaries('subagents', baseline, baseline).passed, true);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open: { ...open, openMs: 600 }, live } }).passed, false);
  assert.equal(compareSummaries('subagents', baseline, { ...baseline, phases: { open, live: { ...live, framesOver50ms: 60 } } }).passed, false);
});
