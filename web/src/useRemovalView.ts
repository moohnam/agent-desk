import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceRemoval } from '../../shared/workspace.ts';
import type { useHub } from './useHub.ts';
const EMPTY = new Set<string>();

/** The gateway's durable delete intent also hides work while its runner is offline. */
export function useRemovalView(hub: ReturnType<typeof useHub>) {
  const [removals, setRemovals] = useState<WorkspaceRemoval[]>([]);
  const [removalsReady, setRemovalsReady] = useState(false);
  const [removalError, setRemovalError] = useState<{id:string;message:string}>();
  const seenFailures = useRef(new Set<string>());
  const generation = useRef(0);
  const acceptRemoval = useCallback((kind: 'task' | 'project', id: string, operationId: string) => {
    generation.current++;
    setRemovals(previous => previous.some(item => item.id === operationId) ? previous : [...previous,
      {id:operationId, status:null, ...(kind === 'task' ? {taskId:id} : {projectId:id})}]);
  }, []);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let etag = '';
    try { seenFailures.current = new Set(JSON.parse(localStorage.getItem('agent-desk.removal-failures') ?? '[]')); } catch { /* Optional storage. */ }
    const poll = async () => {
      const started = generation.current;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 10_000);
      try {
        const response = await fetch('/api/removals', {signal:request.signal, cache:'no-store',headers:etag?{'if-none-match':etag}:{}});
        if (closed || started !== generation.current) return;
        if (response.status === 304) return;
        if (response.status === 404) { setRemovalsReady(true); return; }
        if (!response.ok) throw new Error('삭제 전달 상태를 확인하지 못했습니다');
        const next: WorkspaceRemoval[] = await response.json();
        if (!Array.isArray(next)) throw new Error('잘못된 삭제 전달 상태입니다');
        if (closed || started !== generation.current) return;
        etag=response.headers.get('etag') ?? '';
        const failures = next.filter(item => item.status !== null && item.status >= 400 && item.status !== 404);
        const failed = failures.findLast(item => !seenFailures.current.has(item.id));
        if (failed) {
          setRemovalError({id:failed.id,message:`러너가 삭제를 거절해 다시 표시했습니다: ${failed.error ?? '전달 내역을 확인해 주세요'}`});
          for (const item of failures) seenFailures.current.add(item.id);
          try { localStorage.setItem('agent-desk.removal-failures',JSON.stringify([...seenFailures.current])); } catch { /* Optional storage. */ }
        }
        setRemovals(previous => {
          return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
        });
        setRemovalsReady(true);
      } catch { /* A temporary gateway failure must not reveal pending removals. */ }
      finally { clearTimeout(timeout); if (!closed) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  const view = useMemo(() => {
    if (!removalsReady) return {projects:[],tasks:new Map(),approvals:new Map(),questions:new Map(),events:[],hiddenTasks:new Set(hub.tasks.keys()),hiddenProjects:EMPTY};
    const hidden = removals.filter(item => item.status === null || item.status < 400 || item.status === 404);
    if (!hidden.length) return {hiddenTasks:EMPTY,hiddenProjects:EMPTY};
    const projects = new Set(hidden.flatMap(item => item.projectId ? [item.projectId] : []));
    const tasks = new Set(hidden.flatMap(item => item.taskId ? [item.taskId] : []));
    for (const task of hub.tasks.values()) if (projects.has(task.project_id)) tasks.add(task.id);
    const keep = <T extends {task_id:string}>(items: Map<string,T>) => new Map([...items].filter(([,item]) => !tasks.has(item.task_id)));
    return {projects:hub.projects.filter(item => !projects.has(item.id)),
      tasks:new Map([...hub.tasks].filter(([id]) => !tasks.has(id))),
      approvals:keep(hub.approvals), questions:keep(hub.questions),
      events:hub.events.filter(item => !tasks.has(item.task_id)), hiddenTasks:tasks,hiddenProjects:projects};
  }, [removals, removalsReady, hub.tasks, hub.projects, hub.approvals, hub.questions, hub.events, hub.gone]);
  return {...hub, ...view, acceptRemoval, removalError, removalsReady};
}
