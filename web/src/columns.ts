import { workspaceKey } from './workspace.ts';
import { useEffect, useState } from 'react';
import type { ColumnDef } from './types.ts';

const KEY = workspaceKey('agent-desk.columns.v2');

const DEFAULT_COLUMNS: ColumnDef[] = [{ id: 'all', title: '전체', filter: {} }];

function load(): ColumnDef[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall back to defaults */ }
  return DEFAULT_COLUMNS;
}

export function useColumns() {
  const [columns, setColumns] = useState<ColumnDef[]>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(columns)); } catch { /* storage unavailable */ }
  }, [columns]);
  return [columns, setColumns] as const;
}

const WIDTH_KEY = workspaceKey('agent-desk.columnWidths');
export const WIDTH_PRESETS = [{ label: '좁게', px: 300 }, { label: '보통', px: 380 }, { label: '넓게', px: 480 }];
export const DEFAULT_WIDTH = 380;
export const MIN_WIDTH = 260;
export const MAX_WIDTH = 900;
/** Wait after the last change before saving a dragged size, in ms. */
export const SAVE_DELAY = 300;

/** Fixed per-column widths in px, keyed by column id; a missing entry means the column's default. */
export function useColumnWidths() {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}'); } catch { return {}; }
  });
  // Saved once a drag settles, not on every pointer move.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(WIDTH_KEY, JSON.stringify(widths)); } catch { /* storage unavailable */ }
    }, SAVE_DELAY);
    return () => clearTimeout(t);
  }, [widths]);
  const setWidth = (id: string, px: number | null) => setWidths((w) => {
    const v = px == null ? undefined : Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px)) / 10) * 10;
    // Unchanged: the same object, so React skips the render.
    if (w[id] === v) return w;
    const { [id]: _, ...rest } = w;
    return v == null ? rest : { ...rest, [id]: v };
  });
  return [widths, setWidth] as const;
}
