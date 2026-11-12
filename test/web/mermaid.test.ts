import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Element } from 'hast';
import { MAX_DIAGRAM_TEXT, mermaidSource, renderMermaid, renderWhenVisible } from '../../web/src/mermaid.ts';
import { colorHandDrawnNodes } from '../../web/src/mermaidColors.ts';

const block = (language?: string): Element => ({
  type: 'element', tagName: 'pre', properties: {}, children: [{
    type: 'element', tagName: 'code', properties: language ? { className: [`language-${language}`] } : {},
    children: [{ type: 'text', value: 'flowchart LR\n  A["허브"] --> B["러너"]\n' }],
  }],
});

test('only Mermaid fenced code becomes a diagram; ordinary code stays unchanged', () => {
  assert.equal(mermaidSource(block('mermaid')), 'flowchart LR\n  A["허브"] --> B["러너"]');
  assert.equal(mermaidSource(block('Mermaid')), mermaidSource(block('mermaid')));
  assert.equal(mermaidSource(block('typescript')), null);
  assert.equal(mermaidSource(block()), null);
  assert.equal(mermaidSource(undefined), null);
});

test('HTML-like labels remain source text and oversized diagrams never load the renderer', async () => {
  const node = block('mermaid');
  const code = node.children[0] as Element;
  code.children = [{ type: 'text', value: 'flowchart LR\nA["<img src=x onerror=alert(1)>"]' }];
  assert.ok(mermaidSource(node)?.includes('<img src=x onerror=alert(1)>'));
  await assert.rejects(renderMermaid('x'.repeat(MAX_DIAGRAM_TEXT + 1)), /너무 커서/);
});

test('cancelled diagrams do not import Mermaid or allocate a render container', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderMermaid('flowchart LR\nA --> B', controller.signal), { name: 'AbortError' });
});

test('Mermaid frontmatter config and authored class styles reach the renderer unchanged', () => {
  const source = `---
config:
  theme: forest
  look: classic
  flowchart:
    curve: stepBefore
---
graph LR
  classDef client fill:#E3F2FD,stroke:#1565C0;
  A[클라이언트]:::client --> B[(데이터베이스)]`;
  const node = block('mermaid');
  (node.children[0] as Element).children = [{ type: 'text', value: source + '\n' }];
  assert.equal(mermaidSource(node), source);
});

test('automatic colors preserve authored theme customization and non-color themes before parsing SVG', () => {
  const svg = '<svg>authored diagram</svg>';
  const palette = { theme: 'redux-color' as const, themeVariables: {
    bkgColorArray: ['#e3f2fd'], borderColorArray: ['#1565c0'], mainBkg: '#fff', nodeBorder: '#000',
  } };
  assert.equal(colorHandDrawnNodes(svg, palette, { themeCSS: '.node { opacity: .5; }' }), svg);
  assert.equal(colorHandDrawnNodes(svg, palette, { themeVariables: { mainBkg: '#ffffff' } }), svg);
  assert.equal(colorHandDrawnNodes(svg, { ...palette, theme: 'forest' }, {}), svg);
  assert.equal(colorHandDrawnNodes(svg, { theme: 'redux-color' }, {}), svg);
});

