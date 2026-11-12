import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, FEED_PAGE, type FeedQuery } from './api.ts';
import { compareEvents, discoverSources, getSources, mapMessage, sourceBase, sourceConnected, splitId, subscribeSources } from './federation.ts';
import { mergeEvents, mergeTaskEvents } from './posts.ts';
import { assignProjectColors, forgetProjectColors } from './projects.ts';
import { compactFeed, IDLE_FEED_LIMIT, IDLE_QUERY_LIMIT, LIVE_FEED_LIMIT } from './feedCache.ts';
import { confirmedMissingTask } from './draftRetention.ts';
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
  const currentProjects=useRef(projects);currentProjects.current=projects;
  const [channels, setChannels] = useState<Map<string, Channel>>(new Map());
  const channelListeners = useRef(new Set<(entry: ChannelEntry) => void>());
  const channelRefresh = useRef<Map<string, Channel | null> | null>(null);
  const [tasks, setTasks] = useState<Map<string, TaskView>>(new Map());
  const currentTasks=useRef(tasks);
  const commitTasks = useCallback((change: (prev: Map<string, TaskView>) => Map<string, TaskView>) => {
    const next = change(currentTasks.current);
    if (next !== currentTasks.current) {
      currentTasks.current = next;
      setTasks(next);
    }
  }, []);
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
  const listeners = useRef(new Set<(e: HubEvent, task?: TaskView) => void>());
  // Counts state reloads (each SSE (re)connect): feed columns reload their newest page with it.
  const [synced, setSynced] = useState(0);
  // Tasks deleted while this page is open: their events, wherever cached, are no longer shown.
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [availableSources, setAvailableSources] = useState<Set<string>>(new Set());
  const deleted = useRef(new Set<string>());
  const deletedProjects = useRef(new Set<string>());
  const knownTasks = useRef(new Set<string>());
  const taskRefresh = useRef<Map<string, TaskView | null> | null>(null);
  const updateTaskTitle = useCallback((taskId: string, title: string, revision: number) => {
    if (deleted.current.has(taskId)) return;
    const current = currentTasks.current.get(taskId);
    if (!current || (current.title_revision ?? 0) > revision) return;
    if (current.title === title && current.title_revision === revision) return;
    const updated = { ...current, title, title_revision: revision };
    api.remember(splitId(taskId)[0], { type: 'task', task: updated });
    taskRefresh.current?.set(taskId, updated);
    commitTasks(prev => new Map(prev).set(taskId, updated));
  }, [commitTasks]);

  const approvalRefresh=useRef<Map<string,Approval>|null>(null);
  const questionRefresh=useRef<Map<string,Question>|null>(null);
  const refresh = useCallback(async () => {
    const channelUpdates = new Map<string, Channel | null>();
    const taskUpdates = new Map<string, TaskView | null>();
    const approvalUpdates=new Map<string,Approval>(),questionUpdates=new Map<string,Question>();
    approvalRefresh.current=approvalUpdates;questionRefresh.current=questionUpdates;
    channelRefresh.current = channelUpdates;
    taskRefresh.current = taskUpdates;
    try {
    const s = await api.state();
    const feed = await api.feed();
    if (channelRefresh.current !== channelUpdates) return;
    const nextTasks = new Map(s.tasks.filter(t => !deleted.current.has(t.id)).map(t => [t.id, t]));
    for(const [id,task] of currentTasks.current) {
      if(s.unavailableSources?.includes(splitId(id)[0])&&!nextTasks.has(id)&&!deleted.current.has(id))nextTasks.set(id,{...task,runner_connected:false});
    }
    // SSE can add/update/delete tasks while the full snapshot is in flight.
    for (const [id, task] of taskUpdates) { if (task && !deleted.current.has(id)) nextTasks.set(id, task); else nextTasks.delete(id); }
    // A plain ID missing after a snapshot may be an old remote task awaiting its new link.
    // Only a successful read of an identified source proves a scoped task was deleted.
    const available = new Set(s.availableSources ?? []);
    const missing = [...knownTasks.current].filter(id => confirmedMissingTask(id,nextTasks.has(id),available));
    if (missing.length) {
      deleted.current = new Set([...deleted.current, ...missing]);
      setGone(deleted.current);
    }
    knownTasks.current = new Set(nextTasks.keys());
    setEvents((prev) => mergeEvents(prev.filter(e => !deleted.current.has(e.task_id)), feed.filter(e => !deleted.current.has(e.task_id)), FEED_CAP));
    const nextProjects = s.projects.filter(p => !deletedProjects.current.has(p.id));
    assignProjectColors(nextProjects);
    setProjects(nextProjects);
    if (channelRefresh.current === channelUpdates) {
      const next = new Map((s.channels ?? []).map((channel) => [channel.id, channel]));
      for (const [id, channel] of channelUpdates) { if (channel) next.set(id, channel); else next.delete(id); }
      setChannels(next);
    }
    commitTasks(() => nextTasks);
    setAvailableSources(new Set(s.availableSources ?? []));
    const allApprovals=new Map(s.approvals.map(a=>[a.id,a]));for(const [id,a] of approvalUpdates)allApprovals.set(id,a);
    setApprovals(new Map([...allApprovals].filter(([,a])=>a.status==='pending'&&!deleted.current.has(a.task_id))));
    const allQuestions=new Map((s.questions??[]).map(q=>[q.id,q]));for(const [id,q] of questionUpdates)allQuestions.set(id,q);
    setQuestions(new Map([...allQuestions].filter(([,q])=>q.status==='pending'&&!deleted.current.has(q.task_id))));
    if (s.runner) setRunnerConnected(s.runner.connected);
    if (s.client) setLocal(s.client.local);
    setAccess(s.access ?? null);
    setSynced((n) => n + 1);
    } finally {
      if (channelRefresh.current === channelUpdates) channelRefresh.current = null;
      if (taskRefresh.current === taskUpdates) taskRefresh.current = null;
      if(approvalRefresh.current===approvalUpdates)approvalRefresh.current=null;
      if(questionRefresh.current===questionUpdates)questionRefresh.current=null;
    }
  }, [commitTasks]);

  useEffect(() => {
    // Messages are handled in batches: each event also brings its task's update, and several busy
    // agents send many a second; one render per batch instead of one per message.
    let batch: HubMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let projectTimer:ReturnType<typeof setTimeout>|undefined;
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
        else if (m.type === 'task') { tasks.set(m.task.id, m.task); taskRefresh.current?.set(m.task.id, m.task); }
        else if (m.type === 'approval') {
          approvalRefresh.current?.set(m.approval.id,m.approval);
          setApprovals((prev) => {
            const next = new Map(prev);
            if (m.approval.status === 'pending' && !deleted.current.has(m.approval.task_id)) next.set(m.approval.id, m.approval);
            else next.delete(m.approval.id);
            return next;
          });
        } else if (m.type === 'question') {
          questionRefresh.current?.set(m.question.id,m.question);
          setQuestions((prev) => {
            const next = new Map(prev);
            if (m.question.status === 'pending' && !deleted.current.has(m.question.task_id)) next.set(m.question.id, m.question);
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
          for (const id of m.projectIds) deletedProjects.current.add(id);
          forgetProjectColors(m.projectIds);
          const ids = new Set(m.taskIds);
          const keep = <T extends { task_id: string }>(prev: Map<string, T>) => new Map([...prev].filter(([, x]) => !ids.has(x.task_id)));
          deleted.current = new Set([...deleted.current, ...ids]);
          for (const id of ids) { knownTasks.current.delete(id); taskRefresh.current?.set(id, null); }
          setGone(deleted.current);
          commitTasks((prev) => new Map([...prev].filter(([id]) => !ids.has(id))));
          setProjects((prev) => prev.filter((p) => !m.projectIds.includes(p.id)));
          setApprovals(keep);
          setQuestions(keep);
          setEvents((prev) => prev.filter((e) => !ids.has(e.task_id)));
          // Columns load their newest page and counts again.
          setSynced((n) => n + 1);
        }
      }
      if(!projectTimer&&[...tasks.values()].some(t=>!currentProjects.current.some(p=>p.id===t.project_id))) {
        projectTimer=setTimeout(()=>{projectTimer=undefined;void refresh().catch(()=>{});},200);
      }
      // A task's update can come in the same batch as its deletion.
      for (const id of tasks.keys()) if (deleted.current.has(id)) tasks.delete(id);
      for (const id of tasks.keys()) knownTasks.current.add(id);
      if (tasks.size || runnerUpdates.size) commitTasks(prev => {
        const next = new Map(prev);
        for (const [id, task] of tasks) next.set(id, task);
        if (runnerUpdates.size) for (const [id, task] of next) {
          const connected = task.runner_id ? runnerUpdates.get(task.runner_id) : undefined;
          if (connected !== undefined && connected !== task.runner_connected) next.set(id, { ...task, runner_connected: connected });
        }
        return next;
      });
      const liveEvents = events.filter(e => !deleted.current.has(e.task_id));
      if (liveEvents.length) {
        setEvents((prev) => mergeEvents(prev, liveEvents, FEED_CAP));
        for (const e of liveEvents) listeners.current.forEach((fn) => fn(e, currentTasks.current.get(e.task_id)));
      }
      for (const entry of channelEntries) channelListeners.current.forEach((fn) => fn(entry));
    };
    const streams=new Map<string,EventSource>();
    const update=()=>{
      const sources=[{id:'',view_index:0},...getSources()];
      for(const [id,stream] of streams)if(!sources.some(s=>s.id===id)){stream.close();streams.delete(id);void refresh().catch(()=>{});}
      for(const source of sources) {
        if(streams.has(source.id))continue;
        const es=new EventSource(sourceBase(source.id)+'/stream');streams.set(source.id,es);
        es.onopen=()=>{if(!source.id)setConnected(true);else sourceConnected(source.id,true);void refresh().catch(()=>{});};
        es.onerror=()=>{
          if(source.id){sourceConnected(source.id,false);commitTasks(prev=>new Map([...prev].map(([id,t])=>[id,id.startsWith(`w:${source.id}:`)?{...t,runner_connected:false}:t])));}
          else {setConnected(false);fetch('/api/state',{method:'HEAD'}).then(r=>{if(r.status===401)location.reload();},()=>{});}
        };
        es.onmessage=msg=>{
          const mapped=mapMessage(source.id,source.view_index,JSON.parse(msg.data));
          if(mapped){api.remember(source.id,mapped);batch.push(mapped);timer??=setTimeout(flush,SSE_BATCH_MS);}
        };
      }
    };
    const unsubscribe=subscribeSources(update);
    update();
    const poll=setInterval(()=>{void discoverSources(true).catch(()=>{});},5000);
    void discoverSources(true).then(update,()=>{});
    return()=>{unsubscribe();clearInterval(poll);for(const es of streams.values())es.close();clearTimeout(timer);clearTimeout(projectTimer);};
  }, [refresh, commitTasks]);

  const onEvent = useCallback((fn: (e: HubEvent, task?: TaskView) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const onChannelEntry = useCallback((fn: (entry: ChannelEntry) => void) => {
    channelListeners.current.add(fn);
    return () => { channelListeners.current.delete(fn); };
  }, []);
  return { projects, channels, onChannelEntry, tasks, updateTaskTitle, approvals, questions, events, connected, runnerConnected, local, access, synced, gone, availableSources, refresh, onEvent };
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
    taskIds: f.taskIds,
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
interface FeedEntry extends ColumnFeed { q: FeedQuery; at: number; live: boolean; token: object; olderCursor?: HubEvent }

/**
 * Each feed column's events, filtered by the hub to what the column shows, newest page first and
 * older pages on request (`loadEarlier`), kept live. Events are kept per query, not per column:
 * a view switch shows the queries it had at once and only fetches their newest page quietly.
 * Hidden queries keep a bounded recent-page LRU. A shown column being read keeps its older
 * pages until it returns to the top; trimmed records can always be paged from the hub again.
 */
export function useColumnFeeds(defs: ColumnDef[], kept: () => ColumnDef[], tasks: Map<string, TaskView>,
  onEvent: (fn: (e: HubEvent, task?: TaskView) => void) => () => void, synced: number, gone: Set<string> = new Set()) {
  const cache = useRef(new Map<string, FeedEntry>());
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const queries = new Map(defs.filter((d) => !d.channelId).map((d) => [d.id, feedQuery(d.filter, tasks)]));
  const sig = JSON.stringify([...queries]);
  const current = useRef({ tasks, kept, gone });
  current.current = { tasks, kept, gone };
  // The query each column showed last: a column whose query changes starts from those events.
  const shown = useRef(new Map<string, string>());
  const reading = useRef(new Set<string>());
  const requests = useRef(new Map<string, Set<AbortController>>());
  const retries = useRef(new Map<string, number>());
  const retryAttempts = useRef(new Map<string, number>());
  const protectedQuery = (key: string) => [...reading.current].some(id => shown.current.get(id) === key);

  const set = (key: string, f: (e: FeedEntry) => FeedEntry) => {
    const e = cache.current.get(key);
    if (e) {
      cache.current.set(key, compactFeed(f(e), e.live ? protectedQuery(key) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT, current.current.gone));
      bump();
    }
  };
  const request = <T,>(key: string, load: (signal: AbortSignal) => Promise<T>, done: (value: T) => void, failed: () => void = () => {}) => {
    const token = cache.current.get(key)?.token;
    if (!token) return;
    const controller = new AbortController();
    let pending = requests.current.get(key);
    if (!pending) requests.current.set(key, pending = new Set());
    pending.add(controller);
    const group = pending;
    const currentRequest = () => !controller.signal.aborted && cache.current.get(key)?.token === token;
    void load(controller.signal).then(value => { if (currentRequest()) done(value); }, () => { if (currentRequest()) failed(); })
      .finally(() => { group.delete(controller); if (!group.size && requests.current.get(key) === group) requests.current.delete(key); });
  };
  // Counts waiting to be fetched, by query key.
  const counting = useRef(new Map<string, number>());
  const count = (key: string, delay = 0) => {
    if (counting.current.has(key)) return;
    counting.current.set(key, window.setTimeout(() => {
      counting.current.delete(key);
      const e = cache.current.get(key);
      // A hub not yet restarted has no count: the column shows only what it loaded.
      if (e) request(key, signal => api.feedCount(e.q, signal), total => set(key, x => ({ ...x, total })));
    }, delay));
  };
  const cancelRetry = (key: string) => {
    const timer = retries.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    retries.current.delete(key);
    retryAttempts.current.delete(key);
  };
  const abortRequests = (key: string) => {
    for (const controller of requests.current.get(key) ?? []) controller.abort();
    requests.current.delete(key);
  };
  const loadNewest = (key: string, epoch: number) => {
    const entry = cache.current.get(key);
    if (!entry) return;
    const token = entry.token;
    set(key, e => ({ ...e, loading: true }));
    const retry = () => {
      if (retries.current.has(key)) return;
      const attempt = (retryAttempts.current.get(key) ?? 0) + 1;
      retryAttempts.current.set(key, attempt);
      retries.current.set(key, window.setTimeout(() => {
        retries.current.delete(key);
        const latest = cache.current.get(key);
        if (latest?.live && latest.token === token && latest.at !== epoch) loadNewest(key, epoch);
      }, Math.min(1000 * 2 ** (attempt - 1), 10000)));
    };
    request(key, signal => api.feedPage(FEED_PAGE, undefined, entry.q, signal), page => {
      set(key, e => {
        // Keep every readable source's posts while an unavailable source catches up.
        return { ...e, events: mergeEvents(e.events, page.events),
          more: page.complete ? page.events.length >= FEED_PAGE : e.more,
          olderCursor: page.complete ? page.events[0] : e.olderCursor,
          loading: false, at: page.complete ? epoch : e.at };
      });
      if (page.complete) cancelRetry(key);
      else retry();
    }, () => { set(key, e => ({ ...e, loading: false })); retry(); });
  };
  const drop = (key: string) => {
    cache.current.delete(key);
    cancelRetry(key);
    clearTimeout(counting.current.get(key)); counting.current.delete(key);
    abortRequests(key);
  };
  useEffect(() => () => {
    for (const t of counting.current.values()) clearTimeout(t);
    counting.current.clear();
    for (const t of retries.current.values()) clearTimeout(t);
    retries.current.clear(); retryAttempts.current.clear();
    for (const pending of requests.current.values()) for (const controller of pending) controller.abort();
    requests.current.clear();
    // The StrictMode remount must reload requests cancelled by cleanup.
    cache.current.clear(); shown.current.clear(); reading.current.clear();
  }, []);

  useEffect(() => {
    const want = JSON.parse(sig) as [string, FeedQuery][];
    const keys = new Set(want.map(([, q]) => JSON.stringify(q)));
    const c = cache.current;
    for (const [k, e] of c) if (e.live && !keys.has(k)) {
      cancelRetry(k); abortRequests(k);
      c.set(k, { ...e, live: false, token: {} });
    }
    const started = new Set<string>();
    for (const [id, q] of want) {
      const key = JSON.stringify(q);
      const cur = c.get(key);
      const prev = shown.current.get(id);
      if (prev !== key) reading.current.delete(id);
      shown.current.set(id, key);
      if (started.has(key)) continue;
      started.add(key);
      if (cur?.live && cur.at === synced) continue;
      cancelRetry(key); abortRequests(key);
      if (cur) { c.delete(key); c.set(key, { ...cur, live: true, token: {} }); }
      else {
        // Narrowed to the new query, the column's events stay up while the page comes.
        const seed = prev ? c.get(prev)?.events.filter((e) => accepts(q, e, current.current.tasks.get(e.task_id))) ?? [] : [];
        c.set(key, { q, events: seed, more: false, loading: true, at: -1, live: true, token: {} });
      }
      count(key);
      loadNewest(key, synced);
    }
    for (const id of shown.current.keys()) if (!want.some(([w]) => w === id)) { shown.current.delete(id); reading.current.delete(id); }
    const used = new Set(current.current.kept().filter((d) => !d.channelId).map((d) => JSON.stringify(feedQuery(d.filter, current.current.tasks))));
    for (const [k, e] of c) {
      if (!e.live && !used.has(k)) drop(k);
      else c.set(k, compactFeed(e, e.live ? protectedQuery(k) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT, current.current.gone));
    }
    const idle = [...c].filter(([, e]) => !e.live);
    for (const [key] of idle.slice(0, Math.max(0, idle.length - IDLE_QUERY_LIMIT))) drop(key);
    bump();
  }, [sig, synced]);

  useEffect(() => onEvent((e, task) => {
    task ??= current.current.tasks.get(e.task_id);
    let any = false;
    for (const [k, f] of cache.current) {
      if (!f.live || current.current.gone.has(e.task_id) || !accepts(f.q, e, task)) continue;
      cache.current.set(k, compactFeed({ ...f, events: mergeEvents(f.events, [e]) }, protectedQuery(k) ? Infinity : LIVE_FEED_LIMIT, current.current.gone));
      count(k, COUNT_EVERY);
      any = true;
    }
    if (any) bump();
  }), [onEvent]);

  useEffect(() => {
    if (!gone.size) return;
    let changed = false;
    for (const [key, entry] of cache.current) {
      const next = compactFeed(entry, Infinity, gone);
      if (next !== entry) { cache.current.set(key, next); changed = true; }
    }
    if (changed) bump();
  }, [gone]);

  const setReading = useCallback((id: string, keep: boolean) => {
    if (keep) reading.current.add(id);
    else if (reading.current.delete(id)) {
      const key = shown.current.get(id);
      const entry = key ? cache.current.get(key) : undefined;
      if (key && entry && !protectedQuery(key)) {
        const next = compactFeed(entry, LIVE_FEED_LIMIT, current.current.gone);
        if (next !== entry) { cache.current.set(key, next); bump(); }
      }
    }
  }, []);

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
    const oldest = cur?.events[0];
    if (!key || !cur || !oldest || !cur.more || cur.loading) return;
    // A retained old post can predate a gap left by a temporarily unavailable source.
    // If compaction trimmed the cache, its oldest retained post is the safer boundary.
    const before = cur.olderCursor && compareEvents(cur.olderCursor, oldest) > 0 ? cur.olderCursor : oldest;
    reading.current.add(id);
    set(key, (e) => ({ ...e, loading: true }));
    request(key, signal => api.feed(FEED_PAGE, before, cur.q, signal),
      (page) => set(key, (e) => ({ ...e, events: mergeEvents(e.events, page), olderCursor: page[0] ?? e.olderCursor,
        more: page.length >= FEED_PAGE, loading: false })),
      () => set(key, (e) => ({ ...e, loading: false })));
  }, []);

  return { feeds, loadEarlier, setReading };
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
  const earlierAbort = useRef<AbortController | null>(null);
  const shown = useRef<string | null>(null);
  /** Last event covered by a successful history read, excluding later live-only events. */
  const fetchedThrough = useRef<number | null>(null);
  /** Earliest live event seen before the first successful history read. */
  const firstLive = useRef<number | null>(null);
  /** Bumped on every (re)load, so an earlier page asked for meanwhile is dropped. */
  const gen = useRef(0);
  useEffect(() => {
    // Another task starts empty; the same task reopened at another post keeps what it shows meanwhile.
    const sameTask = shown.current === taskId;
    if (!sameTask) { setHistory({ events: [], more: false }); fetchedThrough.current = null; firstLive.current = null; }
    shown.current = taskId;
    setLoaded(null);
    setLoadingEarlier(false);
    earlierRequest.current = false;
    gen.current++;
    if (!taskId) return;
    let alive = true;
    const controller = new AbortController();
    const key = `${taskId}:${since ?? ''}`;
    // Reconnects can miss more than the newest page. Live events may jump ahead of the gap,
    // so only a completed history read can advance this cursor.
    const sinceFloor = () => {
      const ids = [since, fetchedThrough.current, firstLive.current].filter((id): id is number => id != null);
      return ids.length ? Math.min(...ids) : undefined;
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const fetchHistory = async () => {
      try {
        let page = await api.events(taskId, { since: sinceFloor() }, controller.signal);
        if (!alive) return;
        // A live event may arrive while the first request is in flight. If the newest page
        // starts after it, fetch the entire interval before treating the history as loaded.
        const gapBeforeLive = () => fetchedThrough.current == null && firstLive.current != null
          && (!page.events.length || page.events[0].id > firstLive.current);
        if (gapBeforeLive()) {
          page = await api.events(taskId, { since: sinceFloor() }, controller.signal);
          if (!alive) return;
        }
        if (gapBeforeLive()) throw new Error('Incomplete task history');
        // Older events kept from before (pages loaded earlier) keep their own `more`.
        setHistory((prev) => ({
          events: mergeTaskEvents(prev.events, page.events),
          more: prev.events.length && page.events.length && prev.events[0].id < page.events[0].id ? prev.more : page.more,
        }));
        if (page.events.length) fetchedThrough.current = Math.max(fetchedThrough.current ?? 0, page.events[page.events.length - 1].id);
        firstLive.current = null;
        setLoaded(key);
      } catch {
        if (!alive) return;
        // A transient failure must not strand an open thread until the app restarts.
        retry = setTimeout(fetchHistory, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
    };
    fetchHistory();
    // Live events come cut like the feed's; the thread fetches the cut ones whole, a few at a time.
    const cut = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchWhole = () => {
      timer = undefined;
      const ids = [...cut];
      cut.clear();
      api.events(taskId, { ids }, controller.signal).then((page) => {
        if (alive) setHistory((prev) => ({ ...prev, events: mergeTaskEvents(prev.events, page.events) }));
      }).catch(() => {});
    };
    const off = onEvent((e) => {
      if (e.task_id !== taskId) return;
      if (fetchedThrough.current == null) firstLive.current = Math.min(firstLive.current ?? e.id, e.id);
      setHistory((prev) => ({ ...prev, events: mergeTaskEvents(prev.events, [e]) }));
      if (e.payload?.clipped) {
        cut.add(e.id);
        timer ??= setTimeout(fetchWhole, WHOLE_DELAY_MS);
      }
    });
    return () => {
      alive = false; off(); clearTimeout(timer); clearTimeout(retry); gen.current++;
      controller.abort(); earlierAbort.current?.abort(); earlierAbort.current = null;
    };
  }, [taskId, since, onEvent, reload]);
  const loadEarlier = useCallback(() => {
    const oldest = events[0];
    if (!taskId || !more || !oldest || earlierRequest.current) return;
    const g = gen.current;
    earlierRequest.current = true;
    setLoadingEarlier(true);
    const controller = new AbortController();
    earlierAbort.current = controller;
    api.events(taskId, { before: oldest.id }, controller.signal).then((page) => {
      if (gen.current !== g) return;
      setHistory((prev) => ({ events: mergeTaskEvents(prev.events, page.events), more: page.more }));
    }).catch(() => {}).finally(() => {
      if (earlierAbort.current === controller) earlierAbort.current = null;
      if (gen.current === g) { earlierRequest.current = false; setLoadingEarlier(false); }
    });
  }, [taskId, events, more, loadingEarlier]);
  return { events, more, loadingEarlier, loadEarlier, loaded: taskId != null && loaded === `${taskId}:${since ?? ''}` };
}
