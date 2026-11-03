/** A receipt identifies our exact send, even when another client queues identical text. */
export interface QueuedTarget { taskId: string; queuedId: string }

/** One deliberate second shortcut can promote the last untouched keyboard send, once. */
export class QueuedShortcut {
  private serial = 0;
  private pending: { request: number; taskId: string; queuedId?: string; promote: boolean } | null = null;

  get active() { return this.pending !== null; }

  begin(taskId: string) {
    const request = ++this.serial;
    this.pending = { request, taskId, promote: false };
    return request;
  }

  reset() { this.pending = null; }

  /** A fast second press waits for the first HTTP response, without sending the text twice. */
  repeat(): QueuedTarget | null {
    if (!this.pending) return null;
    this.pending.promote = true;
    return this.take();
  }

  finish(request: number, queuedId?: string): QueuedTarget | null {
    if (this.pending?.request !== request) return null;
    if (!queuedId) { this.reset(); return null; }
    this.pending.queuedId = queuedId;
    return this.take();
  }

  private take(): QueuedTarget | null {
    const p = this.pending;
    if (!p?.promote || !p.queuedId) return null;
    this.reset();
    return { taskId: p.taskId, queuedId: p.queuedId };
  }
}
