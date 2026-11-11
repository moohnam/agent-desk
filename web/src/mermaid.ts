import type { Element } from 'hast';
import { MAX_DIAGRAM_TEXT, type DiagramResult, type DiagramReply } from './mermaidProtocol.ts';
export { MAX_DIAGRAM_TEXT } from './mermaidProtocol.ts';

/** A split pane can become inert without changing IntersectionObserver geometry. */
export const PANE_VISIBILITY_EVENT = 'desk-pane-visibility';
/** Defer work until visible, cancel queued work on exit, and keep a completed diagram. */
export function renderWhenVisible(element: HTMLElement, render: (signal: AbortSignal) => Promise<void>): () => void {
  let complete = false;
  let pending: AbortController | undefined;
  let observer: IntersectionObserver | undefined;
  let intersecting = typeof IntersectionObserver === 'undefined';
  const view = element.ownerDocument?.defaultView;
  const start = () => {
    if (complete || pending) return;
    const controller = pending = new AbortController();
    const finish = () => {
      if (controller.signal.aborted) return;
      complete = true;
      observer?.disconnect();
      view?.removeEventListener(PANE_VISIBILITY_EVENT, update);
    };
    void render(controller.signal).then(finish, finish);
  };
  const update = () => {
    if (complete) return;
    if (intersecting && !element.closest?.('[inert]')) start();
    else { pending?.abort(); pending = undefined; }
  };
  view?.addEventListener(PANE_VISIBILITY_EVENT, update);
  if (typeof IntersectionObserver === 'undefined') update();
  else {
    observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
      update();
    }, { threshold: 0.001 }); // No prefetch margin: respect feed/body/viewport clipping.
    observer.observe(element);
  }
  return () => { complete = true; pending?.abort(); observer?.disconnect(); view?.removeEventListener(PANE_VISIBILITY_EVENT, update); };
}

/** Only fenced Mermaid blocks, not inline code or other languages. */
export function mermaidSource(node: Element | undefined): string | null {
  const code = node?.children[0];
  if (node?.children.length !== 1 || code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.some((c) => /^language-mermaid$/i.test(String(c)))) return null;
  return code.children.filter((c) => c.type === 'text').map((c) => c.value).join('').replace(/\n$/, '');
}

/** A short-lived document lets the browser reclaim Mermaid's private module/DOM caches. */
const RENDERER_IDLE_MS = 5000;
const RENDERER_TIMEOUT_MS = 30_000;
interface Renderer {
  frame: HTMLIFrameElement;
  port: MessagePort;
  ready: Promise<void>;
  pending?: { resolve: (result: DiagramResult) => void; reject: (error: Error) => void; id: number };
  stop: (reason: Error) => void;
  idle?: ReturnType<typeof setTimeout>;
}
let renderer: Renderer | undefined;
let rendering: Promise<void> = Promise.resolve();
let requestId = 0;

function getRenderer(): Renderer {
  if (renderer) { clearTimeout(renderer.idle); return renderer; }
  const frame = document.createElement('iframe');
  frame.title = '도표 렌더링';
  frame.setAttribute('aria-hidden', 'true');
  frame.inert = true;
  frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;left:-10000px;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none;border:0';
  const channel = new MessageChannel();
  let ready!: () => void, fail!: (reason: Error) => void;
  const state: Renderer = {
    frame, port: channel.port1,
    ready: new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; }),
    stop(reason) {
      if (renderer === state) renderer = undefined;
      clearTimeout(state.idle); clearTimeout(loading);
      state.frame.onload = null; state.frame.onerror = null;
      state.port.onmessage = null; state.port.close(); channel.port2.close();
      state.frame.remove();
      fail(reason); state.pending?.reject(reason); state.pending = undefined;
    },
  };
  const loading = setTimeout(() => state.stop(new Error('도표 렌더러를 불러오는 시간이 초과되었습니다.')), RENDERER_TIMEOUT_MS);
  state.port.onmessage = ({ data }: MessageEvent<DiagramReply & { ready?: boolean }>) => {
    if (data.ready) { clearTimeout(loading); ready(); return; }
    const pending = state.pending;
    if (!pending || data.id !== pending.id) return;
    state.pending = undefined;
    if (data.result) pending.resolve(data.result);
    else pending.reject(new Error(data.error || '도표를 그리지 못했습니다.'));
  };
  frame.onload = () => frame.contentWindow?.postMessage({ type: 'desk-mermaid-connect' }, location.origin, [channel.port2]);
  frame.onerror = () => state.stop(new Error('도표 렌더러를 불러오지 못했습니다.'));
  frame.src = new URL('/mermaid-renderer.html', location.href).href;
  renderer = state;
  document.body.append(frame);
  return state;
}

/** Serialized config/render work; cancelled frames and idle library state are fully released. */
export async function renderMermaid(source: string, signal?: AbortSignal): Promise<DiagramResult> {
  if (source.length > MAX_DIAGRAM_TEXT) throw new Error('도표가 너무 커서 원문으로 표시합니다.');
  signal?.throwIfAborted();
  const render = async () => {
    signal?.throwIfAborted();
    const state = getRenderer();
    const abort = () => state.stop(new DOMException('도표 렌더링을 취소했습니다.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await state.ready;
      signal?.throwIfAborted();
      return await new Promise<DiagramResult>((resolve, reject) => {
        const id = ++requestId;
        state.pending = { id, resolve, reject };
        deadline = setTimeout(() => state.stop(new Error('도표 렌더링 시간이 초과되었습니다.')), RENDERER_TIMEOUT_MS);
        state.port.postMessage({ id, source });
      });
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (renderer === state) state.idle = setTimeout(() => state.stop(new Error('idle')), RENDERER_IDLE_MS);
    }
  };
  const result = rendering.then(render);
  // Queue completion must not retain the last image as a fulfilled Promise's value.
  rendering = result.then(() => {}, () => {});
  return result;
}
