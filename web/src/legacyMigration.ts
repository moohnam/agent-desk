export const EVENT_BLOCK = 1_000_000_000_000;

export interface LegacySource {
  id: string;
  view_index: number;
  legacy_project_ids?: string[];
  legacy_task_ids?: string[];
  legacy_approval_ids?: string[];
  legacy_question_ids?: string[];
  legacy_runner_ids?: string[];
}

export const LEGACY_MIGRATION_KEY = 'agent-desk.legacyMigration.v1';
let pendingNotification = false;

export function legacySourceId(id: string, sources: LegacySource[]) {
  if (sources.some(source => source.id === id)) return id;
  const matches = sources.filter(source => source.legacy_runner_ids?.includes(id));
  return matches.length === 1 ? matches[0].id : id;
}

/** Only IDs named by the gateway's migration manifest can change ownership. */
export function legacyIds(sources: LegacySource[]) {
  const owner = (field: keyof LegacySource) => {
    const found = new Map<string, LegacySource>(), ambiguous = new Set<string>();
    for (const source of sources) for (const id of ((source[field] as string[] | undefined) ?? [])) {
      if (found.has(id) && found.get(id)!.id !== source.id) ambiguous.add(id);
      else found.set(id, source);
    }
    for (const id of ambiguous) found.delete(id);
    return found;
  };
  const projects = owner('legacy_project_ids'), tasks = owner('legacy_task_ids');
  const approvals = owner('legacy_approval_ids'), questions = owner('legacy_question_ids');
  const scoped = (id: string, map: Map<string, LegacySource>) => {
    const source = map.get(id);
    return source && !id.startsWith('w:') ? `w:${source.id}:${id}` : id;
  };
  const event = (id: number, task: string) => {
    const source = tasks.get(task);
    const mapped = source && source.view_index * EVENT_BLOCK + id;
    return source && id > 0 && id < EVENT_BLOCK && Number.isSafeInteger(mapped) ? mapped! : id;
  };
  return { projects, tasks, approvals, questions, scoped, event };
}

