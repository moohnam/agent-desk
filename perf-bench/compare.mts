/** Same-environment comparisons; small absolute tolerances cover frame scheduling jitter. */
export function comparePerformance(scenario: string, before: Record<string, number>, after: Record<string, number>) {
  const metrics = scenario === 'thread' ? ['settledMs'] : ['p95FeedbackMs', 'maxFrameGapMs', 'framesOver50ms'];
  const checks = metrics.map(metric => {
    const previous = before[metric], current = after[metric];
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous < 0 || current < 0)
      throw new Error(`유효하지 않은 성능 지표: ${metric}`);
    const tolerance = metric === 'maxFrameGapMs' ? 8 : metric === 'framesOver50ms' ? 2 : 0;
    const limit = Math.max(previous * 1.2, previous + tolerance);
    return { metric, previous, current, limit, passed: current <= limit };
  });
  return { checks, passed: checks.every(check => check.passed) };
}