test('offscreen diagrams wait, cancel stale work, retry on return and retain the completed image', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original); else Reflect.deleteProperty(globalThis, 'IntersectionObserver'); });
  let notify: (visible: boolean, ratio?: number) => void = () => {};
  let disconnected = false;
  const element = {} as HTMLElement;
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      assert.equal(options.rootMargin, undefined, 'do not pre-render outside the viewport');
      assert.ok(options.threshold);
      notify = (visible, ratio = visible ? 1 : 0) => callback([{ isIntersecting: visible, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe(target: HTMLElement) { assert.equal(target, element); }
    disconnect() { disconnected = true; }
  } });
  const attempts: { signal: AbortSignal; finish: () => void }[] = [];
  const stop = renderWhenVisible(element, (signal) => new Promise<void>((finish) => attempts.push({ signal, finish })));
  assert.equal(attempts.length, 0);
  notify(false);
  notify(true, 0); // Touching the viewport edge is not a visible diagram yet.
  assert.equal(attempts.length, 0);
  notify(true);
  notify(true);
  assert.equal(attempts.length, 1, 'one attempt per visible interval');
  notify(false);
  assert.equal(attempts[0].signal.aborted, true, 'skip stale queued Mermaid renders');
  notify(true);
  assert.equal(attempts.length, 2);
  attempts[0].finish();
  await Promise.resolve();
  assert.equal(disconnected, false, 'old completion cannot disconnect a newer attempt');
  attempts[1].finish();
  await Promise.resolve();
  assert.equal(disconnected, true);
  notify(false);
  notify(true);
  assert.equal(attempts.length, 2, 'scrolling back does not redraw completed diagrams');
  stop();
});

test('unmount/source replacement aborts pending diagrams even without visibility observer support', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original); else Reflect.deleteProperty(globalThis, 'IntersectionObserver'); });
  Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  let signal: AbortSignal | undefined;
  let finish = () => {};
  const stop = renderWhenVisible({} as HTMLElement, (value) => {
    signal = value;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  assert.equal(signal?.aborted, false);
  stop();
  assert.equal(signal?.aborted, true);
  finish();
  await Promise.resolve();
});

test('an inert reading pane pauses diagrams even when its geometry stays in the viewport', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original); else Reflect.deleteProperty(globalThis, 'IntersectionObserver'); });
  const view = new EventTarget();
  let hidden = true;
  let intersect = () => {};
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: IntersectionObserverCallback) { intersect = () => callback([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    observe() {}
    disconnect() {}
  } });
  const element = { ownerDocument: { defaultView: view }, closest: () => hidden ? {} : null } as unknown as HTMLElement;
  const attempts: { signal: AbortSignal; finish: () => void }[] = [];
  const stop = renderWhenVisible(element, signal => new Promise<void>(finish => attempts.push({ signal, finish })));
  intersect();assert.equal(attempts.length, 0);
  hidden = false;view.dispatchEvent(new Event('desk-pane-visibility'));assert.equal(attempts.length, 1);
  hidden = true;view.dispatchEvent(new Event('desk-pane-visibility'));assert.equal(attempts[0].signal.aborted, true);
  hidden = false;view.dispatchEvent(new Event('desk-pane-visibility'));assert.equal(attempts.length, 2);
  attempts[1].finish();await Promise.resolve();
  hidden = true;view.dispatchEvent(new Event('desk-pane-visibility'));
  hidden = false;view.dispatchEvent(new Event('desk-pane-visibility'));assert.equal(attempts.length, 2, 'a completed image is retained');
  stop();
});

