// How a task's status follows what happens to its session, in one place: the rules were conditions
// at each call site. Statuses set by a direct act (attaching, asking, finishing) don't go through it.

import type { TaskStatus } from '../../shared/api.ts';

export type TaskEvent =
  /** The runner reports a turn running: one the hub sent, or one the agent began itself (a background subagent finished). */
  | 'turn_started'
  /** The turn ended without error. */
  | 'turn_ended'
  /** The engine reported an error, or the session ended with one or mid-turn. */
  | 'failed'
  | 'interrupted'
  | 'approval_pending'
  /** The task's last pending approval was answered. */
  | 'approvals_cleared'
  /** The user closed the session. */
  | 'closed_by_user';

const working = (s: TaskStatus | undefined) => s === 'running' || s === 'waiting';

/** The status `e` takes a task in `current` to, or null when it stays. */
export function nextStatus(current: TaskStatus | undefined, e: TaskEvent): TaskStatus | null {
  switch (e) {
    case 'turn_started': return working(current) ? null : 'running';
    // Only a running task is done: one waiting on an approval or failed meanwhile keeps that.
    case 'turn_ended': return current === 'running' ? 'done' : null;
    case 'failed': return 'error';
    case 'interrupted': return 'idle';
    case 'approval_pending': return 'waiting';
    case 'approvals_cleared': return 'running';
    case 'closed_by_user': return working(current) ? 'idle' : null;
  }
}
