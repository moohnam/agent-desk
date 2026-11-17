import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutBatch } from '../../web/src/layoutBatch.ts';

function fixture() {
  const frames = new Map<number, () => void>(); let id = 0;
  const enqueue = createLayoutBatch(fn => { frames.set(++id, fn); return id; }, id => { frames.delete(id); });
  const flush = () => { const current = [...frames.values()]; frames.clear(); current.forEach(fn => fn()); };
  return { enqueue, frames, flush };
}
test('all body measurements precede writes in one frame', () => {
  const f = fixture(), trace: string[] = [];
  for (let i = 0; i < 200; i++) f.enqueue(() => { trace.push(`r${i}`); return () => { trace.push(`w${i}`); }; });
  assert.equal(f.frames.size, 1); f.flush();
  assert.deepEqual(trace, [...Array.from({length:200},(_,i)=>`r${i}`), ...Array.from({length:200},(_,i)=>`w${i}`)]);
});
test('unmounted bodies and cancelled writes are not measured or updated', () => {
  const f = fixture(), trace: string[] = [];
  const cancel = f.enqueue(() => { throw Error('cancelled read'); }); cancel();
  assert.equal(f.frames.size, 0);
  let cancelSecond = () => {};
  f.enqueue(() => () => { trace.push('first'); cancelSecond(); });
  cancelSecond = f.enqueue(() => () => { trace.push('second'); });
  f.flush(); assert.deepEqual(trace, ['first']);
});
test('work scheduled during writes is measured in the next frame', () => {
  const f = fixture(), trace: number[] = [];
  f.enqueue(() => () => { trace.push(1); f.enqueue(() => () => { trace.push(2); }); });
  f.flush(); assert.deepEqual(trace, [1]); assert.equal(f.frames.size, 1);
  f.flush(); assert.deepEqual(trace, [1,2]);
});
