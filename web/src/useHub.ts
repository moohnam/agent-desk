import { useCallback, useEffect, useRef, useState } from 'react';
import { api, FEED_PAGE, type FeedQuery } from './api.ts';
import { mergeEvents } from './posts.ts';
import { assignProjectColors } from './projects.ts';
import type { Approval, ColumnDef, ColumnFilter, EventKind, HubEvent, HubMessage, PostKind, Project, Question, TaskView } from './types.ts';

const FEED_CAP = 3000;
/** How long an open thread gathers cut live events before fetching them whole. */
const WHOLE_DELAY_MS = 400;
/** How long live hub messages gather before one render handles them together. */
const SSE_BATCH_MS = 50;

/** Hub state and the recent cross-task event feed, kept live over SSE. */
export function useHub() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Map<string, TaskView>>(new Map());
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  // Only unanswered questions are kept, like approvals.
  const [questions, setQuestions] = useState<Map<string, Question>>(new Map());
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // Hub↔runner link; null until the first state arrives.
  const [runnerConnected, setRunnerConnected] = useState<boolean | null>(null);
  // Whether this browser runs on the hub's own machine (local links open only there).
  const [local, setLocal] = useState(true);
  const listeners = useRef(new Set<(e: HubEvent) => void>());
  // Counts state reloads (each SSE (re)connect): feed columns reload their newest page with it.
  const [synced, setSynced] = useState(0);

  const refresh = useCallback(async () => {
    const [s, feed] = await Promise.all([api.state(), api.feed()]);
    setEvents((prev) => mergeEvents(prev, feed, FEED_CAP));
    assignProjectColors(s.projects);
    setProjects(s.projects);
    setTasks(new Map(s.tasks.map((t) => [t.id, t])));
    setApprovals(new Map(s.approvals.map((a) => [a.id, a])));
    setQuestions(new Map((s.questions ?? []).filter((q) => q.status === 'pending').map((q) => [q.id, q])));
    if (s.runner) setRunnerConnected(s.runner.connected);
    if (s.client) setLocal(s.client.local);
    setSynced((n) => n + 1);
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => { setConnected(true); void refresh(); };
    es.onerror = () => setConnected(false);
    // Messages are handled in batches: each event also brings its task's update, and several busy
    // agents send many a second; one render per batch instead of one per message.
    let batch: HubMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const ms = batch;
      batch = [];
      const tasks = new Map<string, TaskView>();
      const events: HubEvent[] = [];
      for (const m of ms) {
        if (m.type === 'task') tasks.set(m.task.id, m.task);
        else if (m.type === 'approval') {
          setApprovals((prev) => {
            const next = new Map(prev);
            if (m.approval.status === 'pending') next.set(m.approval.id, m.approval);
            else next.delete(m.approval.id);
            return next;
          });
        } else if (m.type === 'question') {
          setQuestions((prev) => {
            const next = new Map(prev);
            if (m.question.status === 'pending') next.set(m.question.id, m.question);
            else next.delete(m.question.id);
            return next;
          });
        } else if (m.type === 'runner') {
          setRunnerConnected(m.connected);
        } else if (m.type === 'event') {
          events.push(m.event);
        }
      }
      if (tasks.size) setTasks((prev) => { const next = new Map(prev); for (const [id, t] of tasks) next.set(id, t); return next; });
      if (events.length) {
        setEvents((prev) => mergeEvents(prev, events, FEED_CAP));
        for (const e of events) listeners.current.forEach((fn) => fn(e));
      }
    };
    es.onmessage = (msg) => {
      batch.push(JSON.parse(msg.data) as HubMessage);
      timer ??= setTimeout(flush, SSE_BATCH_MS);
    };
    return () => { es.close(); clearTimeout(timer); };
  }, [refresh]);

  const onEvent = useCallback((fn: (e: HubEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  return { projects, tasks, approvals, questions, events, connected, runnerConnected, local, synced, refresh, onEvent };
}

/** The event kinds a post kind comes from (postKind in posts.ts). */
const EVENT_KINDS: Record<PostKind, EventKind[]> = {
  user: ['user'], assistant: ['assistant', 'update'], approval: ['approval'], question: ['question'], alert: ['status'],
};

/**
 * What the hub filters a column's events by. `members`, the tasks now in the statuses, is not sent:
 * it changes the query (and reloads the column) when a task moves in or out of them.
 */
function feedQuery(f: ColumnFilter, tasks: Map<string, TaskView>): FeedQuery {
  const members = f.statuses?.length ? [...tasks.values()].filter((t) => f.statuses!.includes(t.status)).map((t) => t.id).sort() : undefined;
  return {
    taskIds: f.taskIds?.length ? f.taskIds : undefined,
    projectIds: f.projectIds?.length ? f.projectIds : undefined,
    statuses: f.statuses?.length ? f.statuses : undefined,
    kinds: f.kinds?.length ? f.kinds.flatMap((k) => EVENT_KINDS[k]) : undefined,
    q: f.query?.trim() || undefined,
    members,
  };
}

/** Whether a live event can belong to a column (the rest is the posts' own filter, `matches`). */
function accepts(q: FeedQuery, e: HubEvent, task: TaskView | undefined): boolean {
  if (q.members && !q.members.includes(e.task_id)) return false;
  if (q.taskIds && !q.taskIds.includes(e.task_id)) return false;
  if (q.projectIds && (!task || !q.projectIds.includes(task.project_id))) return false;
  return !q.kinds || q.kinds.includes(e.kind);
}

export interface ColumnFeed { events: HubEvent[]; more: boolean; loading: boolean }

/**
 * Each feed column's events, filtered by the hub to what the column shows, newest page first and
 * older pages on request (`loadEarlier`), kept live. A column whose filter changes starts over.
 */
export function useColumnFeeds(defs: ColumnDef[], tasks: Map<string, TaskView>,
  onEvent: (fn: (e: HubEvent) => void) => () => void, synced: number) {
  const [feeds, setFeeds] = useState<Map<string, ColumnFeed & { key: string }>>(new Map());
  const queries = new Map(defs.map((d) => [d.id, feedQuery(d.filter, tasks)]));
  const sig = JSON.stringify([...queries]);
  const current = useRef({ queries, tasks });
  current.current = { queries, tasks };

  // The newest page of each column whose query changed, and of all after a reconnect.
  const fetched = useRef(new Map<string, string>());
  useEffect(() => {
    const want = new Map(JSON.parse(sig) as [string, FeedQuery][]);
    setFeeds((prev) => new Map([...prev].filter(([id]) => want.has(id))));
    for (const [id, q] of want) {
      const key = JSON.stringify(q);
      const at = `${key}@${synced}`;
      if (fetched.current.get(id) === at) continue;
      const fresh = !fetched.current.get(id)?.startsWith(`${key}@`);
      fetched.current.set(id, at);
      setFeeds((prev) => new Map(prev).set(id, fresh || !prev.has(id)
        ? { key, events: [], more: false, loading: true } : { ...prev.get(id)!, loading: true }));
      api.feed(FEED_PAGE, undefined, q).then((page) => setFeeds((prev) => {
        const cur = prev.get(id);
        if (!cur || cur.key !== key) return prev;
        // A reload after a reconnect keeps the older pages already shown.
        const keepsOlder = cur.events.length > 0 && page.length > 0 && cur.events[0].id < page[0].id;
        return new Map(prev).set(id, { key, events: mergeEvents(cur.events, page), more: keepsOlder ? cur.more : page.length >= FEED_PAGE, loading: false });
      })).catch(() => setFeeds((prev) => {
        const cur = prev.get(id);
        return cur?.key === key ? new Map(prev).set(id, { ...cur, loading: false }) : prev;
      }));
    }
    for (const id of fetched.current.keys()) if (!want.has(id)) fetched.current.delete(id);
  }, [sig, synced]);

  useEffect(() => onEvent((e) => {
    const { queries, tasks } = current.current;
    setFeeds((prev) => {
      let next: typeof prev | null = null;
      for (const [id, q] of queries) {
        const cur = prev.get(id);
        if (!cur || cur.key !== JSON.stringify(q) || !accepts(q, e, tasks.get(e.task_id))) continue;
        next ??= new Map(prev);
        next.set(id, { ...cur, events: mergeEvents(cur.events, [e]) });
      }
      return next ?? prev;
    });
  }), [onEvent]);

  const loadEarlier = useCallback((id: string) => {
    const cur = feeds.get(id);
    const q = current.current.queries.get(id);
    const oldest = cur?.events[0]?.id;
    if (!cur || !q || !oldest || !cur.more || cur.loading) return;
    setFeeds((prev) => (prev.get(id)?.key === cur.key ? new Map(prev).set(id, { ...prev.get(id)!, loading: true }) : prev));
    const done = (page: HubEvent[] | null) => setFeeds((prev) => {
      const now = prev.get(id);
      if (now?.key !== cur.key) return prev;
      return new Map(prev).set(id, page
        ? { ...now, events: mergeEvents(page, now.events), more: page.length >= FEED_PAGE, loading: false }
        : { ...now, loading: false });
    });
    api.feed(FEED_PAGE, oldest, q).then(done, () => done(null));
  }, [feeds]);

  return { feeds: feeds as Map<string, ColumnFeed>, loadEarlier };
}

/** Full event history of one task (the feed only keeps recent events), kept live. */
/**
 * A task's history: its newest events, and every event from `since` on (a thread opened at an older
 * post). `loaded`: the history has arrived; live events alone may show up before it. `more`: older
 * events exist before the shown ones; `loadEarlier` adds the next page of them.
 */
export function useTaskEvents(taskId: string | null, onEvent: (fn: (e: HubEvent) => void) => () => void, since?: number) {
  const [{ events, more }, setHistory] = useState<{ events: HubEvent[]; more: boolean }>({ events: [], more: false });
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const shown = useRef<string | null>(null);
  /** Bumped on every (re)load, so an earlier page asked for meanwhile is dropped. */
  const gen = useRef(0);
  useEffect(() => {
    // Another task starts empty; the same task reopened at another post keeps what it shows meanwhile.
    if (shown.current !== taskId) setHistory({ events: [], more: false });
    shown.current = taskId;
    setLoaded(null);
    setLoadingEarlier(false);
    gen.current++;
    if (!taskId) return;
    let alive = true;
    const key = `${taskId}:${since ?? ''}`;
    api.events(taskId, { since }).then((page) => {
      if (!alive) return;
      // Older events kept from before (pages loaded earlier) keep their own `more`.
      setHistory((prev) => ({
        events: mergeEvents(page.events, prev.events),
        more: prev.events.length && page.events.length && prev.events[0].id < page.events[0].id ? prev.more : page.more,
      }));
      setLoaded(key);
    }).catch(() => { if (alive) setLoaded(key); });
    // Live events come cut like the feed's; the thread fetches the cut ones whole, a few at a time.
    const cut = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchWhole = () => {
      timer = undefined;
      const ids = [...cut];
      cut.clear();
      api.events(taskId, { ids }).then((page) => {
        if (alive) setHistory((prev) => ({ ...prev, events: mergeEvents(prev.events, page.events) }));
      }).catch(() => {});
    };
    const off = onEvent((e) => {
      if (e.task_id !== taskId) return;
      setHistory((prev) => ({ ...prev, events: mergeEvents(prev.events, [e]) }));
      if (e.payload?.clipped) {
        cut.add(e.id);
        timer ??= setTimeout(fetchWhole, WHOLE_DELAY_MS);
      }
    });
    return () => { alive = false; off(); clearTimeout(timer); gen.current++; };
  }, [taskId, since, onEvent]);
  const loadEarlier = useCallback(() => {
    const oldest = events[0];
    if (!taskId || !more || !oldest || loadingEarlier) return;
    const g = gen.current;
    setLoadingEarlier(true);
    api.events(taskId, { before: oldest.id }).then((page) => {
      if (gen.current !== g) return;
      setHistory((prev) => ({ events: mergeEvents(page.events, prev.events), more: page.more }));
    }).catch(() => {}).finally(() => { if (gen.current === g) setLoadingEarlier(false); });
  }, [taskId, events, more, loadingEarlier]);
  return { events, more, loadingEarlier, loadEarlier, loaded: taskId != null && loaded === `${taskId}:${since ?? ''}` };
}
