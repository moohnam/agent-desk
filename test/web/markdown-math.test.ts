import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, normalizeMathNotation } from '../../web/src/markdownMath.ts';
import { inDraftCode } from '../../web/src/slackEmoji.ts';

test('emoji completion detects Markdown blocks and unfinished inline code at the caret', () => {
  for (const draft of ['예시:\n\n    :ro', '\t:ro', '>     :ro', '- 예시:\n\n      :ro',
    '~~~text\n:ro', '인라인 \x60\x60코드 :ro']) assert.equal(inDraftCode(draft), true, draft);
  for (const draft of ['인라인 \x60코드\\\x60 뒤 :ro', '인라인 \\\x60문자 뒤 :ro', '예시\n    문단의 :ro',
    '~~~text\n코드\n~~~\n문장 :ro']) assert.equal(inDraftCode(draft), false, draft);
});
import { prepareMarkdown } from '../../web/src/markdownSource.ts';

const render = (source: string) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins: MARKDOWN_REMARK_PLUGINS, rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
}, normalizeMathNotation(source)));

test('renders inline and display formulas as KaTeX HTML with accessible MathML', () => {
  const html = render(String.raw`평균 $c=\frac{S}{N}$입니다.

$$
S \leftarrow (1-\alpha)S+\alpha s
$$`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<mfrac>/);
  assert.doesNotMatch(html, /katex-error/);
});

test('normalizes standard delimiters and the reported legacy average example', () => {
  const standard = render(String.raw`\(x_i^2+1\)

\[
\frac{S}{N}
\]`);
  assert.equal((standard.match(/class="katex"/g) ?? []).length, 2);
  assert.match(standard, /class="katex-display"/);
  const source = String.raw`새 배치의 합 (s), 개수 (n).
[
S \leftarrow (1-\alpha)S+\alpha s
]

[
N \leftarrow (1-\alpha)N+\alpha n
]

[
c=S/N
]
여기서 (\alpha)는 반영 비율이고 과거 유지율 (\gamma=1-\alpha)로도 씁니다.`;
  const html = render(source);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 3);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 5);
  assert.match(html, /합 \(s\), 개수 \(n\)/);
  assert.doesNotMatch(html, /katex-error/);
});

test('leaves code, Mermaid, links, arrays, prose brackets, and escaped dollar signs intact', () => {
  const source = String.raw`코드: \`$x$ \(x\) (\alpha)\`

\`\`\`mermaid
flowchart LR
 A["(\alpha) $5"] --> B
\`\`\`

[문서 (\alpha)](/tmp/report.md) ![그림](./image.png)

[1, 2, 3]와 (s), (n)
[
일반 문장
]
가격 \$5와 \$10입니다.`.replaceAll('\\`', '`');
  const html = render(source);
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /<code>\$x\$ \\\(x\\\) \(\\alpha\)<\/code>/);
  assert.match(html, /class="language-mermaid"/);
  assert.match(html, /href="\/tmp\/report.md"/);
  assert.match(html, /가격 \$5와 \$10입니다/);
  assert.match(html, /\[1, 2, 3\]와 \(s\), \(n\)/);
  assert.equal(normalizeMathNotation(source), source);
});

test('keeps dollar amounts literal while retaining intentional numeric formulas', () => {
  for (const source of ['가격 $5와 $10입니다.', '비용 $5~$10', '비용 $5, $10, $20입니다.', '$ 미완성 수식']) {
    assert.doesNotMatch(render(source), /class="katex"/);
    assert.match(render(source), /\$/);
  }
  assert.match(render('$2+2=4$'), /class="katex"/);
});

test('isolates malformed formulas and disables HTML, external resources, and trusted commands', () => {
  const html = render(String.raw`앞 $\frac{1}{$ 뒤 $x^2$ 끝

$\href{javascript:alert(1)}{누르기}$
$\includegraphics{https://example.com/track.png}$
$\htmlClass{injected}{x}$

<script>alert(1)</script>`);
  assert.match(html, /katex-error/);
  assert.match(html, /뒤 <span class="katex"/);
  assert.match(html, /끝/);
  assert.doesNotMatch(html, /<script|<a\b|<img\b|class="injected"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotThrow(() => render(String.raw`$\def\x{\x}\x$ 정상 본문`));
});

test('math coexists with Korean strong text, soft breaks, and untouched code AST nodes', () => {
  const html = render('**“핵심”**은 $x$입니다.\n다음 줄\n\n1~2개와 ~~취소~~');
  assert.match(html, /<strong>“핵심”<\/strong>은/);
  assert.match(html, /입니다\.<br\/>\n다음 줄/);
  assert.match(html, /1~2개와 <del>취소<\/del>/);
  const parser = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS);
  const text = '```mermaid\nflowchart LR\n A["$x$"] --> B\n```\n\n`$x$`';
  const tree = parser.runSync(parser.parse(text)) as Root;
  assert.equal(tree.children[0].type, 'code');
  if (tree.children[0].type === 'code') assert.equal(tree.children[0].value, 'flowchart LR\n A["$x$"] --> B');
  assert.equal(tree.children[1].type, 'paragraph');
  if (tree.children[1].type === 'paragraph') assert.equal(tree.children[1].children[0].type, 'inlineCode');
});

test('copy uses the original source of rendered code and tables after math normalization', () => {
  const blocks = [
    ['> ~~~~ts linenums', '>   const n = 3;', '> ~~~~'].join('\r\n'),
    [String.raw`| \(x^2\) | *값* |`, '| :--- | ---: |', String.raw`| a\|b | \(\alpha\) |`].join('\r\n'),
    ['```mermaid', 'graph LR', '    A --> B', '```'].join('\r\n'),
    '    indented code',
  ];
  const source = '\ufeff' + [String.raw`한글과 이모지 🍀 \(\sqrt{2}\)`, String.raw`\[\alpha\]`, ...blocks, '끝'].join('\r\n\r\n');
  const { text, blockSource } = prepareMarkdown(source);
  assert.notEqual(text, source);
  const result: string[] = [];
  const collect = ({ node }: ExtraProps) => { result.push(blockSource(node!.position!)); return null; };
  renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: MARKDOWN_REMARK_PLUGINS, rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
    components: { pre: collect, table: collect },
  }, text));
  assert.deepEqual(result, blocks);
});
