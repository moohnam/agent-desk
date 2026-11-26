/** Same-environment comparisons; small absolute tolerances cover frame scheduling jitter. */
export function comparePerformance(scenario: string, before: Record<string, number>, after: Record<string, number>) {
  const metrics = scenario === 'thread' ? ['settledMs'] : scenario === 'subagents' ? ['openMs', 'maxFrameGapMs', 'framesOver50ms'] : [
    'p95FeedbackMs', 'maxFrameGapMs', 'framesOver50ms',
    ...(scenario === 'columns' ? ['motionMs', 'p95MotionMs'] : []),
    ...(scenario === 'repeat' ? ['p95FirstMotionMs', 'p95TailMotionMs'] : []),
  ];
  return compareMetrics(metrics, before, after);
}

function compareMetrics(metrics: string[], before: Record<string, number>, after: Record<string, number>) {
  const checks = metrics.map(metric => {
    const previous = before[metric], current = after[metric];
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous < 0 || current < 0)
      throw new Error(`유효하지 않은 성능 지표: ${metric}`);
    const tolerance = metric === 'maxFrameGapMs' ? 8 : metric === 'framesOver50ms' ? 2 : /motion/i.test(metric) || ['openMs', 'p95PageMs', 'p95LatencyMs'].includes(metric) ? 17 : 0;
    const limit = Math.max(previous * 1.2, previous + tolerance);
    return { metric, previous, current, limit, passed: current <= limit };
  });
  return { checks, passed: checks.every(check => check.passed) };
}

type Summary = { current: Record<string, number>; phases?: Record<string, Record<string, number>> };
export function compareSummaries(scenario: string, before: Summary, after: Summary) {
  const overall = comparePerformance(scenario, before.current, after.current);
  if (scenario !== 'columns' && scenario !== 'repeat' && scenario !== 'subagents') return overall;
  // 같은 입력량끼리만 비교한다: 보낸 실시간 단계와 읽은 기록 글 수.
  if (scenario === 'subagents') for (const [phase, key] of [['live', 'sent'], ['older', 'posts']] as const)
    if (before.phases?.[phase]?.[key] !== after.phases?.[phase]?.[key]) throw new Error(`기준 결과와 입력량이 다릅니다: ${phase}.${key}`);
  const names = Object.keys(after.phases ?? {});
  if (!names.length || names.length !== Object.keys(before.phases ?? {}).length)
    throw new Error('기준 결과의 측정 단계가 다릅니다.');
  const phases = Object.fromEntries(names.map(phase => {
    if (!before.phases?.[phase]) throw new Error(`기준 결과에 단계가 없습니다: ${phase}`);
    const metrics = scenario === 'columns' ? ['motionMs', 'p95MotionMs'] : scenario === 'subagents'
      ? ({ open: ['openMs', 'maxFrameGapMs', 'framesOver50ms'], older: ['p95PageMs'], live: ['p95LatencyMs', 'maxFrameGapMs', 'framesOver50ms'] } as Record<string, string[]>)[phase]
      : ['p95FirstMotionMs', 'p95TailMotionMs'];
    if (!metrics) throw new Error(`알 수 없는 측정 단계입니다: ${phase}`);
    return [phase, compareMetrics(metrics, before.phases[phase], after.phases![phase])];
  }));
  return { ...overall, phases, passed: overall.passed && Object.values(phases).every(result => result.passed) };
}
