import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueuedShortcut } from '../../web/src/queuedShortcut.ts';

test('the second shortcut promotes only the receipt from its own last keyboard send, once', () => {
  const shortcut = new QueuedShortcut();
  const request = shortcut.begin('task-a');
  assert.equal(shortcut.finish(request, 'our-message'), null);
  assert.deepEqual(shortcut.repeat(), { taskId: 'task-a', queuedId: 'our-message' });
  assert.equal(shortcut.repeat(), null);
  assert.equal(shortcut.active, false);
});

test('fast extra shortcuts wait for the queue receipt and never duplicate promotion', () => {
  const shortcut = new QueuedShortcut();
  const request = shortcut.begin('task-a');
  assert.equal(shortcut.repeat(), null);
  assert.equal(shortcut.repeat(), null);
  assert.deepEqual(shortcut.finish(request, 'our-message'), { taskId: 'task-a', queuedId: 'our-message' });
  assert.equal(shortcut.repeat(), null);
  assert.equal(shortcut.finish(request, 'our-message'), null);
});

test('editing, leaving the input, or switching tasks invalidates an in-flight shortcut', () => {
  const shortcut = new QueuedShortcut();
  const request = shortcut.begin('task-a');
  shortcut.repeat();
  shortcut.reset();
  assert.equal(shortcut.finish(request, 'old-message'), null);
  assert.equal(shortcut.repeat(), null);
  const next = shortcut.begin('task-b');
  assert.equal(shortcut.finish(request, 'old-message'), null);
  assert.equal(shortcut.finish(next, 'new-message'), null);
  assert.deepEqual(shortcut.repeat(), { taskId: 'task-b', queuedId: 'new-message' });
});

test('failed or direct sends do not arm any queued message, including older pending messages', () => {
  const shortcut = new QueuedShortcut();
  const request = shortcut.begin('task-a');
  shortcut.repeat();
  assert.equal(shortcut.finish(request), null);
  assert.equal(shortcut.active, false);
  assert.equal(shortcut.repeat(), null);
});
