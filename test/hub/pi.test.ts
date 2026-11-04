import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcesNextStep, ollamaModelFor, parseModelList, piModelId, toolView, variantName, withVariant } from '../../hub/src/runner/pi.ts';

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

test('a reply that only announces its next step is told apart from a finished one or a question', () => {
  assert.equal(announcesNextStep('네, 파악할 수 있습니다.\n\n현재 어떤 작업을 진행 중이었는지 파악하기 위해 목록부터 확인해 보겠습니다.'), true);
  assert.equal(announcesNextStep('README를 읽었습니다. 이제 tts.py를 살펴볼게요'), true);
  assert.equal(announcesNextStep("Let me check the tests next."), true);
  assert.equal(announcesNextStep('파일을 만들었고 테스트도 통과했습니다.'), false);
  assert.equal(announcesNextStep('어느 방식으로 진행할까요? 확인해 주시면 바로 하겠습니다?'), false);
  assert.equal(announcesNextStep('1번과 2번 중 무엇을 원하시나요?'), false);
  assert.equal(announcesNextStep(''), false);
  assert.equal(announcesNextStep('먼저 구조를 파악해 보겠습니다.\n\n[현재 디렉토리의 파일 목록을 확인합니다.](bash://ls -R)'), true);
  assert.equal(announcesNextStep('목록을 봅니다.\n\n```bash\nls -la\n```'), true);
  assert.equal(announcesNextStep('자세한 내용은 [문서](https://example.com/docs)를 참고하세요.'), false);
  assert.equal(announcesNextStep('수정한 파일: [calc.py](/tmp/p/calc.py)'), false);
});

test('a pi model Ollama lists under another name is found by family, version and size', () => {
  const names = ['gemma4:12b', 'gemma4:26b-mlx', 'hf.co/lmstudio-community/Qwen3.8-27B-GGUF:Q4_K_M', 'gemma4:12b-desk-32k'];
  assert.equal(ollamaModelFor('gemma4:12b', 'gemma', names), 'gemma4:12b');
  assert.equal(ollamaModelFor('qwen3.8:27b-mlx', 'qwen', names), 'hf.co/lmstudio-community/Qwen3.8-27B-GGUF:Q4_K_M');
  assert.equal(ollamaModelFor('qwen3.8:7b', 'qwen', names), undefined);
  assert.equal(ollamaModelFor('qwen3.8:27b', 'qwen', [...names, 'qwen3.8:27b-q8']), undefined, 'two candidates: no guess');
});
