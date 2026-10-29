import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatus } from '../../shared/api.ts';
import { nextStatus, type TaskEvent } from '../../hub/src/task-status.ts';

const STATUSES: TaskStatus[] = ['idle', 'running', 'waiting', 'done', 'error'];

/** Per event, the status each current status goes to (null: stays), in STATUSES order. */
const TABLE: Record<TaskEvent, (TaskStatus | null)[]> = {
  turn_started: ['running', null, null, 'running', 'running'],
  turn_ended: [null, 'done', null, null, null],
  failed: ['error', 'error', 'error', 'error', 'error'],
  interrupted: ['idle', 'idle', 'idle', 'idle', 'idle'],
  approval_pending: ['waiting', 'waiting', 'waiting', 'waiting', 'waiting'],
  approvals_cleared: ['running', 'running', 'running', 'running', 'running'],
  closed_by_user: [null, 'idle', 'idle', null, null],
};

for (const [event, row] of Object.entries(TABLE) as [TaskEvent, (TaskStatus | null)[]][]) {
  test(`${event} moves a task as the table says`, () => {
    assert.deepEqual(STATUSES.map((s) => nextStatus(s, event)), row);
  });
}
