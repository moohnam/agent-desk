// What every part of the hub works on: the store, the runner connection and the live session state,
// and the few ways to change them that keep the web UI informed (an event recorded, a status set, a
// task republished). Hub extends it; the parts it delegates to (requests.ts, external.ts) get it.

import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import type { HubMessage, Task, TaskStatus, TaskView } from '../../shared/api.ts';
import type { EventKind, EventPayloads } from '../../shared/events.ts';
import type { BackgroundTask } from '../../shared/protocol.ts';
import { feedEvent, type Event, type Store } from './db.ts';
import { HttpError } from './errors.ts';
import type { RunnerPort } from './runner/client.ts';
import type { SkillStore } from './skills.ts';
import { nextStatus, type TaskEvent } from './task-status.ts';

/** Who created a task; the desk has one user. */
export const OWNER = 'local';

export class DeskCore {
  readonly bus = new EventEmitter();
  readonly store: Store;
  readonly skills: SkillStore;
  /** Set by the hub's constructor, which connects it to the hub's message handling. */
  runner!: RunnerPort;
  /** Sessions with a turn in progress (runner `busy`), set as soon as the hub sends them work. */
  busy = new Set<string>();
  /** Per live session, its background work (runner's last list). */
  background = new Map<string, BackgroundTask[]>();
  /** Waiters of desk_ask / desk_request / desk_wait_answer, by question or request id. */
  private waiters = new Map<string, Set<() => void>>();
  private publications: HubMessage[] | null = null;
  private eventTime?: string;
  atTime<T>(at: string | undefined, work: () => T): T {
    const previous = this.eventTime;
    this.eventTime = at;
    try { return work(); } finally { this.eventTime = previous; }
  }

  constructor(store: Store, skills: SkillStore) {
    this.store = store;
    this.skills = skills;
  }

  /** The runner a new session is recorded with: the connected one, else this machine's. */
  get runnerId() { return this.runner.id ?? `local-${hostname()}`; }

  publish(m: HubMessage) {
    if (this.publications) this.publications.push(m);
    else this.bus.emit('message', m);
  }

  /** Persist a user operation and its remote outbox together; publish only after commit. */
  atomic<T>(work: () => T): T {
    const outer = this.publications;
    const messages: HubMessage[] = [];
    const busy = new Set(this.busy), background = new Map(this.background);
    this.publications = messages;
    this.store.database.exec('SAVEPOINT hub_operation');
    try {
      const result = work();
      this.store.database.exec('RELEASE hub_operation');
      this.publications = outer;
      for (const m of messages) this.publish(m);
      return result;
    } catch (error) {
      this.store.database.exec('ROLLBACK TO hub_operation; RELEASE hub_operation');
      this.busy = busy; this.background = background; this.publications = outer;
      throw error;
    }
  }

  taskView(task: Task): TaskView {
    const session = this.store.latestSessionWithRunnerLabel(task.id);
    return {
      ...task,
      title_revision: (task as Task & { title_revision?: number }).title_revision ?? 0,
      project_name: this.store.getProject(task.project_id)?.name ?? '?',
      engine: session?.engine ?? null,
      permission_mode: session?.permission_mode ?? null,
      model: session?.model ?? null,
      effort: session?.effort ?? null,
      runner_id: session?.runner_id,
      runner_label: session?.source === 'app' ? session.runner_label ?? undefined : undefined,
      runner_connected: session ? (this.runner.ready?.(session.id) ?? this.runner.connected) : false,
      delivery_pending: session ? (this.runner as RunnerPort & { pendingFor?: (id: string) => number }).pendingFor?.(session.id) ?? 0 : 0,
      live: session ? (session.source === 'external' ? task.status !== 'done' : this.runner.has(session.id)) : false,
      source: session?.source ?? null,
      last_event: this.store.lastEvent(task.id) ?? null,
      pending_approvals: this.store.pendingApprovals().filter((a) => a.task_id === task.id).length,
      pending_questions: this.store.pendingQuestions().filter((q) => q.task_id === task.id).length,
      pending_ask: this.store.openAsyncQuestion(task.id),
      queued: this.store.queued({ taskId: task.id }).map((q) => ({ id: q.id, text: q.text, created_at: q.created_at, ...(q.kind && { kind: q.kind }), ...(q.channel_context && { channel_entry_count: q.channel_context.entries.length }) })),
      background: (session && this.background.get(session.id)) ?? [],
    };
  }

  state() {
    return {
      projects: this.store.listProjects(),
      tasks: this.store.listTasks().map((t) => this.taskView(t)),
      approvals: this.store.pendingApprovals(),
      questions: this.store.pendingQuestions(),
      channels: this.store.listChannels(),
      runner: { connected: this.runner.connected },
    };
  }

  publishTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (task) this.publish({ type: 'task', task: this.taskView(task) });
  }

  setStatus(taskId: string, sessionId: string, status: TaskStatus) {
    this.store.setTaskStatus(taskId, status);
    this.store.updateSession(sessionId, { status });
    this.publishTask(taskId);
  }

  /** Moves the task on by `e` (task-status.ts); false when its status stays. */
  transition(taskId: string, sessionId: string, e: TaskEvent): boolean {
    const next = nextStatus(this.store.getTask(taskId)?.status, e);
    if (next) this.setStatus(taskId, sessionId, next);
    return !!next;
  }

  /** Records an event of `kind` with that kind's payload (shared/events.ts) and publishes it. */
  addEvent<K extends EventKind>(sessionId: string, taskId: string, kind: K, payload: EventPayloads[K]): Event {
    const event = this.store.addEvent(sessionId, taskId, kind, payload, this.eventTime);
    this.store.touchTask(taskId);
    // Live events come cut like the feed's (feedEvent); an open thread fetches clipped ones whole.
    this.publish({ type: 'event', event: feedEvent(event) });
    this.publishTask(taskId);
    return event;
  }

  requireRunner(sessionId?: string) {
    if (sessionId && this.runner.canQueue?.(sessionId)) return;
    if (!this.runner.connected) throw new HttpError(503, 'Runner에 연결되어 있지 않습니다. 잠시 후 다시 시도하세요');
  }

  /** `@project#N` of a task. */
  taskLabel(task: Task) { return `${this.store.getProject(task.project_id)?.name ?? '?'}#${task.seq}`; }

  /** Resolves with `get()` once `done` holds for it (checked when its id's waiters are called), or after `timeoutMs`. */
  waitFor<T>(id: string, get: () => T | undefined, done: (t: T) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const first = get();
    if (!first) return Promise.reject(new HttpError(404, `질문을 찾을 수 없습니다: ${id}`));
    if (done(first)) return Promise.resolve(first);
    // What it last was, if it is deleted meanwhile (its task removed).
    let last = first;
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        waiters.delete(finish);
        // Another wait may have started a new set for this id meanwhile; leave that one be.
        if (!waiters.size && this.waiters.get(id) === waiters) this.waiters.delete(id);
        resolve((last = get() ?? last));
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
      waiters.add(finish);
    });
  }

  /** Wakes the waits on question or request `id` (waitFor) to look again. */
  wake(id: string) {
    for (const w of [...(this.waiters.get(id) ?? [])]) w();
  }
}
