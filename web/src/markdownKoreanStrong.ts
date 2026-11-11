import type { Paragraph, PhrasingContent, Root, RootContent, Text } from 'mdast';

// CommonMark leaves `**“quoted text”**를` literal: the closing stars follow punctuation
// and precede a letter, so they cannot close a strong delimiter. Repair only plain
// paragraph text whose source is unchanged by Markdown parsing (not escaped stars).
const KOREAN_SUFFIX_STRONG = /\*\*([^\n*]+?[\p{P}\p{S}])\*\*(?=[가-힣])/gu;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

function validOpening(value: string, index: number, content: string): boolean {
  const before = value[index - 1];
  const after = content[0];
  if (before === '*' || /\s/u.test(after)) return false;
  // For `*`, CommonMark's left-flanking rule requires whitespace or punctuation
  // before an opener when the character after it is punctuation.
  return !UNICODE_PUNCTUATION.test(after) || before == null || /\s/u.test(before) || UNICODE_PUNCTUATION.test(before);
}

function splitText(node: Text, source: string): PhrasingContent[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null || source.slice(start, end) !== node.value) return [node];

  const result: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of node.value.matchAll(KOREAN_SUFFIX_STRONG)) {
    const index = match.index;
    if (!validOpening(source, start + index, match[1])) continue;
    if (index > cursor) result.push({ type: 'text', value: node.value.slice(cursor, index) });
    result.push({ type: 'strong', children: [{ type: 'text', value: match[1] }] });
    cursor = index + match[0].length;
  }
  if (!result.length) return [node];
  if (cursor < node.value.length) result.push({ type: 'text', value: node.value.slice(cursor) });
  return result;
}

function repair(node: Root | RootContent, source: string): void {
  if (node.type === 'paragraph') {
    (node as Paragraph).children = node.children.flatMap((child) => child.type === 'text' ? splitText(child, source) : [child]);
  } else if ('children' in node) {
    for (const child of node.children) repair(child as RootContent, source);
  }
}

export function remarkKoreanSuffixStrong() {
  return (tree: Root, file: { value: unknown }) => {
    if (typeof file.value === 'string') repair(tree, file.value);
  };
}
