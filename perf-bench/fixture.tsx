import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThreadPosts } from '../web/src/ThreadPosts';
import { buildPosts } from '../web/src/posts';
import '../web/src/styles.css';

const noop = () => {};
const ctx = { tasks: new Map(), models: new Map(), approvals: new Map(), questions: new Map(), working: new Set(), drafts: new Set() };
const actions = { current: { select: noop, toggle: noop, allow: noop, deny: noop, reference: noop, pick: noop, cutNote: noop, attach: noop } };
const params = new URLSearchParams(location.search);
const mode = params.get('mode')!;
const count = Number(params.get('count'));
const metrics: any = { mode, count, longTasks: [], frameGaps: [] };
(window as any).bench = metrics;
let rendering = false, previous = 0;
new PerformanceObserver(list => {
  for (const e of list.getEntries()) if (e.startTime >= metrics.renderStart) metrics.longTasks.push(e.duration);
}).observe({ type: 'longtask', buffered: true });
function frame(now: number) {
  if (rendering && previous) metrics.frameGaps.push(now - previous);
  previous = now;
  if (!metrics.done) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const start = performance.now();
const response = await fetch(`/fixture?count=${count}&mode=${mode}`);
const text = await response.text();
metrics.fetchMs = performance.now() - start;
metrics.responseBytes = new TextEncoder().encode(text).length;
const parseStart = performance.now();
const data = JSON.parse(text);
metrics.parseMs = performance.now() - parseStart;
const deriveStart = performance.now();
const posts = buildPosts(data);
metrics.deriveMs = performance.now() - deriveStart;
// 실험: 실제 ThreadPosts는 유지하고 입력만 마지막 24개로 제한한다.
// 완성된 가상 스크롤이 아니므로 실제 개선 폭의 상한에 가까운 비교다.
const shown = mode === 'window' ? posts.slice(-24) : posts;
const col = { id: 'bench', posts: shown, placed: shown.map(post => ({ post, up: true, down: true })) };
const feed = { current: null as HTMLDivElement | null };
metrics.renderStart = performance.now(); rendering = true;
let scheduled = false;
function mounted() {
  if (metrics.firstPaintMs == null) requestAnimationFrame(() => requestAnimationFrame(() => {
    metrics.firstPaintMs ??= performance.now() - metrics.renderStart;
  }));
  if (scheduled || document.querySelectorAll('[data-post]').length < shown.length) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    metrics.settledMs = performance.now() - metrics.renderStart;
    rendering = false;
    metrics.postNodes = document.querySelectorAll('[data-post]').length;
    metrics.domNodes = document.querySelectorAll('*').length;
    setTimeout(() => { metrics.done = true; }, 100);
  }));
}
createRoot(document.getElementById('root')!).render(
  <div ref={el => { feed.current = el; }} style={{ height: 800, width: 700, overflow: 'auto' }}>
    <ThreadPosts col={col} ctx={ctx} flash={null} expanded={new Set()} taskId="benchmark"
      actions={actions} onError={noop} feed={feed} atBottom={{ current: true }} onPostsMounted={mounted} />
  </div>
);
// componentDidMount does not call onPostsMounted in the current component.
const watch = setInterval(() => { mounted(); if (metrics.done) clearInterval(watch); }, 20);
