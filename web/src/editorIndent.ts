import { imeKey } from './keys.ts';

const unit = '  ';
const lineStart = (text: string, at: number) => at ? text.lastIndexOf('\n', at - 1) + 1 : 0;
const leading = /^[ \t]*/;

export function indentationKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || imeKey(event)) return;
  if (event.key === 'Tab') return event.shiftKey ? 'outdent' : 'indent';
  if (event.key === 'Enter') return 'newline';
}

type Edit = { from: number; to: number; insert: string };
type Indent = 'indent' | 'outdent';

export function breakLine(text: string, start: number, end: number): Edit {
  const indent = leading.exec(text.slice(lineStart(text, start), start))![0];
  return { from: start, to: end, insert: '\n' + indent };
}

export function indentLines(key: Indent, text: string, start: number, end: number): Edit[] {
  const edits: Edit[] = [];
  // A selection ending at the beginning of the next line excludes that line.
  const last = lineStart(text, end > start && text[end - 1] === '\n' ? end - 1 : end);
  for (let from = lineStart(text, start); from <= last;) {
    if (key === 'indent') edits.push({ from, to: from, insert: unit });
    else {
      const removed = /^(?: ?\t| {1,2})/.exec(text.slice(from, from + unit.length))?.[0].length;
      if (removed) edits.push({ from, to: from + removed, insert: '' });
    }
    if (from === last) break;
    from = text.indexOf('\n', from) + 1;
  }
  return edits;
}

/** A textarea needs one native replacement for undo, even across several selected lines. */
export function indentTextarea(key: Indent, text: string, start: number, end: number) {
  const edits = indentLines(key, text, start, end);
  if (!edits.length) return;
  const from = edits[0].from;
  let to = from, insert = '', newStart = start, newEnd = end;
  for (const edit of edits) {
    insert += text.slice(to, edit.from) + edit.insert;
    to = edit.to;
    const delta = (at: number) => at < edit.from ? 0 : edit.insert.length - Math.min(edit.to - edit.from, at - edit.from);
    newStart += delta(start);
    newEnd += delta(end);
  }
  return { from, to, insert, start: newStart, end: newEnd };
}
