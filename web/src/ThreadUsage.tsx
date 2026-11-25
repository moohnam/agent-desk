import { useEffect, useRef, useState } from 'react';
import { engineOf } from '../../shared/compose.ts';
import { checkUsageReading, checkUsageTargets, type UsageReading } from '../../shared/runner-usage.ts';
import type { TaskView } from './types.ts';
import { splitId } from './federation.ts';
import { readUsageApi } from './usageReader.ts';
import { threadUsageTarget, threadWindows } from './threadUsage.ts';
import './thread-usage.css';

export function ThreadUsage({ task, model }: { task: TaskView; model: string | undefined }) {
  const [source] = splitId(task.id);
  const [runnerSource, runner] = splitId(task.runner_id ?? '');
  const engine = engineOf(task.engine);
  const enabled = !!runner && source === runnerSource && task.source !== 'external' && engine !== 'agy' && !!model;
  const key = JSON.stringify([source, runner, engine]);
  const [result, setResult] = useState<{ key: string; reading: UsageReading }>();
  const anchor = useRef<HTMLSpanElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = () => { clearTimeout(leaveTimer.current); setOpen(false); setHovered(false); };
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState({left: 0, top: 0});
  const place = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPosition({left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)), top: rect.bottom});
  };
  useEffect(() => {
    close();
  }, [task.id, model]);
  useEffect(() => {
    if (!open && !hovered) return;
    const repositioned = (event: Event) => {
      // Scrolling the details themselves must remain possible.
      if (event.type === 'scroll' && event.target instanceof Node && anchor.current?.contains(event.target)) return;
      close();
    };
    // A column can move without a window scroll/resize event. Observe the anchor
    // only while details are visible, and close rather than leave a detached popup.
    const origin = anchor.current?.getBoundingClientRect();
    let frame = 0;
    const checkPosition = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || !origin || rect.left !== origin.left || rect.top !== origin.top
        || rect.width !== origin.width || rect.height !== origin.height) { close(); return; }
      frame = window.requestAnimationFrame(checkPosition);
    };
    if (origin) frame = window.requestAnimationFrame(checkPosition);
    window.addEventListener('scroll', repositioned, true);
    window.addEventListener('resize', repositioned);
    return () => {
      window.removeEventListener('scroll', repositioned, true);
      window.removeEventListener('resize', repositioned);
      clearTimeout(leaveTimer.current);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, hovered]);
  useEffect(() => {
    setOpen(false); setHovered(false);
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const targets = await readUsageApi<unknown>(`runner-usage${source ? '?' + new URLSearchParams({source}) : ''}`, controller.signal);
        if (!checkUsageTargets(targets)) throw new Error('사용량 러너 목록 오류');
        const target = threadUsageTarget(targets, source, runner);
        if (!target) { if (!controller.signal.aborted) setResult(undefined); return; }
        const params = new URLSearchParams({runner, engine});
        if (source) params.set('source', source);
        // Same endpoint and per-runner minute cache as Settings; never force refresh.
        const reading = await readUsageApi<unknown>(`runner-usage?${params}`, controller.signal, 45_000);
        if (!checkUsageReading(reading, engine)) throw new Error('사용량 응답 오류');
        if (!controller.signal.aborted) setResult({key, reading});
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
        const rejected = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (!controller.signal.aborted) setResult(old => !rejected && old?.key === key
          ? {key, reading: {...old.reading, status: 'offline'}} : undefined);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 60_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, enabled, source, runner, engine]);
  const reading = enabled && result?.key === key ? result.reading : undefined;
  const value = reading?.value;
  const windows = value ? threadWindows(value, model) : [];
  if (!windows.length || !value) return null;
  const remaining = Math.round(Math.min(...windows.map(w => 100 - w.usedPercent!)) * 10) / 10;
  const stale = reading?.status !== 'ready' || task.runner_connected === false;
  return <span ref={anchor} className={`thread-usage${stale ? ' stale' : ''}`} onPointerEnter={e => { if (e.pointerType === 'mouse') { clearTimeout(leaveTimer.current); place(e.currentTarget); setHovered(true); } }}
    onPointerLeave={() => { leaveTimer.current = setTimeout(() => setHovered(false), 120); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); anchor.current?.querySelector('button')?.focus(); } }}>
    <button type="button" aria-label={`사용량 한도 ${remaining}% 남음${stale ? ' · 마지막 조회값' : ''}`} aria-expanded={open || hovered}
      onClick={e => { place(e.currentTarget); setOpen(v => !v); }}>
      <span className="thread-usage-track" aria-hidden="true"><i style={{width: `${remaining}%`}} /></span>{remaining}% 남음
    </button>
    {(open || hovered) && <span className="thread-usage-detail" style={position} role="status" tabIndex={0}>
      {stale && <span>연결 대기 또는 조회 실패 · 마지막 조회값</span>}
      {windows.map((w, i) => <span key={i}>{w.label}: {Math.round((100 - w.usedPercent!) * 10) / 10}% 남음<br />
        초기화 {w.resetsAt ? new Date(w.resetsAt).toLocaleString('ko-KR') : '정보 없음'}</span>)}
      <span>조회 {new Date(value.fetchedAt).toLocaleString('ko-KR')}</span>
    </span>}
  </span>;
}
