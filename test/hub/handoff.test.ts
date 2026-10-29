import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDOFF_END, HANDOFF_START, extractHandoff, quoteEvent } from '../../hub/src/handoff.ts';

test('the summary is the text between the markers', () => {
  assert.equal(extractHandoff(`앞말\n${HANDOFF_START}\n# 목표\n정리\n${HANDOFF_END}\n뒷말`)?.trim(), '# 목표\n정리');
  assert.equal(extractHandoff('표시 없는 답'), null);
});

test('user and assistant posts quote; tool events do not', () => {
  const ts = '2026-10-29T10:00:00.000Z';
  assert.deepEqual(quoteEvent({ kind: 'user', ts, payload: { text: '해 줘' } })?.text, '해 줘');
  assert.deepEqual(quoteEvent({ kind: 'assistant', ts, payload: { text: '했어요' } })?.text, '했어요');
  assert.equal(quoteEvent({ kind: 'tool', ts, payload: { name: 'Bash' } }), null);
});
