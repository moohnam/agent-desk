// 실행: node perf-bench/cache.mjs > /tmp/desk-cache.json
// 실제 파서와 캐시를 사용한다. Node 단독 비용이며 브라우저 렌더링/전체 메모리 측정이 아니다.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MarkdownParseCache } from '../web/src/markdownParseCache.ts';
import { events } from './data.mjs';

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
const sources = events(600).map(e => e.payload.text);
const cases = {
  repeat: Array(600).fill(sources[0]),
  unique: sources,
  revisit: [...sources, ...sources.slice(-80), ...sources.slice(0, 80)],
};
// 준비 실행 후, 각 측정은 빈 캐시에서 시작한다.
for (const source of sources.slice(0, 30)) parser.parse(source);
const results = [];
for (let run = 0; run < 3; run++) {
  for (const [name, input] of Object.entries(cases)) {
    for (const enabled of run % 2 ? [true, false] : [false, true]) {
      const cache = new MarkdownParseCache();
      const times = [];
      for (const source of input) {
        const start = performance.now();
        const tree = enabled ? cache.parse(source, () => parser.parse(source)) : parser.parse(source);
        times.push(performance.now() - start);
        assert.equal(tree.type, 'root');
        assert.ok(tree.children.length > 0);
        assert.ok(cache.retainedBytes <= cache.stats().limits.bytes);
        assert.ok(cache.size <= cache.stats().limits.entries);
      }
      const sorted = times.toSorted((a, b) => a - b);
      results.push({ run, name, enabled, calls: input.length,
        totalMs: times.reduce((a, b) => a + b, 0),
        p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], cache: cache.stats() });
    }
  }
}
console.log(JSON.stringify({ node: process.version, processor: cpus()[0]?.model,
  scope: '고정 긴 Markdown 본문, 실제 파서·기본 캐시 상한, 3회. AST 파싱/복제/직렬화만 측정. 전체 메모리나 UI 지연 아님.', results }, null, 2));
