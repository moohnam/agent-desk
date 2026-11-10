import { workspaceKey } from './workspace.ts';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Unsent text, kept per box on this device (localStorage) so it survives switching threads,
 * closing the drawer and reloading. Keys: `drawer`, `reply:<taskId>`, `question:<questionId>`
 * (a terminal task's question), `ask:<approvalId>` (an engine's multiple-choice question).
 * A draft names its task; only reply drafts mark the task "작성 중". An unsent answer belongs to
 * a task that is already waiting (응답 대기), and marking it would move it on the status board.
 * Several windows on one device share the drafts: each writes only the keys it changed, and takes
 * the others' changes as they come (a draft sent in one window is gone from the rest too).
 */
export interface Draft<T = unknown> { taskId?: string; value: T; at: number }

const KEY = workspaceKey('agent-desk.drafts.v1');
const MAX_AGE = 30 * 24 * 60 * 60_000;
const SAVE_MS = 300;

const drafts = new Map<string, Draft>(load());
const listeners = new Set<() => void>();
/** Per key, the boxes showing it, told when another window changes or drops it. */
const keyListeners = new Map<string, Set<(value: unknown) => void>>();
/** Keys this window changed since it last saved; only these are written. */
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function parse(raw: string | null): [string, Draft][] {
  try {
    const old = Date.now() - MAX_AGE;
    return Object.entries(JSON.parse(raw ?? '{}') as Record<string, Draft>).filter(([, d]) => d && d.at > old);
  } catch { return []; }
}
function load(): [string, Draft][] {
  try { return parse(localStorage.getItem(KEY)); } catch { return []; }
}

/** Writes this window's changes over what is stored now, so other windows' drafts stay as they are. */
function save() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty.size) return;
  const stored = new Map(load());
  for (const k of dirty) {
    const d = drafts.get(k);
    if (d) stored.set(k, d); else stored.delete(k);
  }
  dirty.clear();
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(stored))); } catch { /* storage unavailable */ }
}
addEventListener('pagehide', save);

// Another window saved: take its drafts, except keys changed here and not saved yet.
addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return;
  const next = new Map(parse(e.newValue));
  const keys = new Set([...drafts.keys(), ...next.keys()]);
  for (const k of keys) {
    if (dirty.has(k)) continue;
    const was = drafts.get(k), now = next.get(k);
    if (JSON.stringify(was?.value) === JSON.stringify(now?.value)) continue;
    if (now) drafts.set(k, now); else drafts.delete(k);
    keyListeners.get(k)?.forEach((l) => l(now?.value));
  }
  notify();
});

let snapshot = taskSet();
function taskSet(): Set<string> {
  return new Set([...drafts].filter(([k, d]) => k.startsWith('reply:') && d.taskId).map(([, d]) => d.taskId!));
}
/** Recomputes the task set, and tells listeners only when it changed (not on every keystroke). */
function notify() {
  const next = taskSet();
  if (next.size !== snapshot.size || [...next].some((t) => !snapshot.has(t))) {
    snapshot = next;
    listeners.forEach((l) => l());
  }
}
function changed(...keys: string[]) {
  keys.forEach((k) => dirty.add(k));
  notify();
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
    const was = drafts.get(key);
    // Unchanged (e.g. a box taking another window's value): nothing to write back.
    if (was && was.taskId === opts.taskId && JSON.stringify(was.value) === JSON.stringify(value)) return;
    drafts.set(key, { taskId: opts.taskId, value, at: Date.now() });
  }
  changed(key);
}

/** Drops drafts `keep` rejects: their task was deleted, or their question was answered elsewhere. */
export function pruneDrafts(keep: (key: string, d: Draft) => boolean) {
  const gone = [...drafts].filter(([k, d]) => !keep(k, d)).map(([k]) => k);
  gone.forEach((k) => drafts.delete(k));
  if (gone.length) changed(...gone);
}

/**
 * Keeps an open box in step with its draft when another window changes or sends it: `apply` gets
 * the new value, or undefined when the draft is gone.
 */
export function useDraftSync<T>(key: string, apply: (value: T | undefined) => void) {
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    const l = (v: unknown) => fn.current(v as T | undefined);
    let set = keyListeners.get(key);
    if (!set) keyListeners.set(key, set = new Set());
    set.add(l);
    return () => { set.delete(l); if (!set.size) keyListeners.delete(key); };
  }, [key]);
}

/** Tasks with an unsent reply. */
export function useDraftTasks(): Set<string> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
}
