import type { Parent, Root, RootContent } from 'mdast';
import type { PluggableList } from 'unified';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { remarkKoreanSuffixStrong } from './markdownKoreanStrong.ts';
import { remarkLineBreaks } from './markdownLineBreaks.ts';
import { remarkCachedParse } from './markdownParseCache.ts';

const notationParser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkCachedParse);
const protectedTypes = new Set(['code', 'inlineCode', 'link', 'image', 'linkReference', 'imageReference', 'definition', 'html', 'math', 'inlineMath']);
const command = /\\[a-zA-Z]+/;
// Legacy bare brackets are accepted only around a command or a compact equation.
const equation = /^[\w\s.+*/^{}()-]+=[\w\s.+*/^{}()=-]+$/;

/** Normalize alternate math notation outside Markdown code, links, HTML, and existing math. */
export function normalizeMathNotation(source: string): string {
  if (!/\\[([]|\([^\n)]*\\[a-zA-Z]|^\s*\[\s*$/m.test(source)) return source;
  const ranges: [number, number][] = [];
  const protect = (node: Root | RootContent) => {
    if (protectedTypes.has(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start != null && end != null) ranges.push([start, end]);
    } else if ('children' in node) {
      for (const child of node.children) protect(child as RootContent);
    }
  };
  protect(notationParser.parse(source));

  const normalize = (text: string) => text.replace(
    /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)|^([ \t]*)\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\](?=[ \t]*(?:\r?$))|(?<![\\\w])\(([^\n()]*\\[a-zA-Z][^\n()]*)\)/gm,
    (whole, display: string | undefined, inline: string | undefined, indent: string | undefined, legacyBlock: string | undefined, legacyInline: string | undefined) => {
      if (display != null) return `\n$$\n${display.trim()}\n$$\n`;
      if (inline != null) return `$${inline}$`;
      if (legacyBlock != null) return command.test(legacyBlock) || equation.test(legacyBlock.trim())
        ? `${indent}$$\n${legacyBlock.trim()}\n${indent}$$` : whole;
      return `$${legacyInline}$`;
    },
  );
  let result = '', cursor = 0;
  for (const [start, end] of ranges) {
    result += normalize(source.slice(cursor, start)) + source.slice(start, end);
    cursor = end;
  }
  return result + normalize(source.slice(cursor));
}

/** Avoid interpreting ordinary dollar amounts ("$5 and $10") as one math expression. */
function remarkDollarGuard() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      parent.children = parent.children.map((node) => {
        if ('children' in node) visit(node);
        if (node.type !== 'inlineMath') return node;
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start == null || end == null) return node;
        const raw = source.slice(start, end);
        if (!raw.startsWith('$$') && (/^\$\s|\s\$$|[\r\n]/.test(raw) || /\d/.test(source[end] ?? ''))) {
          return { type: 'text', value: raw, position: node.position };
        }
        return node;
      });
    };
    visit(tree);
  };
}

// Single tildes occur in ordinary prose ("1~2개", "~/path"). Keep their existing behavior.
export const MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }], remarkMath, remarkCachedParse, remarkDollarGuard, remarkKoreanSuffixStrong, remarkLineBreaks,
];
// rehype-katex catches per-formula errors and renders invalid input as escaped source.
export const MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  [rehypeKatex, { trust: false, strict: 'ignore', maxSize: 20, maxExpand: 1000 }],
];
