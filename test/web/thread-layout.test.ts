import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeThreadSize } from '../../web/src/layout.ts';

test('deferred content height triggers bottom correction while preserving readers scrolled up', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'ResizeObserver', original); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); });
  const observed = new Set<Element>();
  let resize = () => {};
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: () => void) { resize = callback; }
    observe(element: Element) { observed.add(element); }
    disconnect() { observed.clear(); }
  } });
  const content = {} as Element;
  const feed = { clientHeight: 400, scrollHeight: 600, scrollTop: 200,
    querySelector: (selector: string) => selector === '.thread-content' ? content : null } as unknown as HTMLElement;
  let atBottom = true;
  const stop = observeThreadSize(feed, () => {
    if (atBottom) feed.scrollTop = feed.scrollHeight - feed.clientHeight;
  });
  assert.ok(observed.has(feed));
  assert.ok(observed.has(content), 'a fixed-height feed alone misses diagram/image growth');
  Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 1400 });
  resize();
  assert.equal(feed.scrollTop, 1000);
  atBottom = false;
  feed.scrollTop = 120;
  Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 2200 });
  resize();
  assert.equal(feed.scrollTop, 120, 'content updates do not force a reader to the bottom');
  stop();
  assert.equal(observed.size, 0);
});
