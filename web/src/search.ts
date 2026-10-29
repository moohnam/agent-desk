import { KIND_LABEL, STATUS_LABEL } from './format.ts';
import { projectColor, rankProjects } from './projects.ts';
import type { ColumnFilter, PostKind, Project, TaskStatus, TaskView } from './types.ts';

/**
 * The search column's query: `#key:value` filters (OR within a key, AND across keys) and plain
 * words, which the hub looks for as one phrase in task titles and post text.
 */
export type FilterKey = 'project' | 'task' | 'status' | 'kind';

const KEYS: { key: FilterKey; label: string; aliases: string[] }[] = [
  { key: 'project', label: '프로젝트', aliases: ['프로젝트', 'p'] },
  { key: 'task', label: '작업 (프로젝트#번호)', aliases: ['작업', 't'] },
  { key: 'status', label: '작업 상태', aliases: ['상태', 's'] },
  { key: 'kind', label: '글 종류', aliases: ['종류', 'k'] },
];
const KINDS = Object.keys(KIND_LABEL) as PostKind[];
const STATUSES: TaskStatus[] = ['running', 'waiting', 'done', 'idle', 'error'];
const squash = (s: string) => s.toLowerCase().replace(/[\s·]/g, '');

function keyOf(name: string): FilterKey | undefined {
  const n = name.toLowerCase();
  return KEYS.find((k) => k.key === n || k.aliases.includes(n))?.key;
}

/** Splits a query into words, keeping a quoted value (`#project:"my app"`) whole. */
function tokens(text: string): string[] {
  return text.match(/#[^\s:]+:"[^"]*"?|"[^"]*"?|\S+/g) ?? [];
}

export interface ParsedSearch { filter: ColumnFilter; unknown: string[] }

export function parseSearch(text: string, projects: Project[], tasks: Iterable<TaskView>): ParsedSearch {
  const f: Required<Pick<ColumnFilter, 'projectIds' | 'taskIds' | 'statuses' | 'kinds'>> = { projectIds: [], taskIds: [], statuses: [], kinds: [] };
  const words: string[] = [];
  const unknown: string[] = [];
  const all = [...tasks];
  const projectNamed = (name: string) => projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  for (const tok of tokens(text)) {
    const m = /^#([^\s:]+):(.*)$/.exec(tok);
    const key = m && keyOf(m[1]);
    if (!m || !key) { words.push(tok.replace(/^"|"$/g, '')); continue; }
    const value = m[2].replace(/^"|"$/g, '');
    if (!value) continue;
    let ok = true;
    if (key === 'project') {
      const p = projectNamed(value);
      if (p) f.projectIds.push(p.id); else ok = false;
    } else if (key === 'task') {
      const t = /^(.+)#(\d+)$/.exec(value);
      const p = t && projectNamed(t[1]);
      const task = p && all.find((x) => x.project_id === p.id && x.seq === Number(t![2]));
      if (task) f.taskIds.push(task.id); else ok = false;
    } else if (key === 'status') {
      const s = STATUSES.find((x) => x === value.toLowerCase() || squash(STATUS_LABEL[x]) === squash(value));
      if (s) f.statuses.push(s); else ok = false;
    } else {
      const k = KINDS.find((x) => x === value.toLowerCase() || squash(KIND_LABEL[x]) === squash(value));
      if (k) f.kinds.push(k); else ok = false;
    }
    if (!ok) unknown.push(tok);
  }
  const query = words.join(' ').trim();
  return {
    filter: Object.fromEntries(Object.entries({ ...f, query }).filter(([, v]) => v.length)) as ColumnFilter,
    unknown,
  };
}

export interface SearchOption { key: string; insert: string; label: string; desc?: string; color?: string; more?: boolean }
export interface Suggestions { start: number; end: number; items: SearchOption[] }

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);
const MAX = 30;

/** Completions for the `#key:value` being typed at the caret. `more`: picking it keeps completing. */
export function suggestSearch(text: string, caret: number, projects: Project[], tasks: TaskView[]): Suggestions | null {
  const start = text.slice(0, caret).search(/\S*$/);
  const rest = /^\S*/.exec(text.slice(caret))![0];
  const word = text.slice(start, caret);
  const end = caret + rest.length;
  if (!word.startsWith('#')) return null;
  const colon = word.indexOf(':');
  if (colon < 0) {
    const q = word.slice(1).toLowerCase();
    const items = KEYS.filter((k) => k.key.startsWith(q) || k.aliases.some((a) => a.startsWith(q)))
      .map((k) => ({ key: k.key, insert: `#${k.key}:`, label: `#${k.key}:`, desc: k.label, more: true }));
    return items.length ? { start, end, items } : null;
  }
  const key = keyOf(word.slice(1, colon));
  if (!key) return null;
  const q = word.slice(colon + 1).replace(/^"/, '').toLowerCase();
  const head = `#${key}:`;
  let items: SearchOption[] = [];
  if (key === 'project') {
    items = rankProjects(projects, tasks, q).slice(0, MAX).map(({ project, last }) => ({
      key: project.id, insert: head + quote(project.name), label: project.name, color: projectColor(project.id),
      desc: last ? `› ${last.title}` : project.root_path,
    }));
  } else if (key === 'task') {
    items = tasks.filter((t) => `${t.project_name}#${t.seq}`.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, MAX)
      .map((t) => ({ key: t.id, insert: head + quote(`${t.project_name}#${t.seq}`), label: `${t.project_name}#${t.seq}`,
        color: projectColor(t.project_id), desc: `› ${t.title}` }));
  } else if (key === 'status') {
    items = STATUSES.filter((s) => s.startsWith(q) || STATUS_LABEL[s].includes(q))
      .map((s) => ({ key: s, insert: head + s, label: s, desc: STATUS_LABEL[s] }));
  } else {
    items = KINDS.filter((k) => k.startsWith(q) || KIND_LABEL[k].includes(q))
      .map((k) => ({ key: k, insert: head + k, label: k, desc: KIND_LABEL[k] }));
  }
  return items.length ? { start, end, items } : null;
}
