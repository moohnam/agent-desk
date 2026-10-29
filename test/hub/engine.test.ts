import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESULT_TEXT, StderrTail, TurnQueue, clipResult } from '../../hub/src/runner/engine.ts';

/** A queue whose turns and busy reports are recorded. */
function queue(ready = true) {
  const ran: string[] = [], busy: boolean[] = [];
  const q = new TurnQueue<string>((t) => ran.push(t), (b) => busy.push(b), ready);
  return { q, ran, busy };
}

test('a message runs at once when idle; one sent mid-turn waits for the turn to end', () => {
  const { q, ran, busy } = queue();
  q.push('a'); q.push('b');
  assert.deepEqual(ran, ['a']);
  q.ended();
  assert.deepEqual(ran, ['a', 'b']);
  q.ended();
  assert.deepEqual(busy, [false], 'idle once the last turn ends');
  assert.equal(q.active, false);
});

test('messages before the session is ready wait for open()', () => {
  const { q, ran } = queue(false);
  q.push('first');
  assert.deepEqual(ran, []);
  q.open();
  assert.deepEqual(ran, ['first']);
});

test('clearing drops the waiting messages, says whether there were any, and keeps the running turn', () => {
  const { q, ran, busy } = queue();
  q.push('a'); q.push('b');
  assert.equal(q.clear(), true);
  assert.equal(q.clear(), false);
  q.ended();
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(busy, [false]);
});

test('ending when no turn runs does nothing', () => {
  const { q, busy } = queue();
  q.ended();
  assert.deepEqual(busy, []);
});

test('a message keeps its place behind ones waiting for open(), even once a turn could start', () => {
  const { q, ran } = queue(false);
  q.push('a'); q.push('b');
  q.open();
  q.push('c');
  q.ended(); q.ended();
  assert.deepEqual(ran, ['a', 'b', 'c']);
});

test('stderr lines split across chunks stay whole, and only the last ones are kept', () => {
  const t = new StderrTail(3);
  t.push('first line\nsec'); t.push('ond line\n');
  assert.deepEqual(t.last(5), ['first line', 'second line']);
  t.push('x\ny\nz\nError: boom');
  assert.deepEqual(t.last(2), ['z', 'Error: boom'], 'the unfinished last line counts');
  assert.deepEqual(t.last(5, (l) => /error/i.test(l)), ['Error: boom']);
  t.clear();
  assert.deepEqual(t.last(5), []);
});

test('tool output is cut at the limit', () => {
  assert.equal(clipResult('short'), 'short');
  assert.equal(clipResult('x'.repeat(MAX_RESULT_TEXT + 10)).length, MAX_RESULT_TEXT + '\n…(truncated)'.length);
});
