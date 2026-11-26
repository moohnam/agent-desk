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

// 서브 에이전트 창. 서브 에이전트 API 응답을 가로채 받은 글 ID를 컬럼별로 남기고, 화면의 data-post와 대조한다.
// 기대 컬럼은 제품과 같은 판별(isActive, isCommand, isCurrentCommand)로 목록 응답에서 계산한다.
const served: { list?: any[]; pages: Map<string, { before: number | null; ids: number[]; more: boolean; at: number }[]> } = { pages: new Map() };
const columnOfRequest = (url: URL) => url.pathname.endsWith('/subagents/history') ? 'history'
  : /\/subagents\/([^/]+)\/events$/.exec(url.pathname)?.[1] && `${url.searchParams.get('session')}/${decodeURIComponent(/\/subagents\/([^/]+)\/events$/.exec(url.pathname)![1])}`;
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await realFetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!response.ok || !/^\/api\/tasks\/t0\/subagents/.test(url.pathname)) return response;
  const body = await response.clone().json();
  if (url.pathname.endsWith('/subagents')) served.list = body;
  const column = columnOfRequest(url);
  if (column) {
    const pages = served.pages.get(column) ?? [];
    pages.push({ before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null, more: body.more, at: performance.now(),
      ids: body.events.filter((e: any) => e.kind === 'user' || e.kind === 'assistant').map((e: any) => e.id) });
    served.pages.set(column, pages);
  }
  return response;
};
const { isActive, isCommand, isCurrentCommand } = await import('../web/src/subagents');
const expectedColumns = () => !served.list ? undefined : ['history', ...(served.list.some(isCurrentCommand) ? ['commands'] : []),
  ...served.list.filter((s: any) => !isCommand(s) && isActive(s)).map((s: any) => `${s.session_id}/${s.id}`)].sort();
const panelColumns = () => [...document.querySelectorAll('.subagent-panel .sa-col')];
const renderedIn = (column: Element) => new Set([...column.querySelectorAll('[data-post]')].map(e => Number(e.getAttribute('data-post'))));
/** 아직 화면에 없는 받은 글: 컬럼별로 받은 모든 페이지의 글 ID 중 그 컬럼에 그려지지 않은 것. */
const missing = () => {
  const out: Record<string, number[]> = {};
  for (const [column, pages] of served.pages) {
    const el = document.querySelector(`.subagent-panel [data-column="${CSS.escape(column)}"]`);
    const shown = el ? renderedIn(el) : new Set<number>();
    const lost = pages.flatMap(p => p.ids).filter(id => !shown.has(id));
    if (lost.length) out[column] = lost;
  }
  return out;
};
(window as any).servedPages = (column: string) => served.pages.get(column) ?? [];
/** 컬럼이 처음 기록을 받은 벽시계 시각(ms). 받은 적 없으면 null. 실시간 단계가 지연 조회 대상인지 가른다. */
(window as any).firstServed = () => Object.fromEntries([...served.pages].map(([c, pages]) => [c, performance.timeOrigin + pages[0].at]));
const colsBox = () => document.querySelector('.subagent-panel .sa-cols')?.getBoundingClientRect();
/** 창의 가로 스크롤 영역에 조금이라도 보이는 컬럼. 지연 조회는 이 컬럼만 처음 기록을 부른다. */
const visibleColumns = () => {
  const box = colsBox();
  return box ? panelColumns().filter(c => { const r = c.getBoundingClientRect(); return r.right > box.left + 1 && r.left < box.right - 1; }).map(c => c.getAttribute('data-column')!) : [];
};
const column = (key: string) => document.querySelector<HTMLElement>(`.subagent-panel [data-column="${CSS.escape(key)}"]`);
(window as any).missingPosts = missing;

let pane: any;
// b 입력부터 창이 보일 때(feedbackMs)와, 기대 컬럼이 모두 서고 처음 보이는 컬럼마다 첫 페이지 글이, 명령 컬럼이 보이면 명령 줄이 다 그려질 때(openMs, 이중 rAF)까지.
// 화면 밖 컬럼은 지연 조회일 수 있으므로 열기에서 기다리지 않는다(visitColumns에서 따로 잰다).
(window as any).armPane = () => {
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
      const expected = expectedColumns();
      const columns = panelColumns().map(c => c.getAttribute('data-column')!).sort();
      const commands = served.list?.filter(isCurrentCommand).length ?? 0;
      const visible = visibleColumns();
      const complete = !!panel && !!expected && columns.join() === expected.join() && visible.length > 0
        && visible.filter(c => c !== 'commands').every(c => served.pages.get(c)?.length) && !Object.keys(missing()).length
        && (!visible.includes('commands') || panel.querySelectorAll('.sa-command').length === commands);
      if (complete && pane.openMs == null) requestAnimationFrame(() => requestAnimationFrame(() => { pane.openMs = performance.now() - pane.start; }));
      if (pane.openMs != null && now - pane.start - pane.openMs > 300) {
        pane.maxFrameGapMs = Math.max(...pane.frames);
        pane.framesOver50ms = pane.frames.filter((n: number) => n > 50).length;
        pane.longTaskMs = longTasks.filter(t => t.startTime >= pane.start && t.startTime < now).reduce((a, t) => a + t.duration, 0);
        pane.columns = columns; pane.visible = visibleColumns(); pane.requested = [...served.pages.keys()];
        pane.domNodes = document.querySelectorAll('*').length; pane.done = true;
      } else if (now - pane.start > 20000) {
        pane.error = `창이 다 그려지지 않았습니다: 컬럼 ${columns.join(',')} / 기대 ${expected?.join(',') ?? '목록 없음'}, 보임 ${visibleColumns().join(',')}, 조회 ${[...served.pages.keys()].join(',')}, 누락 ${JSON.stringify(missing())}, 명령 ${panel?.querySelectorAll('.sa-command').length ?? 0}/${commands}`;
        pane.done = true;
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { capture: true });
};

