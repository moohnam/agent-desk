import type { Position } from 'unist';
import { normalizeMathNotation } from './markdownMath.ts';

/** The rendered positions refer to normalized math. Translate them back before taking a source slice. */
export function prepareMarkdown(original: string) {
  // The parser never includes the leading byte-order mark in source positions.
  const source = original.startsWith('\ufeff') ? original.slice(1) : original;
  const replacements: { start: number; end: number; sourceStart: number; shift: number }[] = [];
  let shift = 0;
  const text = normalizeMathNotation(source, (sourceStart, matched, replacement) => {
    const start = sourceStart + shift;
    shift += replacement.length - matched.length;
    replacements.push({ start, end: start + replacement.length, sourceStart, shift });
  });
  const toSource = (offset: number, end: boolean) => {
    for (let i = replacements.length - 1; i >= 0; i--) {
      const replacement = replacements[i];
      if (offset <= replacement.start) continue;
      if (offset >= replacement.end) return offset - replacement.shift;
      return end ? replacement.end - replacement.shift : replacement.sourceStart;
    }
    return offset;
  };
  return { text, blockSource(position: Position) {
    const start = toSource(position.start.offset ?? 0, false);
    const end = toSource(position.end.offset ?? text.length, true);
    // Include the first line's list or blockquote prefix, as on the following source lines.
    const lineStart = start === 0 ? 0 : Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1;
    return source.slice(lineStart, end);
  } };
}
