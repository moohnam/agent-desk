// 실제 App, 키보드 처리, 컬럼 렌더링, 이동 애니메이션을 그대로 사용한다.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../web/src/styles.css';
import { markdownParseCacheStats } from '../web/src/markdownParseCache';
(window as any).cacheStats = markdownParseCacheStats;
// 격리 측정 페이지의 이전 회차 초안이 다음 표본에 섞이지 않게 초기화한다.
localStorage.clear();
const columns = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: `측정 컬럼 ${i + 1}`, filter: { taskIds: [`t${i}`] } }));
localStorage.setItem('agent-desk.columns.v2', JSON.stringify(columns));
localStorage.setItem('agent-desk.view', 'custom');
localStorage.setItem('agent-desk.composeOpen', '0');
const { App } = await import('../web/src/App');
createRoot(document.getElementById('root')!).render(<App />);

const state = () => ({
  focus: document.querySelector('.deck section.focused')?.getAttribute('data-col'),
  order: [...document.querySelectorAll('.deck section[data-col]')].map(el => el.getAttribute('data-col')).join(','),
  scroll: document.querySelector('.deck')?.scrollLeft ?? 0,
});
let sample: any;
const longTasks: PerformanceEntry[] = [];
new PerformanceObserver(list => longTasks.push(...list.getEntries())).observe({ type: 'longtask' });
(window as any).armInteraction = (kind: string) => {
  const before = state();
  sample = { kind, before, frames: [], addedPostNodes: 0, removedPostNodes: 0, done: false };
  (window as any).interaction = sample;
};
function begin(e: KeyboardEvent | WheelEvent) {
  if (!sample || !e.isTrusted) return;
  if (e instanceof WheelEvent ? sample.kind !== 'wheel' : sample.kind === 'wheel' || !['ArrowRight', 'ArrowLeft', 'H', 'L'].includes(e.key)) return;
  const s = sample;
  s.lastInput = e.timeStamp;
  if (s.kind === 'repeat' && e instanceof KeyboardEvent) {
    (s.inputs ??= []).push({ key: e.key, time: e.timeStamp, repeat: e.repeat });
  }
  if (s.start != null) return;
  s.start = e.timeStamp; s.dispatchDelayMs = performance.now() - e.timeStamp;
  let previous = performance.now(), lastScroll = s.before.scroll, lastChange = previous, moved = false;
  const tick = (now: number) => {
    s.frames.push(now - previous); previous = now;
    const current = state();
    const changed = s.kind === 'wheel' ? Math.abs(current.scroll - s.before.scroll) > 1 : s.kind === 'reorder' ? current.order !== s.before.order : current.focus !== s.before.focus;
    if (changed && s.feedbackMs == null) requestAnimationFrame(() => { s.feedbackMs ??= performance.now() - s.start; });
    if (Math.abs(current.scroll - lastScroll) > 0.5) { lastChange = now; lastScroll = current.scroll; moved = true; s.firstMotionMs ??= now - s.start; }
    if ((!['wheel', 'repeat'].includes(s.kind) || s.inputEnded) && changed && s.feedbackMs != null && now - s.lastInput > 400 && now - lastChange > 120) {
      s.after = current; s.motionMs = moved ? lastChange - s.start : 0;
      s.tailMotionMs = moved ? Math.max(0, lastChange - (s.lastInput ?? s.start)) : 0;
      s.maxFrameGapMs = Math.max(...s.frames);
      s.framesOver50ms = s.frames.filter((n: number) => n > 50).length;
      s.longTaskMs = longTasks.filter(t => t.startTime >= s.start && t.startTime < now).reduce((a, t) => a + t.duration, 0);
      s.domNodes = document.querySelectorAll('*').length; s.done = true;
    } else if (now - s.start > 10000) { s.error = '컬럼 상태 변경 또는 스크롤 안정화를 확인하지 못했습니다.'; s.done = true; }
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// DOM 추가·제거 기록에는 기존 노드의 이동도 포함된다. React 마운트 수가 아니다.
const countPosts = (node: Node) => node instanceof Element
  ? Number(node.matches('[data-post]')) + node.querySelectorAll('[data-post]').length : 0;
new MutationObserver(records => {
  if (!sample || sample.start == null || sample.done) return;
  for (const record of records) {
    sample.addedPostNodes += [...record.addedNodes].reduce((n, node) => n + countPosts(node), 0);
    sample.removedPostNodes += [...record.removedNodes].reduce((n, node) => n + countPosts(node), 0);
  }
}).observe(document.getElementById('root')!, { childList: true, subtree: true });
window.addEventListener('keydown', begin, true);
window.addEventListener('wheel', begin, { capture: true, passive: true });
(window as any).endWheelInput = () => { sample.inputEnded = true; };

// 실제 작성창의 beforeinput 시각부터 input 값이 반영된 뒤 rAF까지 관측한다.
let typing: any, typingStart = 0;
(window as any).armTyping = () => {
  typing = { frames: [], feedback: [], started: performance.now(), done: false };
  (window as any).typing = typing;
  let previous = performance.now();
  const tick = (now: number) => { if (typing.done) return; typing.frames.push(now - previous); previous = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
window.addEventListener('beforeinput', e => {
  if (typing && !typing.done && e.isTrusted && (e.target as Element)?.closest('.compose')) typingStart = e.timeStamp;
}, true);
window.addEventListener('input', e => {
  if (!typing || typing.done || !e.isTrusted || !(e.target as Element)?.closest('.compose')) return;
  const begin = typingStart;
  requestAnimationFrame(() => requestAnimationFrame(() => typing.feedback.push(performance.now() - begin)));
}, true);
(window as any).finishTyping = async () => {
  await new Promise(resolve => setTimeout(resolve, 200));
  typing.done = true;
  typing.longTaskMs = longTasks.filter(t => t.startTime >= typing.started).reduce((sum, t) => sum + t.duration, 0);
  return typing;
};

// 서브 에이전트 창: b 입력부터 창이 보일 때(feedbackMs)와 모든 컬럼이 기록까지 그려질 때(openMs)까지, 이중 rAF 근삿값.
let pane: any;
(window as any).armPane = (expected: { columns: number; agentPosts: number; commandRows: number }) => {
  pane = { frames: [], done: false };
  (window as any).pane = pane;
  window.addEventListener('keydown', e => {
    if (!e.isTrusted || e.key !== 'b' || pane.start != null) return;
    pane.start = e.timeStamp;
    let previous = performance.now();
    const tick = (now: number) => {
      pane.frames.push(now - previous); previous = now;
      const panel = document.querySelector('.subagent-panel');
      if (panel && pane.feedbackMs == null) pane.feedbackMs = now - pane.start;
      const columns = panel ? [...panel.querySelectorAll('.sa-col')] : [];
      const agentColumns = columns.filter(c => c.getAttribute('data-column') !== 'commands');
      const complete = columns.length === expected.columns
        && agentColumns.every(c => c.querySelectorAll('[data-post]').length >= expected.agentPosts)
        && (panel?.querySelectorAll('.sa-command').length ?? 0) === expected.commandRows;
      if (complete && pane.openMs == null) requestAnimationFrame(() => requestAnimationFrame(() => { pane.openMs = performance.now() - pane.start; }));
      if (pane.openMs != null && now - pane.start - pane.openMs > 300) {
        pane.maxFrameGapMs = Math.max(...pane.frames);
        pane.framesOver50ms = pane.frames.filter((n: number) => n > 50).length;
        pane.longTaskMs = longTasks.filter(t => t.startTime >= pane.start && t.startTime < now).reduce((a, t) => a + t.duration, 0);
        pane.domNodes = document.querySelectorAll('*').length; pane.done = true;
      } else if (now - pane.start > 20000) { pane.error = `창이 다 그려지지 않았습니다: 컬럼 ${columns.length}/${expected.columns} ${columns.map(c => `${c.getAttribute('data-column')}:${c.querySelectorAll('[data-post]').length}`).join(',')}, 명령 ${panel?.querySelectorAll('.sa-command').length ?? 0}/${expected.commandRows}`; pane.done = true; }
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { capture: true });
};
// 실시간 갱신 구간: 프레임 간격과 긴 작업만 기록한다.
let span: any;
(window as any).armWindow = () => {
  span = { frames: [], started: performance.now(), done: false };
  let previous = performance.now();
  const tick = (now: number) => { if (span.done) return; span.frames.push(now - previous); previous = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
(window as any).finishWindow = () => {
  span.done = true;
  const sorted = [...span.frames].sort((a: number, b: number) => a - b);
  return { frames: span.frames.length, maxFrameGapMs: Math.max(...span.frames), p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1],
    framesOver50ms: span.frames.filter((n: number) => n > 50).length,
    longTaskMs: longTasks.filter(t => t.startTime >= span.started).reduce((a, t) => a + t.duration, 0) };
};
