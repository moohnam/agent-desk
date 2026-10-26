import { useEffect, useState } from 'react';
import type { ColumnDef, Project, TaskView } from './types.ts';

/**
 * Deck views, switched with F1–F4. F1 is the user's own columns; the others are built from the
 * hub's tasks each time and are not edited (pinning or splitting from them goes to F1).
 */
export type View = 'custom' | 'project' | 'task' | 'status';
export const VIEWS: { id: View; key: string; label: string; title: string }[] = [
  { id: 'custom', key: 'F1', label: '내 컬럼', title: '직접 구성한 컬럼' },
  { id: 'project', key: 'F2', label: '프로젝트', title: '프로젝트마다 컬럼 하나 (최근 작업 순)' },
  { id: 'task', key: 'F3', label: '작업', title: '작업마다 컬럼 하나 (진행 중인 작업 먼저)' },
  { id: 'status', key: 'F4', label: '상태', title: '응답 대기 · 실행 중 · 멈춤·오류 · 작성 중 · 완료' },
];
/** F2 and F3 make at most this many columns. */
export const VIEW_MAX = 12;

const KEY = 'agent-desk.view';
const BY_TASK_KEY = 'agent-desk.viewByTask';

/** The current view and, for the built views, "작업별로 묶어 보기" per column id. */
export function useView() {
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem(KEY);
    return VIEWS.some((x) => x.id === v) ? v as View : 'custom';
  });
  const [byTask, setByTask] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(BY_TASK_KEY) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, view); } catch { /* storage unavailable */ } }, [view]);
  useEffect(() => { try { localStorage.setItem(BY_TASK_KEY, JSON.stringify(byTask)); } catch { /* storage unavailable */ } }, [byTask]);
  return { view, setView, byTask, setByTask };
}

/** A filter no task matches, for a status column that is empty right now. */
const NONE = ['-'];
const active = (t: TaskView) => t.status === 'running' || t.status === 'waiting' || t.status === 'error';
const newest = (a: TaskView, b: TaskView) => b.created_at.localeCompare(a.created_at);

export function viewColumns(view: Exclude<View, 'custom'>, tasks: Map<string, TaskView>, projects: Project[],
  stalled: Set<string>, drafts: Set<string>, byTask: Record<string, boolean>): ColumnDef[] {
  const all = [...tasks.values()];
  let cols: ColumnDef[];
  if (view === 'project') {
    // Ordered by each project's newest task, so the columns keep their places while tasks run.
    const latest = new Map<string, string>();
    for (const t of all) if ((latest.get(t.project_id) ?? '') < t.created_at) latest.set(t.project_id, t.created_at);
    cols = projects.filter((p) => latest.has(p.id))
      .sort((a, b) => latest.get(b.id)!.localeCompare(latest.get(a.id)!)).slice(0, VIEW_MAX)
      .map((p) => ({ id: `v:p:${p.id}`, title: p.name, filter: { projectIds: [p.id] } }));
  } else if (view === 'task') {
    const pick = [...all.filter(active).sort(newest), ...all.filter((t) => !active(t)).sort(newest)].slice(0, VIEW_MAX);
    cols = pick.map((t) => ({ id: `v:t:${t.id}`, title: `${t.project_name}#${t.seq} ${t.title}`, filter: { taskIds: [t.id] } }));
  } else {
    const trouble = all.filter((t) => t.status === 'error' || stalled.has(t.id)).map((t) => t.id);
    const drafting = all.filter((t) => drafts.has(t.id)).map((t) => t.id);
    // One card per task by default: the board is about which tasks are where.
    cols = [
      { id: 'v:s:wait', title: '응답 대기', note: '승인·질문을 기다리는 작업', filter: { statuses: ['waiting'] } },
      { id: 'v:s:run', title: '실행 중', note: '실행 중인 작업', filter: { statuses: ['running'] } },
      { id: 'v:s:trouble', title: '멈춤·오류', note: '오류 · 3분 넘게 응답 없음', filter: { taskIds: trouble.length ? trouble : NONE } },
      { id: 'v:s:draft', title: '작성 중', note: '보내지 않은 답글이 있는 작업', filter: { taskIds: drafting.length ? drafting : NONE } },
      { id: 'v:s:done', title: '완료', note: '끝났거나 다음 지시를 기다리는 작업', filter: { statuses: ['done', 'idle'] } },
    ];
    return cols.map((c) => ({ ...c, byTask: byTask[c.id] ?? true }));
  }
  return cols.map((c) => (byTask[c.id] ? { ...c, byTask: true } : c));
}
