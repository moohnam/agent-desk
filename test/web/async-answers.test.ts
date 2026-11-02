import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncAnswerText } from '../../web/src/asyncAnswers.ts';
import { parseCompose } from '../../shared/compose.ts';

const questions = [
  { title: '어느 환경에 적용할까요?', options: ['개발', '운영'] },
  { title: '언제 실행할까요?', options: ['지금', '내일'] },
  { title: '추가 조건을 알려주세요.', options: [] },
];

test('an async batch waits for every answer, including questions without options', () => {
  assert.equal(asyncAnswerText(questions, []), null);
  assert.equal(asyncAnswerText(questions, ['개발']), null);
  assert.equal(asyncAnswerText(questions, ['개발', '내일', '  ']), null);
  assert.equal(asyncAnswerText(questions, ['개발', '', '추가 조건']), null);
  assert.equal(asyncAnswerText([], []), null);
});

test('all answers are sent in one message, paired with their questions in order', () => {
  assert.equal(asyncAnswerText(questions, [' 개발 ', '내일', '오전 9시\n점검 후 실행']),
    '1. 개발\n\n2. 내일\n\n3. 오전 9시\n점검 후 실행');
});

test('control tags mentioned in question titles cannot change the reply delivery or session settings', () => {
  const qs = [{ title: '#auto #new #sol 로 바꿀까요?', options: ['아니요'] }, questions[1]];
  const text = asyncAnswerText(qs, ['아니요', '내일']);
  assert.equal(text, '1. 아니요\n\n2. 내일');
  const reply = parseCompose(`${text} #now`, [], false);
  assert.equal(reply.delivery, 'now');
  assert.equal(reply.mode, undefined);
  assert.equal(reply.model, undefined);
});

test('a single async answer retains the existing plain reply format', () => {
  assert.equal(asyncAnswerText(questions.slice(0, 1), [' 개발 ']), '개발');
  assert.equal(asyncAnswerText(questions.slice(2), [' 직접 입력 ']), '직접 입력');
});
