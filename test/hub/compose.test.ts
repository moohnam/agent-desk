import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionsIn, modelProblem, parseCompose, parseNoteCompose, wantedEngine } from '../../shared/compose.ts';

/** The parse with unset fields left out, as they would be in JSON. */
const parse = (text: string) => JSON.parse(JSON.stringify(parseCompose(text, ['review'], true)));

test('a leading @mention routes; the body loses the mention and the tags', () => {
  assert.deepEqual(parse('@web 고쳐줘'), { mention: { name: 'web' }, skills: [], body: '고쳐줘' });
  assert.deepEqual(parse('@web#3 #now 계속'), { mention: { name: 'web', no: 3 }, delivery: 'now', skills: [], body: '계속' });
});

test('@name:/path defines a project; engine, model and effort tags are read', () => {
  assert.deepEqual(parse('@new:~/x #codex #astra #high 시작'), {
    mention: { name: 'new', path: '~/x' }, engine: 'codex', model: 'astra', effort: 'high', skills: [], body: '시작',
  });
});

test('a mode tag alone is a mode switch with an empty body', () => {
  assert.deepEqual(parse('#auto'), { mode: 'auto', skills: [], body: '' });
});

test('known skills become skills; unknown tags stay in the text', () => {
  assert.deepEqual(parse('@a #opus #review 확인해'), { mention: { name: 'a' }, model: 'opus', skills: ['review'], body: '확인해' });
  assert.equal(parse('@d #unknown 텍스트').body, '#unknown 텍스트');
});

test('a mention later in the text does not route', () => {
  assert.equal(parse('hi @x#2 and @y').mention, undefined);
  assert.deepEqual(mentionsIn('ask @web#3 and @api'), [{ name: 'web', no: 3 }, { name: 'api', no: undefined }]);
});

test('a model names its engine; a model of another engine is a problem', () => {
  assert.equal(wantedEngine({ model: 'luna' }), 'codex');
  assert.equal(wantedEngine({ model: 'flash' }), 'agy');
  assert.equal(wantedEngine({ engine: 'codex' }), 'codex');
  assert.match(modelProblem('claude', { model: 'astra' }) ?? '', /Codex 모델/);
  assert.equal(modelProblem('claude', { model: 'opus', effort: 'high' }), null);
});

test('a leading exact note tag selects note creation and leaves ordinary mentions of the tag alone', () => {
  assert.equal(parseNoteCompose('  @웹 #note #codex @다른 메모  ')?.title, '#codex @다른 메모');
  assert.equal(parseNoteCompose('#note @웹 메모')?.mention?.name, '웹');
  assert.equal(parseNoteCompose('@웹 #note')?.title, '');
  assert.equal(parseNoteCompose('#note 제목')?.mention, undefined);
  for (const text of ['@웹 #notebook 메모', '@웹 제목 #note', '@웹 #NOTE 메모', '@웹 #note, 메모', '@웹 #codex #note 실행']) {
    assert.equal(parseNoteCompose(text), undefined);
  }
  assert.equal(parseCompose('@웹 기존 #note').body, '기존 #note');
  assert.deepEqual(parseCompose('@웹 기존 #note', ['note']).skills, ['note']);
  assert.deepEqual(parseCompose('#note 기존', ['note'], false).skills, ['note']);
});
