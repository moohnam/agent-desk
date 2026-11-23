import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdsImeEscape, nextMineIndex, nextTaskIndex, nextUserIndex, releaseImeEscape, replyTaskId } from '../../web/src/keys.ts';
import type { Post } from '../../web/src/types.ts';

/** Posts from a spec like 'a:u a:x b:x b:u': task letter and kind (u: the user's, else the agent's). */
const posts = (spec: string) => spec.split(' ').map((s, id) => {
  const [taskId, k] = s.split(':');
  return { id, taskId, kind: k === 'u' ? 'user' : 'assistant' } as Post;
});

test('an IME Escape keyup holds only the immediate duplicate and allows later Escape presses', () => {
  const key = (name: string, timeStamp: number) => ({ key: name, code: 'Escape', timeStamp } as KeyboardEvent);
  const held = releaseImeEscape(true, key('Process', 10));
  assert.equal(holdsImeEscape(held, key('Escape', 11)), true);
  assert.equal(holdsImeEscape(held, key('Escape', 100)), false);
  assert.equal(holdsImeEscape(releaseImeEscape(held, key('Escape', 12)), key('Escape', 13)), false);
});

test('r can target a thread or single-task column without selecting a post', () => {
  assert.equal(replyTaskId(undefined, null, ['task-1']), 'task-1');
  assert.equal(replyTaskId(undefined, 'thread-task'), 'thread-task');
  assert.equal(replyTaskId(posts('picked:u')[0], null, ['task-1']), 'picked');
  assert.equal(replyTaskId(undefined, null, ['task-1', 'task-2']), null);
  assert.equal(replyTaskId(undefined, null), null);
});

test('r on a mixed column uses its newest post unless a post is selected', () => {
  const [newest, selected] = posts('newest:x selected:u');
  assert.equal(replyTaskId(undefined, null, undefined, newest), 'newest');
  assert.equal(replyTaskId(undefined, null, ['a', 'b'], newest), 'newest');
  assert.equal(replyTaskId(selected, null, undefined, newest), 'selected');
  assert.equal(replyTaskId(undefined, 'thread-task', undefined, newest), 'thread-task');
  assert.equal(replyTaskId(undefined, null, ['column-task'], newest), 'column-task');
});

test('J / K go to the first post of the next / previous run of another task', () => {
  const p = posts('a:u a:x b:x b:x a:x c:u');
  assert.equal(nextTaskIndex(p, 0, 1), 2);
  assert.equal(nextTaskIndex(p, 2, 1), 4);
  assert.equal(nextTaskIndex(p, 3, -1), 0, 'up lands on the top of the run above');
  assert.equal(nextTaskIndex(p, 5, 1), 5, 'past the end stays at the last post');
  assert.equal(nextTaskIndex(p, -1, 1), 0, 'with nothing selected, the first post');
});

test('in a thread J / K step between the user\'s own posts', () => {
  const p = posts('a:u a:x a:x a:u a:x');
  assert.equal(nextUserIndex(p, 0, 1), 3);
  assert.equal(nextUserIndex(p, 3, 1), null);
  assert.equal(nextUserIndex(p, -1, -1), 3);
});

test('Ctrl+Shift J / K land on the topmost instruction of each task run', () => {
  const p = posts('a:u a:u a:x b:x c:x c:u');
  assert.equal(nextMineIndex(p, -1, 1), 0);
  assert.equal(nextMineIndex(p, 0, 1), 5, "a run's later instruction and a run without one are passed over");
  assert.equal(nextMineIndex(p, 5, 1), null);
  assert.equal(nextMineIndex(p, 5, -1), 0);
});
