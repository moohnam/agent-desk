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
