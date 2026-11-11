import { workspaceKey } from './workspace.ts';
import { useEffect, useLayoutEffect, useState } from 'react';
import type { HubEvent } from './types.ts';

export const REFERENCES_KEY = workspaceKey('agent-desk.threadReferences');
export interface ReferenceSelection { ids: number[]; open: boolean }
export type ThreadReferences = Record<string, ReferenceSelection>;
const EMPTY: ReferenceSelection = { ids: [], open: false };

/** Keep only source IDs, in the order chosen; never duplicate conversation text in storage. */
export function readReferences(raw: string | null): ThreadReferences {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed).flatMap(([task, value]) => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.ids)) return [];
      const ids = [...new Set<number>(value.ids.filter((id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0))];
      return [[task, { ids, open: ids.length > 0 && value.open === true }] as const];
    });
    return Object.fromEntries(entries);
  } catch { return {}; }
}

export function toggleReference(state: ThreadReferences, task: string, id: number): ThreadReferences {
  if (!Number.isSafeInteger(id) || id < 1) return state;
  const current = Object.hasOwn(state, task) ? state[task] : EMPTY;
  const held = current.ids.includes(id);
  return { ...state, [task]: { ids: held ? current.ids.filter(n => n !== id) : [...current.ids, id], open: held ? current.open : true } };
}

/** Whole, task-scoped originals only; a live clipped event must be fetched before displaying it. */
export function referenceEvents(task: string, ids: number[], events: HubEvent[]): Map<number, HubEvent> {
  const wanted = new Set(ids);
  return new Map(events.filter(e => e.task_id === task && wanted.has(e.id) && !e.payload.clipped).map(e => [e.id, e]));
}

export function useThreadReferences(taskId: string | null, gone: Set<string>) {
  const [state, setState] = useState<ThreadReferences>(() => {
    try { return readReferences(localStorage.getItem(REFERENCES_KEY)); } catch { return {}; }
  });
  // An empty pane may be opened explicitly, but should not reopen with the thread.
  useLayoutEffect(() => {
    if (!taskId) return;
    setState(previous => {
      const selected = Object.hasOwn(previous, taskId) ? previous[taskId] : undefined;
      return selected?.open && !selected.ids.length
        ? { ...previous, [taskId]: { ...selected, open: false } } : previous;
    });
  }, [taskId]);
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
    toggle: (id: number) => { if (taskId) setState(s => toggleReference(s, taskId, id)); },
    show: (open: boolean) => { if (taskId) setState(s => ({ ...s, [taskId]: { ...(Object.hasOwn(s, taskId) ? s[taskId] : EMPTY), open } })); },
    clear: () => { if (taskId) setState(s => ({ ...s, [taskId]: { ids: [], open: true } })); },
  };
}
