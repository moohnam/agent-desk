import type { Parent, Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export const slackEmoji = new Map([
  [':+1:', '👍'], [':thumbsup:', '👍'], [':-1:', '👎'], [':thumbsdown:', '👎'],
  [':smile:', '😄'], [':cry:', '😢'], [':sob:', '😭'], [':rofl:', '🤣'], [':tada:', '🎉'],
  [':heart:', '❤️'], [':eyes:', '👀'], [':white_check_mark:', '✅'],
]);

const draftParser = unified().use(remarkParse);

/** Suppress completion in Markdown code, including an inline span still being typed. */
export function inDraftCode(before: string): boolean {
  if (!/[\x60~\t]| {4}/.test(before)) return false;
  const atEnd = (node: Root | RootContent): boolean => {
    if (node.position?.end.offset !== before.length) return false;
    if (node.type === 'code') return true;
    if (node.type === 'paragraph' || node.type === 'heading') {
      return node.children.some(child => {
        if (child.type !== 'text' || !child.value.includes('\x60')) return false;
        const raw = before.slice(child.position?.start.offset, child.position?.end.offset);
        return raw.replace(/\\[\\\x60]/g, '').includes('\x60');
      });
    }
    if ('children' in node) {
      const last = node.children.at(-1);
      return last ? atEnd(last) : false;
    }
    return false;
  };
  return atEnd(draftParser.parse(before));
}

const codePattern = /:[a-z0-9_+-]+:/gi;
const writtenCodePattern = /(?:(\\+)?:|&(?:colon|#0*58|#x0*3a);)([a-z0-9_+-]+)(?:(\\+)?:|&(?:colon|#0*58|#x0*3a);)/gi;
const numericReference = /&#(?:(\d{1,7})|x([a-f0-9]{1,6}));/gi;

/** Change Markdown prose without rewriting the source, code, or link destinations. */
export function remarkSlackEmoji() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      for (const child of parent.children) {
        if (child.type === 'text' && child.value.includes(':')) {
          const start = child.position?.start.offset, end = child.position?.end.offset;
          const raw = start != null && end != null ? source.slice(start, end) : child.value;
          // The parser has already decoded escapes and character references. Compare the
          // written and parsed tokens in order before treating ambiguous punctuation as syntax.
          let written: RegExpExecArray[] | undefined;
          if (raw !== child.value && /\\:|&/.test(raw)) {
            const normalized = raw.replace(numericReference, (reference, decimal: string | undefined, hex: string) => {
              const code = decimal ? Number(decimal) : parseInt(hex, 16);
              const char = code <= 127 ? String.fromCharCode(code) : '';
              return /^[a-z0-9_+-]$/i.test(char) ? char : reference;
            });
            const tokens = [...normalized.matchAll(writtenCodePattern)];
            const codes = [...child.value.matchAll(codePattern)];
            if (tokens.length !== codes.length || codes.some(([code], i) => code !== ':' + tokens[i][2] + ':')) continue;
            written = tokens;
          }
          let index = 0;
          child.value = child.value.replace(codePattern, code => {
            const token = written?.[index++];
            if (token && (token[0].includes('&') || (token[1]?.length ?? 0) % 2 || (token[3]?.length ?? 0) % 2)) return code;
            return slackEmoji.get(code.toLowerCase()) ?? code;
          });
        } else if ('children' in child && child.type !== 'link' && child.type !== 'linkReference') {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}
