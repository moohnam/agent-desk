// OS notifications for what needs the user while the desk is not in front: approval requests, agent
// questions, and tasks that finished or failed. The desktop app shows them through its own commands
// (macOS UserNotifications, granted to the hub page only; a click opens the thread); a browser through
// the Web Notifications API. Off until the user turns them on (the OS or browser asks permission then).
//
// A notification's title is the kind of thing and the task's name; its body the agent's latest
// message (or the question asked), cut short. They can show on the lock screen: macOS hides the body
// there when System Settings > Notifications > Show previews is "When Unlocked".

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ASK_USER } from '../../shared/protocol.ts';
import type { AccessView } from '../../shared/api.ts';
import type { Approval, HubEvent, Question, TaskView } from './types.ts';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
/** The desktop app's command call, or undefined in a browser. */
const tauri = (): Invoke | undefined => (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;

const PREF = 'agent-desk.notify';
/** Ids notified on this device, so two desk windows don't both show one. */
const SEEN = 'agent-desk.notified';
/** When a desk window on this device was last in front: none notifies while one is. */
const FRONT = 'agent-desk.front';
/** This browser can't show notifications (it refused once), kept so a reload doesn't show the bell on. */
const BROKEN = 'agent-desk.notify-broken';
const FRONT_FRESH_MS = 8000;
/** More changes than this at once (a reconnect, a runner restart) become one summary. */
const BURST = 3;

export type NotifyState = 'on' | 'off' | 'blocked' | 'unsupported';

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
/** The browser refused to construct a notification (Android Chrome wants a service worker): off for good. */
let broken = (() => { try { return localStorage.getItem(BROKEN) === '1'; } catch { return false; } })();

/** The saved setting, read once and kept in step with other windows (it is read on every render). */
let pref = (() => { try { return localStorage.getItem(PREF) === '1'; } catch { return false; } })();
window.addEventListener('storage', (e) => {
  if (e.key === PREF) { pref = e.newValue === '1'; changed(); }
});

function state(): NotifyState {
  if (broken || (!tauri() && typeof Notification === 'undefined')) return 'unsupported';
  if (!tauri() && Notification.permission === 'denied') return 'blocked';
  // Permission taken back in the browser (reset to "ask") turns it off too.
  return pref && (tauri() || Notification.permission === 'granted') ? 'on' : 'off';
}

/** The notification setting, kept current across this page. */
export function useNotifyState(): NotifyState {
  return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, state);
}

/** Turns notifications on (asking for permission first) or off; the resulting state. */
export async function setNotify(on: boolean): Promise<NotifyState> {
  if (on) {
    const t = tauri();
    let granted = false;
    try {
      granted = t ? (await t('desk_notify_permission')) === true
        : typeof Notification !== 'undefined' && (Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted');
    } catch { /* treated as refused */ }
    if (!granted) { changed(); return state(); }
  }
  pref = on;
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* storage unavailable */ }
  changed();
  // One right away, so the user sees that they arrive (and how they look).
  if (on) deliver({ id: `enabled:${Date.now()}`, title: 'Agent Desk', body: '알림을 켰습니다. 데스크를 보고 있지 않을 때 이렇게 알려 드립니다.' }, () => {});
  return state();
}

/**
 * Marks this window as in front while it is, so the other desk windows on this device stay quiet;
 * cleared when it goes to the back, so what comes right after the user leaves still notifies.
 */
function trackFront() {
  let mine = '';
  const mark = () => {
    if (!document.hasFocus() || state() !== 'on') return;
    mine = String(Date.now());
    try { localStorage.setItem(FRONT, mine); } catch { /* ignore */ }
  };
  // Only this window's own mark: another window may have come to the front first.
  const leave = () => { try { if (mine && localStorage.getItem(FRONT) === mine) localStorage.removeItem(FRONT); } catch { /* ignore */ } mine = ''; };
  window.addEventListener('focus', mark);
  window.addEventListener('blur', leave);
  window.addEventListener('pagehide', leave);
  const timer = window.setInterval(mark, FRONT_FRESH_MS / 2);
  mark();
  return () => {
    window.removeEventListener('focus', mark); window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave);
    window.clearInterval(timer);
  };
}
/** A desk window on this device is in front (this one, or another within FRONT_FRESH_MS). */
function deskInFront(): boolean {
  if (document.hasFocus()) return true;
  try { return Date.now() - Number(localStorage.getItem(FRONT) ?? 0) < FRONT_FRESH_MS; } catch { return false; }
}

