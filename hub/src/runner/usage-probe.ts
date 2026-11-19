import { randomUUID } from 'node:crypto';
import type { EngineUsage } from '../../../shared/api.ts';
import type { EngineName } from '../../../shared/compose.ts';
import { usageEngine, type UsageReading, type UsageReport, type UsageRequest } from '../../../shared/runner-usage.ts';
import { HttpError } from '../errors.ts';
import type { RemoteRunners } from './remote-hub.ts';

export interface UsageQuery { runner: string; engine: EngineName; refresh: boolean }
export function usageQuery(params: URLSearchParams): UsageQuery | undefined {
  const runner = params.get('runner');
  const engine = params.get('engine');
  if (runner === null && engine === null) return;
  if (!runner || runner.length > 128 || !usageEngine(engine)) throw new HttpError(400, '조회할 러너와 엔진을 지정하세요');
  return { runner, engine, refresh: params.get('refresh') === '1' };
}

export function workspaceUsage(remotes: RemoteRunners, includeLocal: boolean, query?: UsageQuery) {
  const targets = remotes.usageTargets(includeLocal);
  if (!query) return targets;
  const id = query.runner === 'default' ? targets[0]?.id : query.runner;
  if (!id || !targets.some(target => target.id === id)) throw new HttpError(404, '등록되지 않은 러너입니다');
  return remotes.readUsage(id, query.engine, query.refresh);
}

const CACHE_MS = 60_000;
const PROBE_MS = 38_000;

type Pending = {
  request: UsageRequest;
  result: Promise<UsageReading>;
  finish: (reading: UsageReading) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Metadata requests are short-lived and independent of the durable session queue. */
export class UsageProbe {
  private pending = new Map<EngineName, Pending>();
  private lastSuccess = new Map<EngineName, EngineUsage>();
  private lastAttempt = new Map<EngineName, { at: number; reading: UsageReading }>();

  requests() { return [...this.pending.values()].map(({ request }) => request); }

  offline(engine: EngineName): UsageReading {
    return { status: 'offline', value: this.lastSuccess.get(engine) };
  }

  read(engine: EngineName, refresh: boolean, online: () => boolean,
    dispatch?: (request: UsageRequest) => void): Promise<UsageReading> {
    const pending = this.pending.get(engine);
    if (pending) return pending.result;
    const last = this.lastAttempt.get(engine);
    if (last && (!refresh && Date.now() - last.at < CACHE_MS
      || refresh && last.reading.status === 'ready' && Date.now() - last.at < 5000)) return Promise.resolve(last.reading);

    const request = { requestId: randomUUID(), engine, refresh };
    const { promise, resolve } = Promise.withResolvers<UsageReading>();
    const timer = setTimeout(() => this.finish(engine, online()
      ? { status: 'error', message: '러너의 사용량 조회 응답 시간이 초과되었습니다.', value: this.lastSuccess.get(engine) }
      : this.offline(engine)), PROBE_MS);
    timer.unref();
    this.pending.set(engine, { request, result: promise, finish: resolve, timer });
    try { dispatch?.(request); }
    catch { this.finish(engine, this.offline(engine)); }
    return promise;
  }

  accept(report: UsageReport) {
    const value = report.value;
    if (this.pending.get(value.engine)?.request.requestId !== report.requestId) return;
    if (value.error) this.finish(value.engine, { status: 'error', message: value.error, value: this.lastSuccess.get(value.engine) });
    else {
      this.lastSuccess.set(value.engine, value);
      this.finish(value.engine, { status: 'ready', value });
    }
  }

  private finish(engine: EngineName, reading: UsageReading) {
    const pending = this.pending.get(engine);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(engine);
    if (reading.status !== 'offline') this.lastAttempt.set(engine, { at: Date.now(), reading });
    pending.finish(reading);
  }

  disconnect() {
    for (const engine of this.pending.keys()) this.finish(engine, this.offline(engine));
  }
}
