import { useSyncExternalStore } from 'react';

/**
 * Unsent text, kept per box on this device (localStorage) so it survives switching threads,
 * closing the drawer and reloading. Keys: `drawer`, `reply:<taskId>`, `question:<questionId>`
 * (a terminal task's question), `ask:<approvalId>` (an engine's multiple-choice question).
 * A draft names its task; only reply drafts mark the task "작성 중". An unsent answer belongs to
 * a task that is already waiting (응답 대기), and marking it would move it on the status board.
 */
export interface Draft<T = unknown> { taskId?: string; value: T; at: number }

const KEY = 'agent-desk.drafts.v1';
const MAX_AGE = 30 * 24 * 60 * 60_000;
const SAVE_MS = 300;

const drafts = new Map<string, Draft>(load());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): [string, Draft][] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Draft>;
    const old = Date.now() - MAX_AGE;
    return Object.entries(raw).filter(([, d]) => d && d.at > old);
  } catch { return []; }
}

function save() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(drafts))); } catch { /* storage unavailable */ }
}
addEventListener('pagehide', save);

let snapshot = taskSet();
function taskSet(): Set<string> {
  return new Set([...drafts].filter(([k, d]) => k.startsWith('reply:') && d.taskId).map(([, d]) => d.taskId!));
}
/** Recomputes the task set, and tells listeners only when it changed (not on every keystroke). */
function changed() {
  const next = taskSet();
  if (next.size !== snapshot.size || [...next].some((t) => !snapshot.has(t))) {
    snapshot = next;
    listeners.forEach((l) => l());
  }
  if (!timer) timer = setTimeout(save, SAVE_MS);
}

export function getDraft<T>(key: string): T | undefined {
  return drafts.get(key)?.value as T | undefined;
}

/** Stores the box's value, or drops the draft when `empty` (nothing worth keeping). */
export function setDraft<T>(key: string, value: T, opts: { taskId?: string; empty: boolean }) {
  if (opts.empty) {
    if (!drafts.delete(key)) return;
  } else {
    drafts.set(key, { taskId: opts.taskId, value, at: Date.now() });
  }
  changed();
}

/** Drops drafts `keep` rejects: their task was deleted, or their question was answered elsewhere. */
export function pruneDrafts(keep: (key: string, d: Draft) => boolean) {
  let any = false;
  for (const [k, d] of drafts) if (!keep(k, d)) { drafts.delete(k); any = true; }
  if (any) changed();
}

/** Tasks with an unsent reply. */
export function useDraftTasks(): Set<string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
}
