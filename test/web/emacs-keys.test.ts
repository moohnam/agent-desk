import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEmacsKeys } from '../../web/src/emacsKeys.ts';

test('custom caret movement scrolls only the text field and releases its measuring element', t => {
  const view = new EventTarget();
  let rect = { top: 208, left: 8, height: 20 };
  let allocations = 0, attached = 0;
  const document = {
    createElement: () => {
      allocations++;
      return {
        style: { setProperty() {} }, textContent: '', setAttribute() {}, append() {},
        getBoundingClientRect: () => ({ top: 0, left: 0 }),
        getClientRects: () => [rect],
        remove: () => { attached--; },
      };
    },
    body: { append: () => { attached++; } },
  };
  class Field {
    value = 'first\nsecond\nthird';
    selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
    scrollTop = 0; scrollLeft = 0; clientHeight = 76; clientWidth = 240;
    scrollHeight = 500; scrollWidth = 240;
    ownerDocument = document; wrap = 'soft';
    readOnly = false; disabled = false;
    parentElement = { querySelector: () => null };
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  }
  class Textarea extends Field {}
  class Input extends Field { type = 'text'; }
  const globals = {
    window: view, navigator: { platform: 'MacIntel' },
    HTMLTextAreaElement: Textarea, HTMLInputElement: Input,
    getComputedStyle: () => ({ paddingTop: '8px', paddingBottom: '8px', paddingLeft: '8px', paddingRight: '8px', getPropertyValue: () => '' }),
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  installEmacsKeys();
  const key = (field: Field, code: string) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, { target: { value: field }, code: { value: code }, ctrlKey: { value: true } });
    view.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(attached, 0, 'no measuring element remains after a key');
  };
  const field = new Textarea();
  key(field, 'KeyN');
  assert.equal(field.selectionStart, 6);
  assert.equal(field.scrollTop, 160, 'caret below the viewport is revealed');
  rect = { top: 8, left: 8, height: 20 };
  key(field, 'KeyP');
  assert.equal(field.selectionStart, 0);
  assert.equal(field.scrollTop, 0, 'caret above the viewport is revealed');
  field.scrollTop = 100;
  rect = { top: 120, left: 8, height: 20 };
  key(field, 'KeyN');
  assert.equal(field.scrollTop, 100, 'a visible caret does not move the viewport');

  const input = new Input();
  input.scrollWidth = 900;
  rect = { top: 8, left: 600, height: 20 };
  key(input, 'KeyE');
  assert.equal(input.scrollLeft, 369, 'single-line fields reveal horizontal movement');
  rect = { top: 8, left: 8, height: 20 };
  key(input, 'KeyA');
  assert.equal(input.scrollLeft, 0);

  const before = allocations;
  field.scrollHeight = field.clientHeight;
  key(field, 'KeyN');
  assert.equal(allocations, before, 'short inputs do not allocate a measuring element');
});
