/**
 * Emacs editing keys in every text field, whatever the input source (a Korean one included): keys
 * are read by position (`code`), not by the character they would type. Option is Alt (Meta): it
 * moves and deletes by word and never types its special characters (∫, ƒ …).
 *
 * Only on a Mac, where Ctrl is free; elsewhere Ctrl+A, Ctrl+F … are the system's own shortcuts.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;

const WORD = /[\p{L}\p{N}_]/u;
/** Alt with one of these types a special character on a Mac; with Option as Alt it types nothing. */
const CHAR_KEY = /^(Key.|Digit.|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Space|IntlBackslash)$/;

/** Text killed by Ctrl+K / Alt+D, put back by Ctrl+Y. */
let killed = '';

function textField(t: EventTarget | null): Field | null {
  if (t instanceof HTMLTextAreaElement) return t;
  if (t instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'password', ''].includes(t.type)) return t;
  return null;
}

const lineStart = (v: string, i: number) => v.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (v: string, i: number) => { const n = v.indexOf('\n', i); return n < 0 ? v.length : n; };

function wordForward(v: string, i: number) {
  while (i < v.length && !WORD.test(v[i])) i++;
  while (i < v.length && WORD.test(v[i])) i++;
  return i;
}
function wordBack(v: string, i: number) {
  while (i > 0 && !WORD.test(v[i - 1])) i--;
  while (i > 0 && WORD.test(v[i - 1])) i--;
  return i;
}

function moveTo(el: Field, i: number) {
  el.setSelectionRange(i, i);
  revealCaret(el);
}

/** Custom selection changes do not reliably scroll a text control like native key movement. */
function revealCaret(el: Field) {
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return;
  const doc = el.ownerDocument, style = getComputedStyle(el);
  const mirror = doc.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;border:0;box-sizing:border-box';
  for (const property of ['font', 'line-height', 'letter-spacing', 'word-spacing', 'tab-size', 'text-indent', 'text-transform', 'direction', 'padding']) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  mirror.style.width = `${el.clientWidth}px`;
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement && el.wrap !== 'off' ? 'pre-wrap' : 'pre';
  mirror.style.overflowWrap = 'break-word';
  // Password fields must never copy their clear text into the document.
  const value = el instanceof HTMLInputElement && el.type === 'password' ? '•'.repeat(el.value.length) : el.value;
  const at = el.selectionDirection === 'backward' ? el.selectionStart ?? 0 : el.selectionEnd ?? 0;
  mirror.textContent = value.slice(0, at);
  const marker = doc.createElement('span');
  marker.textContent = value.slice(at) || '\u200b';
  mirror.append(marker);
  doc.body.append(mirror);
  try {
    const box = mirror.getBoundingClientRect(), caret = marker.getClientRects()[0];
    if (!caret) return;
    const top = caret.top - box.top, left = caret.left - box.left;
    const bottom = top + caret.height;
    const padTop = parseFloat(style.paddingTop) || 0, padBottom = parseFloat(style.paddingBottom) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0, padRight = parseFloat(style.paddingRight) || 0;
    if (top < el.scrollTop + padTop) el.scrollTop = top - padTop;
    else if (bottom > el.scrollTop + el.clientHeight - padBottom) el.scrollTop = bottom - el.clientHeight + padBottom;
    if (left < el.scrollLeft + padLeft) el.scrollLeft = left - padLeft;
    else if (left + 1 > el.scrollLeft + el.clientWidth - padRight) el.scrollLeft = left + 1 - el.clientWidth + padRight;
  } finally { mirror.remove(); }
}

