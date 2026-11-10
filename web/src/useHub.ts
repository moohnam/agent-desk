import { apiBase } from './workspace.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, FEED_PAGE, type FeedQuery } from './api.ts';
import { mergeEvents } from './posts.ts';
import { assignProjectColors } from './projects.ts';
import type { Approval, Channel, ChannelEntry, ColumnDef, ColumnFilter, EventKind, HubEvent, HubMessage, PostKind, Project, Question, TaskView } from './types.ts';
import type { AccessView } from '../../shared/api.ts';

const FEED_CAP = 3000;
/** How long an open thread gathers cut live events before fetching them whole. */
const WHOLE_DELAY_MS = 400;
/** How long live hub messages gather before one render handles them together. */
const SSE_BATCH_MS = 50;

/** Hub state and the recent cross-task event feed, kept live over SSE. */
export function useHub() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [channels, setChannels] = useState<Map<string, Channel>>(new Map());
  const channelListeners = useRef(new Set<(entry: ChannelEntry) => void>());
  const channelRefresh = useRef<Map<string, Channel | null> | null>(null);
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
  // Devices asking to connect and devices let in: on this Mac's pages only.
  const [access, setAccess] = useState<AccessView | null>(null);
  const listeners = useRef(new Set<(e: HubEvent) => void>());
  // Counts state reloads (each SSE (re)connect): feed columns reload their newest page with it.
  const [synced, setSynced] = useState(0);
  // Tasks deleted while this page is open: their events, wherever cached, are no longer shown.
  const [gone, setGone] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const channelUpdates = new Map<string, Channel | null>();
    channelRefresh.current = channelUpdates;
    try {
    const [s, feed] = await Promise.all([api.state(), api.feed()]);
    setEvents((prev) => mergeEvents(prev, feed, FEED_CAP));
    assignProjectColors(s.projects);
    setProjects(s.projects);
    if (channelRefresh.current === channelUpdates) {
      const next = new Map((s.channels ?? []).map((channel) => [channel.id, channel]));
      for (const [id, channel] of channelUpdates) { if (channel) next.set(id, channel); else next.delete(id); }
      setChannels(next);
    }
    setTasks(new Map(s.tasks.map((t) => [t.id, t])));
    setApprovals(new Map(s.approvals.map((a) => [a.id, a])));
    setQuestions(new Map((s.questions ?? []).filter((q) => q.status === 'pending').map((q) => [q.id, q])));
    if (s.runner) setRunnerConnected(s.runner.connected);
    if (s.client) setLocal(s.client.local);
    setAccess(s.access ?? null);
    setSynced((n) => n + 1);
    } finally { if (channelRefresh.current === channelUpdates) channelRefresh.current = null; }
  }, []);

  useEffect(() => {
    const es = new EventSource(`${apiBase}/stream`);
    es.onopen = () => { setConnected(true); void refresh(); };
    es.onerror = () => {
      setConnected(false);
      // This device was cut off on the Mac: the page asks to connect again.
      fetch('/api/state', { method: 'HEAD' }).then((r) => { if (r.status === 401) location.reload(); }, () => {});
    };
    // Messages are handled in batches: each event also brings its task's update, and several busy
    // agents send many a second; one render per batch instead of one per message.
    let batch: HubMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const ms = batch;
      batch = [];
      const tasks = new Map<string, TaskView>();
      const runnerUpdates = new Map<string, boolean>();
      const events: HubEvent[] = [];
      const channelEntries: ChannelEntry[] = [];
      for (const m of ms) {
        if (m.type === 'channel') { channelRefresh.current?.set(m.channel.id, m.channel); setChannels((prev) => new Map(prev).set(m.channel.id, m.channel)); }
        else if (m.type === 'channel_entry') channelEntries.push(m.entry);
        else if (m.type === 'channel_removed') { channelRefresh.current?.set(m.channel_id, null); setChannels((prev) => { const next = new Map(prev); next.delete(m.channel_id); return next; }); }
        else if (m.type === 'task') tasks.set(m.task.id, m.task);
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
        } else if (m.type === 'access') {
          setAccess({ requests: m.requests, devices: m.devices });
        } else if (m.type === 'runners') {
          for (const r of m.runners) runnerUpdates.set(r.id, r.connected);
        } else if (m.type === 'runner') {
          setRunnerConnected(m.connected);
        } else if (m.type === 'event') {
          events.push(m.event);
        } else if (m.type === 'removed') {
          const ids = new Set(m.taskIds);
          const keep = <T extends { task_id: string }>(prev: Map<string, T>) => new Map([...prev].filter(([, x]) => !ids.has(x.task_id)));
          setGone((prev) => new Set([...prev, ...ids]));
          setTasks((prev) => new Map([...prev].filter(([id]) => !ids.has(id))));
          setProjects((prev) => prev.filter((p) => !m.projectIds.includes(p.id)));
          setApprovals(keep);
          setQuestions(keep);
          setEvents((prev) => prev.filter((e) => !ids.has(e.task_id)));
          // Columns load their newest page and counts again.
          setSynced((n) => n + 1);
        }
      }
      // A task's update can come in the same batch as its deletion.
      for (const m of ms) if (m.type === 'removed') for (const id of m.taskIds) tasks.delete(id);
      if (tasks.size || runnerUpdates.size) setTasks(prev => {
        const next = new Map(prev);
        for (const [id, task] of tasks) next.set(id, task);
        if (runnerUpdates.size) for (const [id, task] of next) {
          const connected = task.runner_id ? runnerUpdates.get(task.runner_id) : undefined;
          if (connected !== undefined && connected !== task.runner_connected) next.set(id, { ...task, runner_connected: connected });
        }
        return next;
      });
      if (events.length) {
        setEvents((prev) => mergeEvents(prev, events, FEED_CAP));
        for (const e of events) listeners.current.forEach((fn) => fn(e));
      }
      for (const entry of channelEntries) channelListeners.current.forEach((fn) => fn(entry));
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

  const onChannelEntry = useCallback((fn: (entry: ChannelEntry) => void) => {
    channelListeners.current.add(fn);
    return () => { channelListeners.current.delete(fn); };
  }, []);
  return { projects, channels, onChannelEntry, tasks, approvals, questions, events, connected, runnerConnected, local, access, synced, gone, refresh, onEvent };
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

/** `total`: the column's posts in the hub's database, and their tasks; unknown until counted. */
export interface ColumnFeed { events: HubEvent[]; more: boolean; loading: boolean; total?: { posts: number; tasks: number } }

/** A query's total is counted again at most this often (ms) while its events arrive. */
const COUNT_EVERY = 3000;


/**
 * A query's events. `live`: a shown column uses it, so live events reach it; one that was hidden
 * missed some and fetches its newest page again when shown. `at`: the state reload (`synced`) its
 * newest page is from.
 */
interface FeedEntry extends ColumnFeed { q: FeedQuery; at: number; live: boolean }

/**
 * Each feed column's events, filtered by the hub to what the column shows, newest page first and
 * older pages on request (`loadEarlier`), kept live. Events are kept per query, not per column:
 * a view switch shows the queries it had at once and only fetches their newest page quietly.
 * `kept`: the columns of every view (F1–F4); a hidden query is dropped, with the older pages
 * loaded for it, only once none of them uses it (a deleted column, a changed filter).
 */
export function useColumnFeeds(defs: ColumnDef[], kept: () => ColumnDef[], tasks: Map<string, TaskView>,
  onEvent: (fn: (e: HubEvent) => void) => () => void, synced: number, gone: Set<string> = new Set()) {
  const cache = useRef(new Map<string, FeedEntry>());
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const queries = new Map(defs.filter((d) => !d.channelId).map((d) => [d.id, feedQuery(d.filter, tasks)]));
  const sig = JSON.stringify([...queries]);
  const current = useRef({ tasks, kept });
  current.current = { tasks, kept };
  // The query each column showed last: a column whose query changes starts from those events.
  const shown = useRef(new Map<string, string>());

  const set = (key: string, f: (e: FeedEntry) => FeedEntry) => {
    const e = cache.current.get(key);
    if (e) { cache.current.set(key, f(e)); bump(); }
  };
  // Counts waiting to be fetched, by query key.
  const counting = useRef(new Map<string, number>());
  const count = (key: string, delay = 0) => {
    if (counting.current.has(key)) return;
    counting.current.set(key, window.setTimeout(() => {
      counting.current.delete(key);
      const e = cache.current.get(key);
      // A hub not yet restarted has no count: the column shows only what it loaded.
      if (e) api.feedCount(e.q).then((total) => set(key, (x) => ({ ...x, total })), () => {});
    }, delay));
  };
  useEffect(() => () => { for (const t of counting.current.values()) clearTimeout(t); }, []);

  useEffect(() => {
    const want = JSON.parse(sig) as [string, FeedQuery][];
    const keys = new Set(want.map(([, q]) => JSON.stringify(q)));
    const c = cache.current;
    for (const [k, e] of c) if (e.live && !keys.has(k)) c.set(k, { ...e, live: false });
    for (const [id, q] of want) {
      const key = JSON.stringify(q);
      const cur = c.get(key);
      const prev = shown.current.get(id);
      shown.current.set(id, key);
      if (cur?.live && cur.at === synced) continue;
      if (cur) c.set(key, { ...cur, live: true });
      else {
        // Narrowed to the new query, the column's events stay up while the page comes.
        const seed = prev ? c.get(prev)?.events.filter((e) => accepts(q, e, current.current.tasks.get(e.task_id))) ?? [] : [];
        c.set(key, { q, events: seed, more: false, loading: true, at: synced, live: true });
      }
      c.set(key, { ...c.get(key)!, at: synced });
      count(key);
      api.feed(FEED_PAGE, undefined, q).then((page) => set(key, (e) => {
        // A reload after a reconnect or a view switch keeps the older pages already shown.
        const keepsOlder = e.events.length > 0 && page.length > 0 && e.events[0].id < page[0].id;
        return { ...e, events: mergeEvents(e.events, page), more: keepsOlder ? e.more : page.length >= FEED_PAGE, loading: false };
      }), () => set(key, (e) => ({ ...e, loading: false })));
    }
    for (const id of shown.current.keys()) if (!want.some(([w]) => w === id)) shown.current.delete(id);
    const used = new Set(current.current.kept().filter((d) => !d.channelId).map((d) => JSON.stringify(feedQuery(d.filter, current.current.tasks))));
    for (const [k, e] of c) if (!e.live && !used.has(k)) c.delete(k);
    bump();
  }, [sig, synced]);

  useEffect(() => onEvent((e) => {
    const task = current.current.tasks.get(e.task_id);
    let any = false;
    for (const [k, f] of cache.current) {
      if (!f.live || !accepts(f.q, e, task)) continue;
      cache.current.set(k, { ...f, events: mergeEvents(f.events, [e]) });
      count(k, COUNT_EVERY);
      any = true;
    }
    if (any) bump();
  }), [onEvent]);

  // Events without the deleted tasks', the same array while neither changes: posts are built per array.
  const withoutGone = useRef(new WeakMap<HubEvent[], { gone: Set<string>; events: HubEvent[] }>());
  const feeds = useMemo(() => {
    const out = new Map<string, ColumnFeed>();
    for (const [id, q] of JSON.parse(sig) as [string, FeedQuery][]) {
      const e = cache.current.get(JSON.stringify(q));
      if (!e) continue;
      if (!gone.size) { out.set(id, e); continue; }
      let k = withoutGone.current.get(e.events);
      if (k?.gone !== gone) withoutGone.current.set(e.events, k = { gone, events: e.events.filter((x) => !gone.has(x.task_id)) });
      out.set(id, { ...e, events: k.events });
    }
    return out;
  }, [sig, version, gone]);

  const loadEarlier = useCallback((id: string) => {
    const key = shown.current.get(id);
    const cur = key ? cache.current.get(key) : undefined;
    const oldest = cur?.events[0]?.id;
    if (!key || !cur || !oldest || !cur.more || cur.loading) return;
    set(key, (e) => ({ ...e, loading: true }));
    api.feed(FEED_PAGE, oldest, cur.q).then(
      (page) => set(key, (e) => ({ ...e, events: mergeEvents(e.events, page), more: page.length >= FEED_PAGE, loading: false })),
      () => set(key, (e) => ({ ...e, loading: false })));
  }, []);

  return { feeds, loadEarlier };
}

/** Full event history of one task (the feed only keeps recent events), kept live. */
/**
 * A task's history: its newest events, and every event from `since` on (a thread opened at an older
 * post). `loaded`: the history has arrived; live events alone may show up before it. `more`: older
 * events exist before the shown ones; `loadEarlier` adds the next page of them.
 */
export function useTaskEvents(taskId: string | null, onEvent: (fn: (e: HubEvent) => void) => () => void, since?: number, reload = 0) {
  const [{ events, more }, setHistory] = useState<{ events: HubEvent[]; more: boolean }>({ events: [], more: false });
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierRequest = useRef(false);
  const shown = useRef<string | null>(null);
  /** Bumped on every (re)load, so an earlier page asked for meanwhile is dropped. */
  const gen = useRef(0);
  useEffect(() => {
    // Another task starts empty; the same task reopened at another post keeps what it shows meanwhile.
    if (shown.current !== taskId) setHistory({ events: [], more: false });
    shown.current = taskId;
    setLoaded(null);
    setLoadingEarlier(false);
    earlierRequest.current = false;
    gen.current++;
    if (!taskId) return;
    let alive = true;
    const key = `${taskId}:${since ?? ''}`;
    api.events(taskId, { since }).then((page) => {
      if (!alive) return;
      // Older events kept from before (pages loaded earlier) keep their own `more`.
      setHistory((prev) => ({
        events: mergeEvents(prev.events, page.events),
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
  }, [taskId, since, onEvent, reload]);
  const loadEarlier = useCallback(() => {
    const oldest = events[0];
    if (!taskId || !more || !oldest || earlierRequest.current) return;
    const g = gen.current;
    earlierRequest.current = true;
    setLoadingEarlier(true);
    api.events(taskId, { before: oldest.id }).then((page) => {
      if (gen.current !== g) return;
      setHistory((prev) => ({ events: mergeEvents(prev.events, page.events), more: page.more }));
    }).catch(() => {}).finally(() => {
      if (gen.current === g) { earlierRequest.current = false; setLoadingEarlier(false); }
    });
  }, [taskId, events, more, loadingEarlier]);
  return { events, more, loadingEarlier, loadEarlier, loaded: taskId != null && loaded === `${taskId}:${since ?? ''}` };
}
