import { workspaceKey } from './workspace.ts';
import { useEffect, useState } from 'react';
import type { HubEvent } from './types.ts';

export const REFERENCES_KEY = workspaceKey('agent-desk.threadReferences');
export type ReferenceEntry = { kind: 'file'; href: string } | { kind: 'event'; id: number };
export interface ReferenceSelection { ids: number[]; open: boolean; files?: string[]; order?: ReferenceEntry[] }
export type ThreadReferences = Record<string, ReferenceSelection>;
const EMPTY: ReferenceSelection = { ids: [], open: false };
const entryKey = (entry: ReferenceEntry) => entry.kind === 'file' ? `file:${entry.href}` : `event:${entry.id}`;

/** Old preferences retain their displayed order; explicit choices then promote one mixed entry. */
export function referenceOrder(selection: Pick<ReferenceSelection, 'ids' | 'files' | 'order'>): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [...(selection.files ?? []).map(href => ({ kind: 'file' as const, href })),
    ...selection.ids.map(id => ({ kind: 'event' as const, id }))];
  const remaining = new Map(entries.map(entry => [entryKey(entry), entry]));
  const ordered: ReferenceEntry[] = [];
  for (const entry of selection.order ?? []) {
    if (!entry || typeof entry !== 'object' || !['file', 'event'].includes(entry.kind)) continue;
    const key = entryKey(entry), found = remaining.get(key);
    if (found) { ordered.push(found); remaining.delete(key); }
  }
  return [...ordered, ...remaining.values()];
}

export function openReferenceFile(state: ThreadReferences, task: string, href: string): ThreadReferences {
  const current = Object.hasOwn(state, task) ? state[task] : EMPTY;
  const files = [href, ...(current.files ?? []).filter(file => file !== href)].slice(0, 20);
  const entry: ReferenceEntry = { kind: 'file', href };
  const order = [entry, ...referenceOrder(current).filter(item => entryKey(item) !== entryKey(entry))];
  const next = { ...current, open: true, files, order };
  return { ...state, [task]: { ...next, order: referenceOrder(next) } };
}

/** Keep only source IDs, in the order chosen; never duplicate conversation text in storage. */
export function readReferences(raw: string | null): ThreadReferences {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed).flatMap(([task, value]) => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.ids)) return [];
      const ids = [...new Set<number>(value.ids.filter((id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0))];
      const files=Array.isArray(value.files)?[...new Set<string>(value.files.filter((f:unknown):f is string=>typeof f==='string'&&f.length<=4096))].slice(0,20):[];
      const selection: ReferenceSelection = { ids, open: false, ...(files.length?{files}:{}) };
      if (Array.isArray(value.order)) selection.order = referenceOrder({ ...selection, order: value.order });
      return [[task, selection] as const];
    });
    return Object.fromEntries(entries);
  } catch { return {}; }
}

export function toggleReference(state: ThreadReferences, task: string, id: number): ThreadReferences {
  if (!Number.isSafeInteger(id) || id < 1) return state;
  const current = Object.hasOwn(state, task) ? state[task] : EMPTY;
  const held = current.ids.includes(id);
  const ids = held ? current.ids.filter(n => n !== id) : [id, ...current.ids];
  const order = referenceOrder(current).filter(entry => entry.kind !== 'event' || entry.id !== id);
  if (!held) order.unshift({ kind: 'event', id });
  return { ...state, [task]: { ...current, ids, order, open: held ? current.open : true } };
}

/** Whole, task-scoped originals only; a live clipped event must be fetched before displaying it. */
export function referenceEvents(task: string, ids: number[], events: HubEvent[]): Map<number, HubEvent> {
  const wanted = new Set(ids);
  return new Map(events.filter(e => e.task_id === task && wanted.has(e.id) && !e.payload.clipped).map(e => [e.id, e]));
}

export function useThreadReferences(taskId: string | null, gone: Set<string>) {
  const [fileFocus, setFileFocus] = useState<{taskId:string;href:string;revision:number}>();
  const [state, setState] = useState<ThreadReferences>(() => {
    try { return readReferences(localStorage.getItem(REFERENCES_KEY)); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(REFERENCES_KEY, JSON.stringify(state)); } catch { /* private mode or full storage */ } }, [state]);
  useEffect(() => {
    if (!gone.size) return;
    setState(previous => {
      const entries = Object.entries(previous).filter(([id]) => !gone.has(id));
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
  }, [gone]);
  const selected = taskId && Object.hasOwn(state, taskId) ? state[taskId] : EMPTY;
  return {
    ...selected,
    fileFocus: fileFocus?.taskId === taskId ? fileFocus : undefined,
    // Called before opening a different thread. A subsequent addFile in the same event wins.
    enter: (task: string) => setState(s => Object.hasOwn(s, task) && s[task].open
      ? { ...s, [task]: { ...s[task], open: false } } : s),
    addFile: (task:string,href:string) => {
      setFileFocus(previous=>({taskId:task,href,revision:(previous?.revision??0)+1}));
      setState(s => openReferenceFile(s, task, href));
    },
    removeFile: (href:string) => {if(taskId)setState(s=>({...s,[taskId]:{...s[taskId],files:s[taskId]?.files?.filter(f=>f!==href)}}));},
    toggle: (id: number) => { if (taskId) setState(s => toggleReference(s, taskId, id)); },
    show: (open: boolean) => { if (taskId) setState(s => ({ ...s, [taskId]: { ...(Object.hasOwn(s, taskId) ? s[taskId] : EMPTY), open } })); },
    clear: () => { if (taskId) setState(s => ({ ...s, [taskId]: { ids: [], open: true } })); },
  };
}
