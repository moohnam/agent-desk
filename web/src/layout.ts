import { KIND_LABEL } from './ColumnDialog.tsx';
import { STATUS_LABEL } from './format.ts';
import { projectListLabel } from './projects.ts';
import type { ColumnDef, ColumnFilter, HubEvent, PlacedPost, Post, Project, TaskView } from './types.ts';

/** A column that restricts nothing: "전체". */
export const isAllFilter = (f: ColumnFilter) =>
  !f.taskIds?.length && !f.projectIds?.length && !f.kinds?.length && !f.statuses?.length && !f.query?.trim();

/** Model per task, taken from the session-start events seen so far. */
export function modelsOf(...lists: HubEvent[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of lists) for (const e of list) {
    // The model a turn actually ran on: reported at the start and again after a model tag switch.
    if (e.kind === 'status' && (e.payload.state === 'started' || e.payload.state === 'model_changed') && e.payload.detail?.model) {
      out.set(e.task_id, e.payload.detail.model);
    }
  }
  return out;
}

/** Splits a placed feed into runs of connected posts, each shown under one task header. */
/** "작업별로 묶기": each task's newest post, newest first, drawn as one card. */
export function newestPerTask(newestFirst: Post[]): PlacedPost[] {
  const seen = new Set<string>();
  return newestFirst.filter((p) => !seen.has(p.taskId) && seen.add(p.taskId)).map((post) => ({ post, up: false, down: false }));
}

/** Hue offset that tells a project's tasks apart: #1 keeps the project color, later ones turn around it. */
export const TASK_HUES = [0, 45, -45, 90, -90, 135, -135];
export const taskHue = (seq: number | undefined) => TASK_HUES[((seq ?? 1) - 1) % TASK_HUES.length];

export function groupsOf(placed: PlacedPost[]): PlacedPost[][] {
  const out: PlacedPost[][] = [];
  for (const p of placed) {
    if (!p.up || !out.length) out.push([p]);
    else out[out.length - 1].push(p);
  }
  return out;
}

export function filterLabel(def: ColumnDef, projects: Map<string, Project>, tasks: Map<string, TaskView>): string {
  const f = def.filter;
  const text = def.note ?? ([
    f.taskIds?.length ? f.taskIds.map((id) => {
      const t = tasks.get(id);
      return t ? `${t.project_name}#${t.seq} · ${STATUS_LABEL[t.status]}` : '삭제된 작업';
    }).join(', ') : null,
    f.projectIds?.length ? projectListLabel(f.projectIds.map((id) => projects.get(id)?.name ?? '?')) : null,
    f.kinds?.length ? f.kinds.map((k) => KIND_LABEL[k]).join('·') : null,
    f.statuses?.length ? f.statuses.map((s) => STATUS_LABEL[s]).join('·') : null,
    f.query ? `“${f.query}”` : null,
  ].filter(Boolean).join(' · ') || '모든 글');
  return def.byTask ? `${text} · 작업별` : text;
}

/**
 * The first post in `feed` whose bottom is below `top`. Posts lie top to bottom in document order,
 * so a binary search reads a handful of positions instead of every post above the view.
 */
export function firstPostBelow(feed: HTMLElement, top: number): HTMLElement | undefined {
  const all = feed.querySelectorAll<HTMLElement>('[data-post]');
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return all[lo];
}
