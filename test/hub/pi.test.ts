import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModelList, piModelId, toolView, variantName, withVariant } from '../../hub/src/runner/pi.ts';

test('pi model list parsing and family choice: newest version, then smallest', () => {
  const out = `provider  model            context  max-out  thinking  images
ollama    gemma4:12b       262.1K   16.4K    yes       yes
ollama    gemma4:26b-mlx   128K     16.4K    yes       no
ollama    gemma3:4b        128K     8K       no        no
ollama    qwen3.8:27b-mlx  128K     16.4K    yes       yes
`;
  const ids = parseModelList(out);
  assert.deepEqual(ids, ['gemma4:12b', 'gemma4:26b-mlx', 'gemma3:4b', 'qwen3.8:27b-mlx']);
  assert.equal(piModelId(ids, 'gemma'), 'gemma4:12b');
  assert.equal(piModelId(ids, 'qwen'), 'qwen3.8:27b-mlx');
  assert.equal(piModelId(ids, 'llama'), undefined);
});

test('pi tool calls show as the desk tools: commands as Bash, files by path', () => {
  assert.deepEqual(toolView('bash', { command: 'ls -la', timeout: 5 }), { name: 'Bash', input: { command: 'ls -la' } });
  assert.deepEqual(toolView('edit', { path: '/p/a.ts', oldText: 'a', newText: 'b' }), { name: 'Edit', input: { file_path: '/p/a.ts', oldText: 'a', newText: 'b' } });
  assert.equal(toolView('write', { path: '/p/b.md', content: 'x'.repeat(10_000) }).input.content.length < 10_000, true);
  assert.deepEqual(toolView('mcp__x', { q: 1 }), { name: 'mcp__x', input: { q: 1 } });
});

test('context variants: named per size, registered with pi once, never picked as a base model', () => {
  assert.equal(variantName('gemma4:12b', 65536), 'gemma4:12b-desk-64k');
  assert.equal(variantName('llama3', 32768), 'llama3:latest-desk-32k');
  assert.equal(piModelId(['gemma4:12b', 'gemma4:12b-desk-64k', 'gemma4:12b-desk-32k'], 'gemma'), 'gemma4:12b');
  const doc = { providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'gemma4:12b', contextWindow: 262144, reasoning: true }] }, other: { x: 1 } } };
  const next = withVariant(doc, 'gemma4:12b', 'gemma4:12b-desk-64k', 65536);
  assert.deepEqual(next.providers.ollama.models[1], { id: 'gemma4:12b-desk-64k', contextWindow: 65536, reasoning: true });
  assert.deepEqual(next.providers.ollama.models[0], doc.providers.ollama.models[0]);
  assert.deepEqual(next.providers.other, { x: 1 });
  assert.equal(withVariant(next, 'gemma4:12b', 'gemma4:12b-desk-64k', 65536), null);
  assert.throws(() => withVariant({ providers: {} }, 'a', 'b', 1), /ollama/);
});
