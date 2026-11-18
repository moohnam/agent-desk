import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateView } from '../../shared/update.ts';
import { api } from './api.ts';

/** A single status reader for the badge and settings. Only explicit actions prepare or approve. */
export function useUpdates() {
  const [view, setView] = useState<UpdateView | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(view); latest.current = view;
  const request = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const settleUntil = useRef(0);
  const mounted = useRef(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!disposed && !document.hidden) timer = setTimeout(poll, delay);
    };
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (action.current) { schedule(2000); return; }
      request.current?.abort();
      const controller = new AbortController(); request.current = controller;
      const seq = ++revision.current;
      let timedOut = false;
      const timeout = setTimeout(() => {timedOut = true; controller.abort();}, 10_000);
      try {
        const next = await api.updates(controller.signal);
        if (!disposed && !controller.signal.aborted && revision.current === seq) {
          latest.current = next; setView(next); setReadError('');
        }
      } catch (e) {
        if (!disposed && (!controller.signal.aborted || timedOut) && revision.current === seq) setReadError(timedOut ? '버전 정보 요청 시간이 초과되었습니다.' : e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timeout);
        if (request.current === controller) request.current = null;
        const current = latest.current;
        if (revision.current === seq) schedule(Date.now() < settleUntil.current || current?.checking || ['waiting', 'switching'].includes(current?.phase ?? '') ? 2000 : 60_000);
      }
    };
    refresh.current = () => schedule(0);
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) { ++revision.current; request.current?.abort(); }
      else void poll();
    };
    document.addEventListener('visibilitychange', visibility);
    void poll();
    return () => {
      disposed = true; mounted.current = false; clearTimeout(timer); ++revision.current;
      request.current?.abort(); action.current?.abort();
      refresh.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const run = useCallback(async (kind: 'check' | 'approve' | 'cancel', commit?: string, mode: 'immediate' | 'when-idle' = 'immediate') => {
    if (action.current) return;
    if (kind !== 'check' && (kind === 'approve' ? latest.current?.available : latest.current?.approval?.commit) !== commit) {
      setError('대상 버전이 바뀌었습니다. 현재 버전을 확인한 뒤 다시 선택해 주세요.'); return;
    }
    const controller = new AbortController(); action.current = controller;
    let timedOut = false;
    // Approval includes a fresh Git lookup in addition to checking managed runtime status.
    const timeout = setTimeout(() => {timedOut = true; controller.abort();}, kind === 'approve' ? 30_000 : 15_000);
    ++revision.current; request.current?.abort();
    setBusy(true); setError('');
    try {
      const next = kind === 'check' ? await api.checkUpdates(controller.signal)
        : kind === 'approve' ? await api.approveUpdate(commit!, mode, controller.signal)
        : await api.cancelUpdate(commit!, controller.signal);
      if (!controller.signal.aborted) { latest.current = next; setView(next); setReadError(''); settleUntil.current = Date.now() + 10_000; }
    } catch (e) {
      if (mounted.current && (!controller.signal.aborted || timedOut)) setError(timedOut
        ? '요청 응답을 확인하지 못했습니다. 서버에는 반영되었을 수 있어 상태를 다시 조회합니다. 요청을 자동으로 다시 보내거나 승인을 취소하지 않습니다.'
        : e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timeout);
      if (action.current === controller) action.current = null;
      if (mounted.current && (!controller.signal.aborted || timedOut)) { setBusy(false); refresh.current(); }
    }
  }, []);
  return {view, error: error || readError, unavailable: !!readError, busy,
    check: () => run('check'),
    approve: (commit: string, mode: 'immediate' | 'when-idle') => run('approve', commit, mode),
    cancel: (commit: string) => run('cancel', commit),
  };
}
export type UpdatesState = ReturnType<typeof useUpdates>;