const settle = (done: () => boolean, limitMs = 10000) => new Promise<boolean>(resolve => {
  const start = performance.now();
  const wait = () => done() ? requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
    : performance.now() - start > limitMs ? resolve(false) : requestAnimationFrame(wait);
  requestAnimationFrame(wait);
});
/** 컬럼을 가로로 보이게 한다(덱 컬럼과 같은 scrollIntoView). */
const reveal = async (key: string) => {
  column(key)?.scrollIntoView({ block: 'nearest', inline: 'start' });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
/**
 * 아직 보지 않은 컬럼을 하나씩 가로로 보이게 해, 보인 순간부터 첫 페이지를 받고 그 글이 다 그려질 때까지 잰다.
 * requestedBefore: 보이기 전에 이미 조회했는지(즉시 조회) 아니면 보여서 조회했는지(지연 조회).
 */
(window as any).visitColumns = async (keys: string[]) => {
  const out: { column: string; ms: number; requestedBefore: boolean; posts: number }[] = [];
  for (const key of keys) {
    const requestedBefore = !!served.pages.get(key)?.length, start = performance.now();
    column(key)?.scrollIntoView({ block: 'nearest', inline: 'start' });
    const ok = await settle(() => !!served.pages.get(key)?.length && !missing()[key] && visibleColumns().includes(key));
    if (!ok) return { error: `방문한 컬럼이 기록을 표시하지 않았습니다: ${key}, 조회 ${served.pages.get(key)?.length ?? 0}회, 누락 ${JSON.stringify(missing()[key] ?? [])}` };
    out.push({ column: key, ms: performance.now() - start, requestedBefore, posts: served.pages.get(key)!.flatMap(p => p.ids).length });
  }
  return { visits: out };
};

/**
 * 한 컬럼의 이전 페이지를 끝까지 읽는다. 페이지마다 스크롤부터 받은 글이 모두 그려진 rAF까지 잰다.
 * limit: 고정 데이터로 계산한 이전 페이지 수 상한. 넘거나, 새 페이지의 커서가 앞 페이지보다 줄지 않으면 실패한다.
 */
(window as any).pageBack = async (key: string, toBottom: boolean, limit: number) => {
  await reveal(key);
  const times: number[] = [];
  const older = () => (served.pages.get(key) ?? []).filter(p => p.before != null);
  while ((served.pages.get(key) ?? []).at(-1)?.more) {
    if (older().length > limit) return { error: `이전 페이지가 상한 ${limit}회를 넘었습니다: ${key}` };
    const count = served.pages.get(key)!.length, start = performance.now();
    const f = column(key)?.querySelector<HTMLElement>('.feed');
    if (!f) return { error: `컬럼이 없습니다: ${key}` };
    f.scrollTop = toBottom ? f.scrollHeight : 0;
    f.dispatchEvent(new Event('scroll'));
    const ok = await settle(() => served.pages.get(key)!.length > count && !missing()[key]);
    if (!ok) return { error: `이전 페이지가 그려지지 않았습니다: ${key}, 누락 ${JSON.stringify(missing()[key] ?? [])}` };
    const cursors = older().map(p => p.before!);
    if (cursors.some((b, i) => i > 0 && b >= cursors[i - 1])) return { error: `이전 페이지 커서가 줄지 않았습니다: ${key} ${cursors.slice(-3).join(',')}` };
    times.push(performance.now() - start);
  }
  const el = column(key);
  // 제품이 스스로 이어 부른 페이지도 있으므로 받은 이전 페이지 수(served)와 직접 잰 페이지(times)를 따로 돌려준다.
  return { times, served: older().length, more: served.pages.get(key)?.at(-1)?.more, rendered: el ? [...renderedIn(el)] : [] };
};

/** 실시간 구간: 프레임과 긴 작업, 그리고 data-post가 처음 나타난 벽시계 시각과 컬럼. */
let span: any;
const seen = new Map<number, { at: number; column: string | null }>();
new MutationObserver(records => {
  if (!span || span.done) return;
  const at = performance.timeOrigin + performance.now();
  for (const record of records) for (const node of record.addedNodes) {
    if (!(node instanceof Element)) continue;
    for (const post of [node, ...node.querySelectorAll('[data-post]')]) {
      if (!post.matches('[data-post]')) continue;
      const id = Number(post.getAttribute('data-post'));
      if (!seen.has(id)) seen.set(id, { at, column: post.closest('[data-column]')?.getAttribute('data-column') ?? null });
    }
  }
}).observe(document.getElementById('root')!, { childList: true, subtree: true });
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
    longTaskMs: longTasks.filter(t => t.startTime >= span.started).reduce((a, t) => a + t.duration, 0),
    seen: [...seen].map(([id, v]) => ({ id, ...v })) };
};
