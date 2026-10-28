import { useEffect, useState } from 'react';
import { backgroundCount } from './format.ts';
import type { ColumnDef, Project, TaskView } from './types.ts';

/**
 * Deck views, switched with F1–F4. F1 is the user's own columns; the others are built from the
 * hub's tasks each time and are not edited (pinning or splitting from them goes to F1).
 */
export type View = 'custom' | 'project' | 'task' | 'status';
export const VIEWS: { id: View; key: string; label: string; title: string }[] = [
  { id: 'custom', key: 'F1', label: '내 컬럼', title: '직접 구성한 컬럼' },
  { id: 'project', key: 'F2', label: '프로젝트', title: '프로젝트마다 컬럼 하나 (최근 작업 순, H/L로 순서 변경)' },
  { id: 'task', key: 'F3', label: '작업', title: '작업마다 컬럼 하나 (진행 중인 작업 먼저, H/L로 순서 변경)' },
  { id: 'status', key: 'F4', label: '상태', title: '응답 대기 · 멈춤·오류 · 작성 중 · 실행 중 · 완료 ' },
];
/** F2 and F3 make at most this many columns. */
export const VIEW_MAX = 12;

const KEY = 'agent-desk.view';
const BY_TASK_KEY = 'agent-desk.viewByTask';
const ORDER_KEY = 'agent-desk.viewOrder';

/** Views whose columns the user can reorder with H/L or sort; the order is kept per view. */
export const ORDERED: View[] = ['project'];
/**
 * A sort that stays in force as projects and tasks come and go. `count`: most posts in all first, by
 * the counts when the sort was picked or the view opened, so columns do not move while posts arrive.
 */
export type ViewSort = 'name' | 'created' | 'count';
/** Per view: a sort, or the column ids in the order the user moved them to with H/L. */
export type ViewOrder = Partial<Record<View, string[] | ViewSort>>;
export const SORT_LABEL: Record<ViewSort, string> = { name: '이름순', created: '만든 순', count: '글 많은 순' };

/**
 * The current view and, for the built views, "작업별로 묶어 보기" per column id and the column
 * order the user set with H/L.
 */
export function useView() {
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem(KEY);
    return VIEWS.some((x) => x.id === v) ? v as View : 'custom';
  });
  const [byTask, setByTask] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(BY_TASK_KEY) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, view); } catch { /* storage unavailable */ } }, [view]);
  const [order, setOrder] = useState<ViewOrder>(() => {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(BY_TASK_KEY, JSON.stringify(byTask)); } catch { /* storage unavailable */ } }, [byTask]);
  useEffect(() => { try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* storage unavailable */ } }, [order]);
  return { view, setView, byTask, setByTask, order, setOrder };
}

/**
 * Puts a built view's columns in the order the user set. A sort applies to every column, new
 * ones too: by title (numbers in order, so #2 before #10), or oldest first so new columns land at
 * the right end. A moved order keeps the columns it knows in place; one it does not know yet
 * (a new project or task) goes in where the automatic order puts it. `size`: a column's posts in
 * all for the `count` sort; uncounted ones go last, in their order.
 */
export function applyOrder(cols: ColumnDef[], order: string[] | ViewSort | undefined, created: (c: ColumnDef) => string,
  size: (c: ColumnDef) => number | undefined = () => undefined): ColumnDef[] {
  if (order === 'count') return [...cols].sort((a, b) => (size(b) ?? -1) - (size(a) ?? -1));
  if (order === 'name') return [...cols].sort((a, b) => a.title.localeCompare(b.title, 'ko', { numeric: true }));
  if (order === 'created') return [...cols].sort((a, b) => created(a).localeCompare(created(b)));
  if (!order?.length) return cols;
  const rank = new Map(order.map((id, i) => [id, i]));
  const out = cols.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  cols.forEach((c, i) => { if (!rank.has(c.id)) out.splice(Math.min(i, out.length), 0, c); });
  return out;
}

/** A filter no task matches, for a status column that is empty right now. */
const NONE = ['-'];
const active = (t: TaskView) => t.status === 'running' || t.status === 'waiting' || t.status === 'error' || backgroundCount(t) > 0;
/** When the task last did something: its newest post, else its last update. */
const lastActive = (t: TaskView) => t.last_event?.ts ?? t.updated_at;
const recent = (a: TaskView, b: TaskView) => lastActive(b).localeCompare(lastActive(a));

/** `limit`: how many columns F2 and F3 show; going right past the last column raises it to show older ones. */
export function viewColumns(view: Exclude<View, 'custom'>, tasks: Map<string, TaskView>, projects: Project[],
  stalled: Set<string>, drafts: Set<string>, byTask: Record<string, boolean>, limit = VIEW_MAX): ColumnDef[] {
  const all = [...tasks.values()];
  let cols: ColumnDef[];
  if (view === 'project') {
    // Ordered by each project's newest task, so the columns keep their places while tasks run.
    const latest = new Map<string, string>();
    for (const t of all) if ((latest.get(t.project_id) ?? '') < t.created_at) latest.set(t.project_id, t.created_at);
    cols = projects.filter((p) => latest.has(p.id))
      .sort((a, b) => latest.get(b.id)!.localeCompare(latest.get(a.id)!)).slice(0, limit)
      .map((p) => ({ id: `v:p:${p.id}`, title: p.name, filter: { projectIds: [p.id] } }));
  } else if (view === 'task') {
    // Working tasks always get a column; the rest go by recent activity. Columns run newest activity first.
    const pick = [...all.filter(active).sort(recent), ...all.filter((t) => !active(t)).sort(recent)].slice(0, limit).sort(recent);
    cols = pick.map((t) => ({ id: `v:t:${t.id}`, title: `${t.project_name}#${t.seq} ${t.title}`, filter: { taskIds: [t.id] } }));
  } else {
    // Each task in one column: the first of 응답 대기, 멈춤·오류, 작성 중, 실행 중, 완료 that fits.
    const place = (t: TaskView) => t.status === 'waiting' ? 'wait'
      : t.status === 'error' || stalled.has(t.id) ? 'trouble'
      : drafts.has(t.id) ? 'draft'
      : t.status === 'running' || backgroundCount(t) > 0 ? 'run' : 'done';
    const ids = (where: string) => { const r = all.filter((t) => place(t) === where).map((t) => t.id); return r.length ? r : NONE; };
    // One card per task by default: the board is about which tasks are where.
    cols = [
      { id: 'v:s:wait', title: '응답 대기', note: '승인·질문을 기다리는 작업', filter: { taskIds: ids('wait') } },
      { id: 'v:s:run', title: '실행 중', note: '실행 중이거나 서브 에이전트가 일하는 작업', filter: { taskIds: ids('run') } },
      { id: 'v:s:trouble', title: '멈춤·오류', note: '오류 · 3분 넘게 응답 없음', filter: { taskIds: ids('trouble') } },
      { id: 'v:s:draft', title: '작성 중', note: '보내지 않은 답글이 있는 작업', filter: { taskIds: ids('draft') } },
      { id: 'v:s:done', title: '완료', note: '끝났거나 다음 지시를 기다리는 작업', filter: { taskIds: ids('done') } },
    ];
    return cols.map((c) => ({ ...c, byTask: byTask[c.id] ?? true }));
  }
  return cols.map((c) => (byTask[c.id] ? { ...c, byTask: true } : c));
}