/** Claims `id` for this window, or false when another window on this device already showed it. */
function claim(id: string): boolean {
  try {
    const now = Date.now();
    const seen = JSON.parse(localStorage.getItem(SEEN) ?? '{}') as Record<string, number>;
    if (seen[id]) return false;
    for (const [k, t] of Object.entries(seen)) if (now - t > 60 * 60_000) delete seen[k];
    seen[id] = now;
    localStorage.setItem(SEEN, JSON.stringify(seen));
  } catch { /* storage unavailable: show it */ }
  return true;
}

interface Note { id: string; title: string; body: string; taskId?: string }

/** Shows `n` unless notifications are off or a desk window is in front. Claim its ids first. */
function show(n: Note, open: (taskId: string) => void) {
  if (state() !== 'on' || deskInFront()) return;
  deliver(n, open);
}

function deliver(n: Note, open: (taskId: string) => void) {
  try {
    const t = tauri();
    if (t) { t('desk_notify', { id: n.id, title: n.title, body: n.body, task: n.taskId ?? null }).catch(() => {}); return; }
    const note = new Notification(n.title, { body: n.body, tag: n.id });
    note.onclick = () => { window.focus(); if (n.taskId) open(n.taskId); note.close(); };
  } catch {
    broken = true;
    try { localStorage.setItem(BROKEN, '1'); } catch { /* ignore */ }
    changed();
  }
}

