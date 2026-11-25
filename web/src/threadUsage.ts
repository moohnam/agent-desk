import type { EngineUsage } from '../../shared/api.ts';
import type { UsageTarget } from '../../shared/runner-usage.ts';

/** Unknown/legacy meters cannot safely be attributed to a thread's model. */
export function threadWindows(value: EngineUsage, model: string | undefined) {
  if (!model || value.engine === 'agy') return [];
  return value.windows.filter(w => w.usedPercent !== null && (w.applicability === 'all'
    || (w.applicability === 'opus' || w.applicability === 'sonnet')
      && value.engine === 'claude' && new RegExp(`(?:^|[-/])${w.applicability}(?:$|[-/])`, 'i').test(model)));
}
export function threadUsageTarget(targets: UsageTarget[], source: string, runner: string) {
  const matches = targets.filter(t => (t.source ?? '') === source && t.runnerId === runner);
  return matches.length === 1 ? matches[0] : undefined;
}
