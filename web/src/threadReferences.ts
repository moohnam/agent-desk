import { workspaceKey } from './workspace.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubEvent } from './types.ts';
import { documentLinkKey } from './documentLinks.ts';

export const REFERENCES_KEY = workspaceKey('agent-desk.threadReferences');
export type ReferenceEntry = { kind: 'file'; href: string } | { kind: 'event'; id: number };
export interface ReferenceSelection { ids: number[]; open: boolean; files?: string[]; order?: ReferenceEntry[]; identities?: Record<string, string> }
export type ThreadReferences = Record<string, ReferenceSelection>;
const EMPTY: ReferenceSelection = { ids: [], open: false };
const entryKey = (entry: ReferenceEntry) => entry.kind === 'file' ? `file:${documentLinkKey(entry.href)}` : `event:${entry.id}`;

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
  const key = documentLinkKey(href);
  href = current.files?.find(file => documentLinkKey(file) === key) ?? href;
  const files = [href, ...(current.files ?? []).filter(file => documentLinkKey(file) !== key)].slice(0, 20);
  const entry: ReferenceEntry = { kind: 'file', href };
  const order = [entry, ...referenceOrder(current).filter(item => entryKey(item) !== entryKey(entry))];
  const identities = keepIdentities(current.identities, files);
  if (identities) delete identities[href];
  const next = { ...current, open: true, files, order, identities };
  return { ...state, [task]: { ...next, order: referenceOrder(next) } };
}

function keepIdentities(paths: ReferenceSelection['identities'], files: string[]) {
  return paths && Object.fromEntries(files.filter(href => Object.hasOwn(paths, href)).map(href => [href, paths[href]]));
}

/** Collapse aliases after the authority confirms that they preview the same source file. */
export function resolveReferenceFile(state: ThreadReferences, task: string, href: string, identity: string | undefined): ThreadReferences {
  const current = Object.hasOwn(state, task) ? state[task] : undefined;
  if (!current?.files?.includes(href) || current.identities?.[href] === identity) return state;
  if (identity === undefined) {
    const identities = { ...current.identities };
    delete identities[href];
    return { ...state, [task]: { ...current, identities } };
  }
  const identities = { ...current.identities, [href]: identity };
  const aliases = current.files.filter(file => identities[file] === identity);
  if (aliases.length === 1) return { ...state, [task]: { ...current, identities } };
  const order = referenceOrder(current);
  const kept = order.find(entry => entry.kind === 'file' && identities[entry.href] === identity);
  const deduped = order.filter(entry => entry === kept || entry.kind === 'event' || identities[entry.href] !== identity);
  const files = current.files.filter(file => identities[file] !== identity || (kept?.kind === 'file' && kept.href === file));
  return { ...state, [task]: { ...current, order: deduped, files, identities: keepIdentities(identities, files) } };
}

export function moveReference(state: ThreadReferences, task: string, entry: ReferenceEntry, direction: -1 | 1): ThreadReferences {
  const current = Object.hasOwn(state, task) ? state[task] : undefined;
  if (!current) return state;
  const order = referenceOrder(current);
  const from = order.findIndex(item => entryKey(item) === entryKey(entry)), to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return state;
  [order[from], order[to]] = [order[to], order[from]];
  return { ...state, [task]: { ...current, order } };
}

/** Keep only source IDs, in the order chosen; never duplicate conversation text in storage. */
export function readReferences(raw: string | null): ThreadReferences {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed).flatMap(([task, value]) => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.ids)) return [];
      const ids = [...new Set<number>(value.ids.filter((id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0))];
      const files: string[] = [], seen = new Set<string>();
      for (const href of Array.isArray(value.files) ? value.files : []) {
        if (typeof href !== 'string' || href.length > 4096) continue;
        const key = documentLinkKey(href);
        if (!seen.has(key)) { seen.add(key); files.push(href); }
        if (files.length === 20) break;
      }
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
  const fileRevision = useRef(0);
  const [state, setState] = useState<ThreadReferences>(() => {
    try { return readReferences(localStorage.getItem(REFERENCES_KEY)); } catch { return {}; }
  });
  useEffect(() => {
    const stored = Object.fromEntries(Object.entries(state).map(([task, { identities: _, ...selection }]) => [task, selection]));
    try { localStorage.setItem(REFERENCES_KEY, JSON.stringify(stored)); } catch { /* private mode or full storage */ }
  }, [state]);
  useEffect(() => {
    if (!gone.size) return;
    setState(previous => {
      const entries = Object.entries(previous).filter(([id]) => !gone.has(id));
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
  }, [gone]);
  const removeFile = useCallback((href: string) => {
    if (!taskId) return;
    setState(s => {
      const current = s[taskId];
      if (!current?.files?.includes(href)) return s;
      const files = current.files.filter(file => file !== href);
      const order = referenceOrder(current).filter(entry => entry.kind !== 'file' || entry.href !== href);
      return { ...s, [taskId]: { ...current, files, order, identities: keepIdentities(current.identities, files) } };
    });
  }, [taskId]);
  const resolveFile = useCallback((href: string, identity: string | undefined) => {
    if (taskId) setState(s => resolveReferenceFile(s, taskId, href, identity));
  }, [taskId]);
  const move = useCallback((entry: ReferenceEntry, direction: -1 | 1) => {
    if (taskId) setState(s => moveReference(s, taskId, entry, direction));
  }, [taskId]);
  const selected = taskId && Object.hasOwn(state, taskId) ? state[taskId] : EMPTY;
  return {
    ...selected,
    fileFocus: fileFocus?.taskId === taskId ? fileFocus : undefined,
    // Called before opening a different thread. A subsequent addFile in the same event wins.
    enter: (task: string) => {
      setFileFocus(undefined);
      setState(s => Object.hasOwn(s, task) && s[task].open ? { ...s, [task]: { ...s[task], open: false } } : s);
    },
    addFile: (task:string,href:string) => {
      setFileFocus({taskId:task,href,revision:++fileRevision.current});
      setState(s => openReferenceFile(s, task, href));
    },
    removeFile,
    resolveFile,
    move,
    toggle: (id: number) => { if (taskId) setState(s => toggleReference(s, taskId, id)); },
    show: (open: boolean) => { if (taskId) setState(s => ({ ...s, [taskId]: { ...(Object.hasOwn(s, taskId) ? s[taskId] : EMPTY), open } })); },
    clear: () => { if (taskId) setState(s => ({ ...s, [taskId]: { ids: [], open: true } })); },
  };
}
