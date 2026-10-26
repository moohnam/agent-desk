import type { Project, TaskView } from './types.ts';

/**
 * Project colors: the --proj-N slots in styles.css, stepped per light/dark. Picked to stay apart from
 * one another (any two, also under color blindness) and from the accent, warning and error colors.
 */
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--proj-${i + 1})`);

// Colors by creation order, so the first eight projects never share one; set with the project list.
const assigned = new Map<string, string>();
export function assignProjectColors(projects: Project[]) {
  [...projects].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .forEach((p, i) => assigned.set(p.id, COLORS[i % COLORS.length]));
}

/** A stable color per project, so its dot looks the same in every column. */
export function projectColor(id: string): string {
  const known = assigned.get(id);
  if (known) return known;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

export function latestTaskOf(projectId: string, tasks: Iterable<TaskView>): TaskView | undefined {
  let last: TaskView | undefined;
  for (const t of tasks) if (t.project_id === projectId && (!last || t.updated_at > last.updated_at)) last = t;
  return last;
}

export interface RankedProject { project: Project; last?: TaskView }

/**
 * Projects matching `query` by name or path, for pickers that must stay usable with many projects:
 * name-prefix matches first, then other name matches, then path-only matches; within each,
 * projects with tasks by latest activity, then the rest by name.
 */
export function rankProjects(projects: Project[], tasks: Iterable<TaskView>, query = ''): RankedProject[] {
  const q = query.trim().toLowerCase();
  const all = [...tasks];
  const tier = (p: Project) => {
    const name = p.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
  };
  return projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.root_path.toLowerCase().includes(q))
    .map((project) => ({ project, last: latestTaskOf(project.id, all) }))
    .sort((a, b) => tier(a.project) - tier(b.project)
      || (b.last?.updated_at ?? '').localeCompare(a.last?.updated_at ?? '')
      || a.project.name.localeCompare(b.project.name, undefined, { numeric: true }));
}

/** "@a, @b 외 3개" — keeps column labels short however many projects a filter names. */
export function projectListLabel(names: string[], max = 2): string {
  const shown = names.slice(0, max).map((n) => `@${n}`).join(', ');
  return names.length > max ? `${shown} 외 ${names.length - max}개` : shown;
}

/** "claude-opus-5-5" → "Opus 5.5"; other ids are shown as is. */
export function modelShort(model: string | undefined): string {
  if (!model) return '';
  if (!model.startsWith('claude-')) return model;
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase());
}
