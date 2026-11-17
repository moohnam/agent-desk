import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MarkdownParseCache } from '../../web/src/markdownParseCache.ts';
import { MARKDOWN_REMARK_PLUGINS, normalizeMathNotation } from '../../web/src/markdownMath.ts';

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);

test('cached syntax survives downstream mutation and returns independent position-preserving trees', () => {
  const source = '본문 **강조**\n\n| A | B |\n| - | - |\n| $x$ | `#tag` |';
  const expected = parser.parse(source);
  const cache = new MarkdownParseCache();
  let calls = 0;
  const read = () => cache.parse(source, () => { calls++; return parser.parse(source); });
  const first = read();
  first.children.splice(0, first.children.length);
  const second = read();
  assert.deepEqual(second, expected);
  second.position!.end.offset = 0;
  assert.deepEqual(read(), expected);
  assert.equal(calls, 1);
});

test('recently used syntax survives entry eviction while evicted syntax reparses normally', () => {
  const cache = new MarkdownParseCache({ entries: 2, bytes: 1_000_000, entryBytes: 100_000 });
  const calls: string[] = [];
  const read = (source: string) => cache.parse(source, () => { calls.push(source); return parser.parse(source); });
  read('first'); read('second'); read('first'); read('third'); read('first'); read('second');
  assert.deepEqual(calls, ['first', 'second', 'third', 'second']);
  assert.equal(cache.size, 2);
});

test('UTF-16 storage budget and single-entry limits bound source churn without truncating output', () => {
  const cache = new MarkdownParseCache({ entries: 256, bytes: 4096, entryBytes: 2048 });
  for (let i = 0; i < 1200; i++) {
    const source = '한글😀 ' + i + ' 본문';
    assert.deepEqual(cache.parse(source, () => parser.parse(source)), parser.parse(source));
    assert.ok(cache.retainedBytes <= 4096);
    assert.ok(cache.size <= 256);
  }
  const before = { size: cache.size, bytes: cache.retainedBytes };
  const large = '큰 본문 '.repeat(1000);
  assert.deepEqual(cache.parse(large, () => parser.parse(large)), parser.parse(large));
  assert.deepEqual({ size: cache.size, bytes: cache.retainedBytes }, before);
  const largeTree: Root = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'x'.repeat(5000) }] }] };
  assert.equal(cache.parse('small source, large tree', () => largeTree), largeTree);
  assert.deepEqual({ size: cache.size, bytes: cache.retainedBytes }, before);
});

test('normalization and repeated transforms share syntax without changing protected code or formulas', () => {
  const source = String.raw`**“핵심”**은 \(x^2\)입니다.
다음 줄 #review

\`\`\`mermaid
flowchart LR
 A["(\alpha) $5"] --> B
\`\`\`

[문서 (\alpha)](next.md)`.replaceAll('\\`', '`');
  const normalized = normalizeMathNotation(source);
  const processor = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS);
  const first = processor.runSync(processor.parse(normalized), { value: normalized }) as Root;
  for (let i = 0; i < 10; i++) {
    assert.equal(normalizeMathNotation(source), normalized);
    assert.deepEqual(processor.runSync(processor.parse(normalized), { value: normalized }), first);
  }
  const code = first.children.find(node => node.type === 'code');
  assert.equal(code?.type === 'code' ? code.value : undefined, 'flowchart LR\n A["(\\alpha) $5"] --> B');
});