/** Replaces from..to as typing would: undo works and React's onChange sees it. */
function replace(el: Field, from: number, to: number, text: string) {
  if (from === to && !text) return;
  el.setSelectionRange(from, to);
  const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (!ok) {
    el.setRangeText(text, from, to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  revealCaret(el);
}

/** Ctrl+N / Ctrl+P: the field's completion list if one is open (or the field is one line), else a line. */
function upDown(el: Field, down: boolean) {
  const list = el.parentElement?.querySelector('.ac');
  if (list || el instanceof HTMLInputElement) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: down ? 'ArrowDown' : 'ArrowUp', code: down ? 'ArrowDown' : 'ArrowUp', bubbles: true, cancelable: true }));
    return;
  }
  const v = el.value, i = el.selectionStart ?? 0;
  const start = lineStart(v, i), col = i - start;
  if (down) {
    const end = lineEnd(v, i);
    if (end >= v.length) return moveTo(el, v.length);
    const next = end + 1;
    moveTo(el, Math.min(next + col, lineEnd(v, next)));
  } else {
    if (start === 0) return moveTo(el, 0);
    const prev = lineStart(v, start - 1);
    moveTo(el, Math.min(prev + col, start - 1));
  }
}

/** The action for a key, or null to leave the key alone. */
function action(e: KeyboardEvent, el: Field): (() => void) | null {
  const v = () => el.value;
  const at = () => el.selectionStart ?? 0;
  const atEnd = () => el.selectionEnd ?? at();
  if (e.ctrlKey && !e.altKey && !e.shiftKey) {
    switch (e.code) {
      case 'KeyA': return () => moveTo(el, lineStart(v(), at()));
      case 'KeyE': return () => moveTo(el, lineEnd(v(), atEnd()));
      case 'KeyB': return () => moveTo(el, Math.max(at() - (at() === atEnd() ? 1 : 0), 0));
      case 'KeyF': return () => moveTo(el, Math.min(atEnd() + (at() === atEnd() ? 1 : 0), v().length));
      case 'KeyN': return () => upDown(el, true);
      case 'KeyP': return () => upDown(el, false);
      case 'KeyD': return () => replace(el, at(), at() === atEnd() ? Math.min(at() + 1, v().length) : atEnd(), '');
      case 'KeyH': return () => replace(el, at() === atEnd() ? Math.max(at() - 1, 0) : at(), atEnd(), '');
      case 'KeyK': return () => {
        const i = at(), end = lineEnd(v(), i);
        const to = end === i ? Math.min(i + 1, v().length) : end;
        killed = v().slice(i, to);
        replace(el, i, to, '');
      };
      case 'KeyY': return () => { if (killed) replace(el, at(), atEnd(), killed); };
      // As in a shell: back to the previous space (a selection: cut it).
      case 'KeyW': return () => {
        const i = at(), to = atEnd();
        let from = i;
        if (from === to) { while (from > 0 && /\s/.test(v()[from - 1])) from--; while (from > 0 && !/\s/.test(v()[from - 1])) from--; }
        killed = v().slice(from, to);
        replace(el, from, to, '');
      };
      default: return null;
    }
  }
  if (e.altKey && !e.ctrlKey) {
    switch (e.code) {
      case 'KeyB': return () => moveTo(el, wordBack(v(), at()));
      case 'KeyF': return () => moveTo(el, wordForward(v(), atEnd()));
      case 'KeyD': return () => { const i = at(), to = wordForward(v(), i); killed = v().slice(i, to); replace(el, i, to, ''); };
      case 'Backspace': return () => { const i = at(), from = wordBack(v(), i); killed = v().slice(from, i); replace(el, from, i, ''); };
      // Option types nothing else: no ∫, ƒ, ¬ … (Alt+arrows and other keys keep their own meaning).
      default: return CHAR_KEY.test(e.code) ? () => {} : null;
    }
  }
  return null;
}

export function installEmacsKeys() {
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) return;
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || !(e.ctrlKey || e.altKey)) return;
    const el = textField(e.target);
    if (!el || el.readOnly || el.disabled) return;
    const run = action(e, el);
    if (!run) return;
    e.preventDefault();
    if (!e.isComposing) { run(); return; }
    // Mid-composition (a Korean syllable being typed): act once the IME has committed it.
    let done = false;
    const go = () => { if (!done) { done = true; el.removeEventListener('compositionend', go); setTimeout(run); } };
    el.addEventListener('compositionend', go);
    setTimeout(go, 50);
  }, true);
}