const name = (t: TaskView | undefined) => (t ? t.title.trim() || `${t.project_name}#${t.seq}` : '작업');
/** One line, short enough for a notification. */
const clip = (text: unknown, max = 180) => {
  const s = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const busy = (s: string) => s === 'running' || s === 'waiting';
/** The task stopped because someone interrupted it or closed its session (maybe on another device): not news. */
const interrupted = (t: TaskView) => {
  const e = t.last_event as { kind?: string; payload?: { state?: string } | null } | null;
  return e?.kind === 'status' && (e.payload?.state === 'interrupted' || e.payload?.state === 'closed');
};

/**
 * Notifies, while no desk window is in front, of what changes in the hub's state: new approval
 * requests and questions, and tasks that finish or fail. The state loaded at start notifies nothing;
 * a burst of changes (after a reconnect or a runner restart) comes as one summary. Every change is
 * claimed, shown or not, so a window behind doesn't show what the user saw in another.
 * `open`: the task's thread, for a click on a browser notification.
 */
export function useDeskNotifications(hub: { synced: number; tasks: Map<string, TaskView>; approvals: Map<string, Approval>; questions: Map<string, Question>;
  onEvent: (fn: (e: HubEvent) => void) => () => void; access: AccessView | null }, open: (taskId: string) => void) {
  const prev = useRef<{ access: Set<string>; approvals: Set<string>; questions: Set<string>; tasks: Map<string, { status: string; ask: number | null }> } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  /** Each task's latest agent message seen live; events reach this before the state they come with renders. */
  const said = useRef(new Map<string, string>());
  useEffect(trackFront, []);
  // The desktop app: a clicked notification opens its task's thread.
  useEffect(() => {
    const onOpen = (e: Event) => { const task = (e as CustomEvent<{ task?: string }>).detail?.task; if (task) openRef.current(task); };
    window.addEventListener('desk-notification-open', onOpen);
    return () => window.removeEventListener('desk-notification-open', onOpen);
  }, []);
  useEffect(() => hub.onEvent((e) => {
    const text = e.kind === 'assistant' || e.kind === 'update' ? clip(e.payload?.text) : '';
    if (text) said.current.set(e.task_id, text);
  }), [hub.onEvent]);
  useEffect(() => {
    if (!hub.synced) return;
    const now = {
      access: new Set(hub.access?.requests.map((r) => r.id)),
      approvals: new Set(hub.approvals.keys()),
      questions: new Set(hub.questions.keys()),
      tasks: new Map([...hub.tasks].map(([id, t]) => [id, { status: t.status, ask: t.pending_ask?.event_id ?? null }])),
    };
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const notes: (Note & { kind: 'ask' | 'done' | 'error' })[] = [];
    const latest = (taskId: string, fallback: string) => said.current.get(taskId) || fallback;
    // Another device asking to connect (this Mac's pages only get these).
    for (const r of hub.access?.requests ?? []) {
      if (!before.access.has(r.id)) notes.push({ kind: 'ask', id: `access:${r.id}`, title: `접속 요청 · ${r.name}`, body: `${r.ip}에서 데스크 접속을 요청했습니다 · 코드 ${r.code}` });
    }
    for (const a of hub.approvals.values()) {
      if (before.approvals.has(a.id)) continue;
      const t = hub.tasks.get(a.task_id);
      const asked = a.tool_name === ASK_USER ? clip(a.input?.questions?.[0]?.question) : '';
      notes.push(a.tool_name === ASK_USER
        ? { kind: 'ask', id: `approval:${a.id}`, title: `질문 · ${name(t)}`, body: asked || latest(a.task_id, '에이전트가 답을 기다립니다'), taskId: a.task_id }
        : { kind: 'ask', id: `approval:${a.id}`, title: `승인 요청 · ${name(t)}`, body: [`${a.tool_name} 실행 승인을 기다립니다`, said.current.get(a.task_id)].filter(Boolean).join(' · '), taskId: a.task_id });
    }
    for (const q of hub.questions.values()) {
      if (before.questions.has(q.id)) continue;
      const t = hub.tasks.get(q.task_id);
      notes.push({ kind: 'ask', id: `question:${q.id}`, title: `질문 · ${name(t)}`, body: clip(q.text) || '에이전트가 답을 기다립니다', taskId: q.task_id });
    }
    for (const [id, t] of hub.tasks) {
      const was = before.tasks.get(id);
      if (!was) continue;
      const asked = !!t.pending_ask && t.pending_ask.event_id !== was.ask;
      if (asked) notes.push({ kind: 'ask', id: `ask:${t.pending_ask!.event_id}`, title: `질문 · ${name(t)}`, body: clip(t.pending_ask!.text) || '에이전트가 답을 기다립니다', taskId: id });
      // A turn that ended on a question (asked now or earlier in it) is told as the question only.
      if (!t.pending_ask && busy(was.status) && (t.status === 'idle' || t.status === 'done') && !interrupted(t)) {
        notes.push({ kind: 'done', id: `done:${id}:${t.updated_at}`, title: `작업 끝남 · ${name(t)}`, body: latest(id, '답을 마쳤습니다'), taskId: id });
      }
      if (was.status !== 'error' && t.status === 'error') notes.push({ kind: 'error', id: `error:${id}:${t.updated_at}`, title: `오류 · ${name(t)}`, body: '오류로 멈췄습니다', taskId: id });
    }
    const fresh = notes.filter((n) => claim(n.id));
    if (!fresh.length) return;
    const go = (taskId: string) => openRef.current(taskId);
    // Many changes at once (a reconnect, a runner restart): one summary, no flood.
    if (fresh.length > BURST) {
      const count = (k: string) => fresh.filter((n) => n.kind === k).length;
      const parts = [['ask', '응답 대기'], ['done', '작업 끝남'], ['error', '오류']]
        .map(([k, label]) => (count(k) ? `${label} ${count(k)}건` : '')).filter(Boolean);
      show({ id: 'summary', title: 'Agent Desk', body: parts.join(' · ') }, go);
      return;
    }
    for (const n of fresh) show(n, go);
  }, [hub.synced, hub.tasks, hub.approvals, hub.questions, hub.access]);
}
