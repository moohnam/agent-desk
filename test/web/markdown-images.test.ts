import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownImageSource } from '../../web/src/markdownImageSource.ts';

test('Markdown only auto-loads image files beneath the document preview grant', () => {
  const base = '/_preview/grant/report.md';
  assert.deepEqual(markdownImageSource('./images/figure%201.PNG', base),
    { kind: 'local', src: '/_preview/grant/images/figure%201.PNG' });
  assert.deepEqual(markdownImageSource('figure.svg?v=2#detail', base),
    { kind: 'local', src: '/_preview/grant/figure.svg?v=2#detail' });
  for (const source of ['diagram.png', '/api/state']) assert.equal(markdownImageSource(source), undefined);
  for (const source of ['../a.png', '%2e%2e/a.png', 'images%2fa.png', '%252e%252e/a.png', '.hidden.png',
    '/diagram.png', '../api/state.png', 'a.css', 'a.html', 'a\\b.png']) {
    assert.equal(markdownImageSource(source, base), undefined, source);
  }
  assert.equal(markdownImageSource('a.png', 'https://other.example/_preview/grant/report.md'), undefined);
});

test('outside URLs have a per-image action and insecure URL forms stay inert', () => {
  for (const base of [undefined, '/_preview/grant/report.md']) {
    assert.deepEqual(markdownImageSource('https://images.example/a.png', base),
      { kind: 'external', src: 'https://images.example/a.png', host: 'images.example' });
    assert.deepEqual(markdownImageSource('//images.example/a.png', base),
      { kind: 'external', src: 'https://images.example/a.png', host: 'images.example' });
  }
  for (const source of ['file:///tmp/a.png', 'data:image/png;base64,a', 'https://user:secret@images.example/a.png',
    'https://', 'https:/images.example/a.png', 'javascript:alert(1)'])
    assert.equal(markdownImageSource(source, '/_preview/grant/report.md'), undefined, source);
});
