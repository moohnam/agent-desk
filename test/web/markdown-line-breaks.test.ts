import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { remarkLineBreaks } from '../../web/src/markdownLineBreaks.ts';

const parse = (text: string) => {
  const processor = unified().use(remarkParse).use(remarkLineBreaks);
  return processor.runSync(processor.parse(text)) as Root;
};

test('single newlines break prose lines while blank lines retain separate paragraphs', () => {
  const tree = parse('첫 줄\n둘째 줄\n\n다음 문단');
  assert.deepEqual(tree.children.map(n => n.type), ['paragraph', 'paragraph']);
  const first = tree.children[0];assert.equal(first.type, 'paragraph');
  if (first.type === 'paragraph') assert.deepEqual(first.children.map(n => n.type), ['text', 'break', 'text']);
});

test('existing hard breaks stay single; formatted text breaks but code and Mermaid stay untouched', () => {
  const tree = parse('첫 줄  \n둘째 줄\n\n**강조\n다음 줄**\n\n`한 줄\n코드`\n\n```mermaid\nflowchart LR\n A --> B\n```');
  const [hard, strong, inline, code] = tree.children;
  assert.equal(hard.type, 'paragraph');
  if (hard.type === 'paragraph') assert.equal(hard.children.filter(n => n.type === 'break').length, 1);
  if (strong.type === 'paragraph' && strong.children[0].type === 'strong')
    assert.deepEqual(strong.children[0].children.map(n => n.type), ['text', 'break', 'text']);
  else assert.fail('strong text missing');
  if (inline.type === 'paragraph') assert.equal(inline.children[0].type, 'inlineCode');
  else assert.fail('inline code missing');
  assert.equal(code.type, 'code');
  if (code.type === 'code') assert.equal(code.value, 'flowchart LR\n A --> B');
});
