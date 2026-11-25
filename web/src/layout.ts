import { KIND_LABEL } from './format.ts';
import { STATUS_LABEL } from './format.ts';
import { projectListLabel } from './projects.ts';
import type { ColumnDef, ColumnFilter, HubEvent, PlacedPost, Post, Project, TaskView } from './types.ts';

/** The deck's column id of the open thread. */
export const THREAD = 'thread';
/** The temporary search column, right of the column that shows everything; not saved. */
export const SEARCH = 'search';

/** A column that restricts nothing: "전체". */
export const isAllFilter = (f: ColumnFilter) =>
  !f.taskIds?.length && !f.projectIds?.length && !f.kinds?.length && !f.statuses?.length && !f.query?.trim();

export interface ModelObservation { id: number; model: string }
/** IDs are ordered within a task's owning source; feed order and arrival order are not. */
export function latestModels(...lists: HubEvent[][]): Map<string, ModelObservation> {
  const out = new Map<string, ModelObservation>();
  for (const list of lists) for (const e of list) {
    if (e.kind === 'status' && (e.payload.state === 'started' || e.payload.state === 'model_changed')
      && typeof e.payload.detail?.model === 'string' && e.payload.detail.model
      && (!out.has(e.task_id) || e.id > out.get(e.task_id)!.id)) {
      out.set(e.task_id, { id: e.id, model: e.payload.detail.model });
    }
  }
  return out;
}

/** Model per task, taken from the newest observed session/model event. */
export function modelsOf(...lists: HubEvent[][]): Map<string, string> {
  return new Map([...latestModels(...lists)].map(([task, observation]) => [task, observation.model]));
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

/** Key runs by their full loaded extent, before clipping to the render window.
 * A new post can evict the visible tail without replacing the existing group DOM.
 */
export function visibleFeedGroups(placed: PlacedPost[], count: number): { key: number; posts: PlacedPost[] }[] {
  const result: { key: number; posts: PlacedPost[] }[] = [];
  for (let start = 0; start < placed.length && count > 0;) {
    let end = start + 1;
    while (end < placed.length && placed[end].up) end++;
    result.push({ key: placed[end - 1].post.id, posts: placed.slice(start, Math.min(start + count, end)) });
    count -= end - start;
    start = end;
  }
  return result;
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

/** The viewport stays the same size when a deferred diagram/image grows inside it. */
export function observeThreadSize(feed: HTMLElement, onResize: () => void): () => void {
  const observer = new ResizeObserver(onResize);
  observer.observe(feed);
  const content = feed.querySelector('.thread-content');
  if (content) observer.observe(content);
  return () => observer.disconnect();
}
