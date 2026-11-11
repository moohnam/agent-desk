import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkKoreanSuffixStrong } from '../web/src/markdownKoreanStrong.ts';

function render(source: string): string {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkKoreanSuffixStrong],
  }, source));
}

test('renders closing punctuation before a Korean suffix as strong without changing visible text', () => {
  const source = '읽었습니다. 윤옥님의 보고서는 **“Jev 같은 판정 모델을 검색에 어떻게 활용해야 하는가”**를 설명합니다.';
  assert.equal(render(source), '<p>읽었습니다. 윤옥님의 보고서는 <strong>“Jev 같은 판정 모델을 검색에 어떻게 활용해야 하는가”</strong>를 설명합니다.</p>');
  assert.equal(render('**문장.**은 핵심입니다. **질문?**에 답합니다.'), '<p><strong>문장.</strong>은 핵심입니다. <strong>질문?</strong>에 답합니다.</p>');
  assert.equal(render('**“A”**를, **“B”**는'), '<p><strong>“A”</strong>를, <strong>“B”</strong>는</p>');
  assert.equal(render('(**“A”**를)와 **문장.**은'), '<p>(<strong>“A”</strong>를)와 <strong>문장.</strong>은</p>');
});

test('preserves escaped stars, code, links, images, and ordinary Markdown', () => {
  assert.equal(render(String.raw`\*\*“문장”\*\*를`), '<p>**“문장”**를</p>');
  assert.equal(render('`**“문장”**를`'), '<p><code>**“문장”**를</code></p>');
  assert.equal(render('```mermaid\ngraph TD; A["**“문장”**를"]\n```'), '<pre><code class="language-mermaid">graph TD; A[&quot;**“문장”**를&quot;]\n</code></pre>');
  assert.equal(render('[링크](https://example.com/**“문장”**를) ![그림](https://example.com/**“문장”**를)'), '<link rel="preload" as="image" href="https://example.com/**%E2%80%9C%EB%AC%B8%EC%9E%A5%E2%80%9D**%EB%A5%BC"/><p><a href="https://example.com/**%E2%80%9C%EB%AC%B8%EC%9E%A5%E2%80%9D**%EB%A5%BC">링크</a> <img src="https://example.com/**%E2%80%9C%EB%AC%B8%EC%9E%A5%E2%80%9D**%EB%A5%BC" alt="그림"/></p>');
  assert.equal(render('**일반 강조**와 *기울임*'), '<p><strong>일반 강조</strong>와 <em>기울임</em></p>');
  assert.equal(render('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(render('A &amp; **“B”**는'), '<p>A &amp; **“B”**는</p>');
  assert.equal(render('**“A `x`”**를'), '<p>**“A <code>x</code>”**를</p>');
  assert.equal(render('**“A [x](https://example.com)”**를'), '<p>**“A <a href="https://example.com">x</a>”**를</p>');
  assert.equal(render('말**“A”**를 ** “B”**는 ****“C”**를 ***“D”**를'), '<p>말**“A”**를 ** “B”**는 ****“C”**를 ***“D”**를</p>');
});