/** Idempotent per-key rewrite; a missing or damaged value is left intact. */
export function migrateLegacyStorage(storage: Pick<Storage, 'getItem' | 'setItem'>, sources: LegacySource[]) {
  const ids = legacyIds(sources);
  if (![ids.projects, ids.tasks, ids.approvals, ids.questions].some(m => m.size)
    && !sources.some(source => source.legacy_runner_ids?.length)) return false;
  const task = (id: string) => ids.scoped(id, ids.tasks);
  const project = (id: string) => ids.scoped(id, ids.projects);
  const column = (id: string) => id.startsWith('v:t:') ? `v:t:${task(id.slice(4))}`
    : id.startsWith('v:p:') ? `v:p:${project(id.slice(4))}` : id;
  let changed = false, failed = false;
  const rewrite = (key: string, transform: (value: any) => any) => {
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { failed = true; return; }
    if (raw == null) return;
    let next: string, original: string;
    try {
      const parsed = JSON.parse(raw);
      original = JSON.stringify(parsed);
      next = JSON.stringify(transform(parsed));
    } catch { return; /* Keep damaged preferences for manual recovery. */ }
    if (next !== original) try { storage.setItem(key, next); changed = true; pendingNotification = true; }
    catch { failed = true; }
  };
  rewrite('agent-desk.columns.v2', (rows: any) => Array.isArray(rows) ? rows.map(row => row?.filter ? ({...row, filter: {
    ...row.filter,
    ...(Array.isArray(row.filter.taskIds) ? {taskIds: [...new Set(row.filter.taskIds.map(task))]} : {}),
    ...(Array.isArray(row.filter.projectIds) ? {projectIds: [...new Set(row.filter.projectIds.map(project))]} : {}),
  }}) : row) : rows);
  for (const key of ['agent-desk.viewByTask', 'agent-desk.columnWidths']) rewrite(key, (value: any) => {
    if (!value || Array.isArray(value) || typeof value !== 'object') return value;
    const out: Record<string, unknown> = Object.create(null);
    for (const [id, preference] of Object.entries(value)) {
      const next = column(id);
      if (next === id || !Object.hasOwn(out, next)) out[next] = preference;
    }
    return out;
  });
  rewrite('agent-desk.viewOrder', (value: any) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([view, order]) => [view, Array.isArray(order) ? [...new Set(order.map(column))] : order])) : value);
  rewrite('agent-desk.threadReferences', (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, any> = Object.create(null);
    for (const [old, selection] of Object.entries(value) as [string, any][]) {
      const next = task(old);
      const current = out[next];
      const selected = selection && typeof selection === 'object' && Array.isArray((selection as any).ids)
        ? {...selection, ids: (selection as any).ids.map((id: number) => ids.event(id, old))} : selection;
      out[next] = current && selected && Array.isArray(current.ids) && Array.isArray(selected.ids)
        ? {...selected, ids: [...new Set([...current.ids, ...selected.ids])], open: current.open || selected.open} : selected;
    }
    return out;
  });
  rewrite('agent-desk.drafts.v1', (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, any> = Object.create(null);
    for (const [key, draft] of Object.entries(value) as [string, any][]) {
      const old = draft?.taskId;
      const nextKey = key.startsWith('reply:') || key.startsWith('handoff:') ? `${key.split(':')[0]}:${task(key.slice(key.indexOf(':') + 1))}`
        : key.startsWith('question:') ? `question:${ids.scoped(key.slice(9), ids.questions)}`
        : key.startsWith('ask:') ? `ask:${ids.scoped(key.slice(4), ids.approvals)}` : key;
      const value = draft && typeof draft === 'object' ? {...draft, taskId: typeof old === 'string' ? task(old) : old} : draft;
      if (key === 'drawer-target' && typeof value?.value === 'string')
        value.value = legacySourceId(value.value, sources);
      if (key.startsWith('handoff:') && value?.value && typeof old === 'string' && ids.tasks.has(old)) {
        const handoff = value.value;
        value.value = {...handoff,
          picked: Array.isArray(handoff.picked) ? handoff.picked.map((id: number) => ids.event(id, old)) : handoff.picked,
          after: typeof handoff.after === 'number' ? ids.event(handoff.after, old) : handoff.after};
      }
      if (!out[nextKey] || (value?.at ?? 0) >= (out[nextKey]?.at ?? 0)) out[nextKey] = value;
    }
    return out;
  });
  rewrite('agent-desk.notified', (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, any> = Object.create(null);
    for (const [key, at] of Object.entries(value)) {
      let next = key;
      if (key.startsWith('approval:')) next = `approval:${ids.scoped(key.slice(9), ids.approvals)}`;
      else if (key.startsWith('question:')) next = `question:${ids.scoped(key.slice(9), ids.questions)}`;
      else if (key.startsWith('done:') || key.startsWith('error:')) {
        const match = /^(done|error):([^:]+):(.*)$/.exec(key);
        if (match) next = `${match[1]}:${task(match[2])}:${match[3]}`;
      }
      out[next] = Math.max(Number(out[next]) || 0, Number(at) || 0);
    }
    return out;
  });
  try {
    const old = storage.getItem('agent-desk.location');
    const runner = old?.startsWith('runner:') ? old.slice('runner:'.length) : null;
    const workspace = old?.startsWith('workspace:') ? old.slice('workspace:'.length) : null;
    const matches = runner ? sources.filter(source => source.legacy_runner_ids?.includes(runner)
      || source.id === runner && (source.legacy_project_ids?.length || source.legacy_task_ids?.length))
      : workspace && !sources.some(source => source.id === workspace)
      ? sources.filter(source => source.legacy_runner_ids?.includes(workspace)) : [];
    if (matches.length === 1) {
      storage.setItem('agent-desk.location', `workspace:${matches[0].id}`);
      changed = true;
      pendingNotification = true;
    }
  } catch { failed = true; }
  if (failed) throw new Error('기존 브라우저 저장값을 옮기지 못했습니다');
  if (pendingNotification) {
    storage.setItem(LEGACY_MIGRATION_KEY, `${Date.now()}:${Math.random()}`);
    pendingNotification = false;
    return true;
  }
  return changed;
}