test('renderer load and library import failures retry once with a fresh, released iframe', async t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  let scenario: 'load' | 'import' | 'exhaust' = 'load';
  let cleanup: AbortController | undefined;
  const frames: { removed: boolean; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/', origin: 'http://localhost' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    postMessage(this: { receive: (message: unknown, origin: string, ports: MessagePort[]) => void }, message: unknown, origin: string, ports: MessagePort[]) {
      assert.equal(origin, 'http://localhost');
      assert.deepEqual(message, { type: 'desk-mermaid-connect' });
      this.receive(message, origin, ports);
    },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => {
      const index = frames.length;
      const frame = {
        removed: false, onload: null as (() => void) | null, onerror: null as (() => void) | null,
        style: { cssText: '' }, setAttribute() {}, remove() { frame.removed = true; },
        contentWindow: {
          postMessage() { assert.fail('use the parent function realm; WebKit otherwise reports the child as event.source'); },
          receive(_message: unknown, _origin: string, [port]: MessagePort[]) {
            port.onmessage = ({ data }: MessageEvent<{ id: number; source: string }>) => {
              if (data.source === 'cleanup') { cleanup?.abort(); return; }
              port.postMessage(scenario === 'import' && index === 2
                ? { id: data.id, error: '도표 라이브러리를 불러오지 못했습니다.', errorKind: 'infrastructure' }
                : { id: data.id, result: { image: 'data:image/svg+xml,ok', background: '#fff' } });
            };
            port.postMessage({ ready: true });
        } },
      };
      frames.push(frame);
      return frame;
    },
    body: { append(frame: typeof frames[number]) {
      const index = frames.indexOf(frame);
      queueMicrotask(() => { if ((scenario === 'load' && index === 0) || scenario === 'exhaust') frame.onerror?.(); else frame.onload?.(); });
    } },
  } });

  assert.equal((await renderMermaid('graph LR\nA-->B')).image, 'data:image/svg+xml,ok');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].removed, true, 'failed iframe is released before retry');
  cleanup = new AbortController();
  await assert.rejects(renderMermaid('cleanup', cleanup.signal), { name: 'AbortError' });
  assert.equal(frames[1].removed, true, 'abort releases successful iframe and its pending request');

  scenario = 'import';
  assert.equal((await renderMermaid('graph LR\nA-->B')).image, 'data:image/svg+xml,ok');
  assert.equal(frames.length, 4);
  assert.equal(frames[2].removed, true, 'failed import releases its module realm before retry');
  cleanup = new AbortController();
  await assert.rejects(renderMermaid('cleanup', cleanup.signal), { name: 'AbortError' });
  assert.equal(frames[3].removed, true);

  scenario = 'exhaust';
  await assert.rejects(renderMermaid('graph LR\nA-->B'), /렌더러를 불러오지 못했습니다/);
  assert.equal(frames.length, 6, 'two infrastructure failures stop after one retry');
  assert.equal(frames[4].removed && frames[5].removed, true);
});

test('diagram syntax errors and aborts do not retry or leave a live renderer', async t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  let cleanup: AbortController | undefined;
  let frames = 0;
  let removed = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/', origin: 'http://localhost' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    postMessage(this: { receive: (message: unknown, origin: string, ports: MessagePort[]) => void }, message: unknown, origin: string, ports: MessagePort[]) {
      assert.equal(origin, 'http://localhost');
      assert.deepEqual(message, { type: 'desk-mermaid-connect' });
      this.receive(message, origin, ports);
    },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => {
      frames++;
      const frame = {
        onload: null as (() => void) | null, onerror: null as (() => void) | null,
        style: { cssText: '' }, setAttribute() {}, remove() { removed++; },
        contentWindow: {
          postMessage() { assert.fail('use the parent function realm; WebKit otherwise reports the child as event.source'); },
          receive(_message: unknown, _origin: string, [port]: MessagePort[]) {
            port.onmessage = ({ data }: MessageEvent<{ id: number; source: string }>) => {
              if (data.source === 'cleanup' || data.source === 'abort') { cleanup?.abort(); return; }
              port.postMessage({ id: data.id, error: '구문 오류' });
            };
            port.postMessage({ ready: true });
        } },
      };
      return frame;
    },
    body: { append(frame: { onload: (() => void) | null }) { queueMicrotask(() => frame.onload?.()); } },
  } });
  await assert.rejects(renderMermaid('invalid syntax'), /구문 오류/);
  assert.equal(frames, 1, 'syntax error is not retried');
  cleanup = new AbortController();
  await assert.rejects(renderMermaid('cleanup', cleanup.signal), { name: 'AbortError' });
  assert.equal(removed, 1);
  cleanup = new AbortController();
  await assert.rejects(renderMermaid('abort', cleanup.signal), { name: 'AbortError' });
  assert.equal(frames, 2, 'abort is not retried');
  assert.equal(removed, 2, 'abort releases the iframe');
});
