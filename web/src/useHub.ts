import { openSourceStream } from './sourceStream.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, FEED_PAGE, type FeedQuery, type FeedTotal } from './api.ts';
import { compareEvents, discoverSources, getSources, mapMessage, sourceBase, sourceConnected, splitId, subscribeSources } from './federation.ts';
import { mergeEvents, mergeTaskEvents } from './posts.ts';
import { assignProjectColors, forgetProjectColors } from './projects.ts';
import { feedCursor, compactFeed, IDLE_FEED_LIMIT, IDLE_QUERY_LIMIT, LIVE_FEED_LIMIT } from './feedCache.ts';
import { confirmedMissingTask } from './draftRetention.ts';
import { noteRevision, onNoteChange, reportNoteChange, visibleNoteEvents } from './noteEvents.ts';
import type { Approval, Channel, ChannelEntry, ColumnDef, ColumnFilter, EventKind, HubEvent, HubMessage, PostKind, Project, Question, TaskView } from './types.ts';
import type { AccessView, RunnerConnectionProblem } from '../../shared/api.ts';

const FEED_CAP = 3000;
/** How long an open thread gathers cut live events before fetching them whole. */
const WHOLE_DELAY_MS = 400;
/** How long live hub messages gather before one render handles them together. */
const SSE_BATCH_MS = 50;

type FeedEventBatch = { event: HubEvent; task?: TaskView }[];
type SubscribeEventBatch = (fn: (batch: FeedEventBatch) => void) => () => void;

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
  const [runnerProblem, setRunnerProblem] = useState<RunnerConnectionProblem>();
  // Whether this browser runs on the hub's own machine (local links open only there).
  const [local, setLocal] = useState(true);
  // Devices asking to connect and devices let in: on this Mac's pages only.
  const [access, setAccess] = useState<AccessView | null>(null);
  const listeners = useRef(new Set<(e: HubEvent, task?: TaskView) => void>());
  const batchListeners = useRef(new Set<(batch: FeedEventBatch) => void>());
  // Counts state reloads (each SSE (re)connect): feed columns reload their newest page with it.
  const [synced, setSynced] = useState(0);
  const [sourceSynced, setSourceSynced] = useState(new Map<string, number>());
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
  const refreshingState = useRef<Promise<void> | null>(null);
  const refreshQueue = useRef(new Set<string | undefined>());
  const subscribed = useRef(true);
  const refresh = useCallback((repeat = true, scope?: string): Promise<void> => {
    if (refreshingState.current) {
      if (repeat) refreshQueue.current.add(scope);
      return refreshingState.current;
    }
    refreshQueue.current.add(scope);
    const run = async () => {
      let failure: unknown;
      while (refreshQueue.current.size && subscribed.current) {
        const scope = refreshQueue.current.values().next().value;
        refreshQueue.current.delete(scope);
        const targeted = (id: string) => scope === undefined || splitId(id)[0] === scope;
        const channelUpdates = new Map<string, Channel | null>();
        const taskUpdates = new Map<string, TaskView | null>();
        const approvalUpdates=new Map<string,Approval>(),questionUpdates=new Map<string,Question>();
        approvalRefresh.current=approvalUpdates;questionRefresh.current=questionUpdates;
        channelRefresh.current = channelUpdates;
        taskRefresh.current = taskUpdates;
        try {
          const apply = (s: Awaited<ReturnType<typeof api.state>>) => {
            if (!subscribed.current || channelRefresh.current !== channelUpdates) return;
            const nextTasks = new Map(s.tasks.filter(t => !deleted.current.has(t.id)).map(t => [t.id, t]));
            for(const [id,task] of currentTasks.current) {
              const source = splitId(id)[0];
              if ((!targeted(id) || !source || getSources().some(s => s.id === source)) && !s.availableSources?.includes(source)
                && !nextTasks.has(id) && !deleted.current.has(id))
                nextTasks.set(id, s.unavailableSources?.includes(source) ? {...task,runner_connected:false} : task);
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
            // Columns own history paging; the global stream needs only task previews and live events.
            const previews = [...nextTasks.values()].filter(task => targeted(task.id)).flatMap(task => task.last_event ?? []);
            setEvents((prev) => mergeEvents(prev.filter(e => !deleted.current.has(e.task_id)),
              visibleNoteEvents(previews.filter(e => !deleted.current.has(e.task_id))), FEED_CAP));
            const nextProjects = s.projects.filter(p => !deletedProjects.current.has(p.id));
            if (scope === undefined || s.availableSources?.includes(scope)) {
              assignProjectColors(nextProjects);
              setProjects(prev => scope === undefined ? nextProjects : [...prev.filter(p => !targeted(p.id)), ...nextProjects]);
            }
            if (available.has('') && channelRefresh.current === channelUpdates) {
              const next = new Map((s.channels ?? []).map((channel) => [channel.id, channel]));
              for (const [id, channel] of channelUpdates) { if (channel) next.set(id, channel); else next.delete(id); }
              setChannels(next);
            }
            commitTasks(() => nextTasks);
            setAvailableSources(prev => {
              if (scope === undefined) return new Set(s.availableSources ?? []);
              const next = new Set(prev);
              if (s.availableSources?.includes(scope)) next.add(scope); else next.delete(scope);
              return next;
            });
            const allApprovals=new Map(s.approvals.map(a=>[a.id,a]));for(const [id,a] of approvalUpdates)allApprovals.set(id,a);
            const preserve = (id: string) => !targeted(id) || !s.availableSources?.includes(scope!);
            setApprovals(prev => new Map([...(scope === undefined ? [] : [...prev].filter(([id])=>preserve(id)&&!allApprovals.has(id))),
              ...[...allApprovals].filter(([,a])=>a.status==='pending'&&!deleted.current.has(a.task_id))]));
            const allQuestions=new Map((s.questions??[]).map(q=>[q.id,q]));for(const [id,q] of questionUpdates)allQuestions.set(id,q);
            setQuestions(prev => new Map([...(scope === undefined ? [] : [...prev].filter(([id])=>preserve(id)&&!allQuestions.has(id))),
              ...[...allQuestions].filter(([,q])=>q.status==='pending'&&!deleted.current.has(q.task_id))]));
            if (scope === undefined || scope === '') {
              if (s.runner) { setRunnerConnected(s.runner.connected); setRunnerProblem(s.runner.problem); }
              if (s.client) setLocal(s.client.local);
              if (scope === undefined || s.availableSources?.includes('')) setAccess(s.access ?? null);
            }
          };
          const snapshot = await api.state(apply, scope);
          apply(snapshot);
          if (!subscribed.current) continue;
          if (scope === undefined) setSynced((n) => n + 1);
          else if (snapshot.availableSources?.includes(scope))
            setSourceSynced(prev => new Map(prev).set(scope, (prev.get(scope) ?? 0) + 1));
          else throw new Error('작업공간 상태를 다시 불러오지 못했습니다');
        } catch (error) {
          failure ??= error;
        } finally {
          if (channelRefresh.current === channelUpdates) channelRefresh.current = null;
          if (taskRefresh.current === taskUpdates) taskRefresh.current = null;
          if(approvalRefresh.current===approvalUpdates)approvalRefresh.current=null;
          if(questionRefresh.current===questionUpdates)questionRefresh.current=null;
        }
      }
      if (failure) throw failure;
    };
    const pending = run().finally(() => { refreshingState.current = null; });
    refreshingState.current = pending;
    return pending;
  }, [commitTasks]);

  useEffect(() => {
    subscribed.current = true;
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
          setRunnerProblem(m.problem);
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
      const liveEvents = visibleNoteEvents(events.filter(e => !deleted.current.has(e.task_id)));
      if (liveEvents.length) {
        setEvents((prev) => mergeEvents(prev, liveEvents, FEED_CAP));
        const entries = liveEvents.map(event => ({ event, task: currentTasks.current.get(event.task_id) }));
        batchListeners.current.forEach(fn => fn(entries));
        for (const e of liveEvents) listeners.current.forEach((fn) => fn(e, currentTasks.current.get(e.task_id)));
      }
      // Publish new posts before their edits so a thread can update them even in one batch.
      for (const m of ms) if (m.type === 'event_updated' || m.type === 'event_removed') reportNoteChange(m);
      for (const entry of channelEntries) channelListeners.current.forEach((fn) => fn(entry));
    };
    const streams=new Map<string,ReturnType<typeof openSourceStream>>();
    const recovery = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
    const cancelRecovery = (id: string) => {
      clearTimeout(recovery.get(id)?.timer);
      recovery.delete(id);
    };
    let openedLocal = false;
    const update=()=>{
      const sources=[{id:'',view_index:0},...getSources()];
      for(const [id,stream] of streams)if(!sources.some(s=>s.id===id)){
        cancelRecovery(id);stream.close();streams.delete(id);void refresh().catch(()=>{});
      }
      for(const source of sources) {
        if(streams.has(source.id))continue;
        const es=openSourceStream(source.id);streams.set(source.id,es);
        // A pending snapshot may predate this connection. Always queue one recovery read.
        es.onopen=()=>{
          if(!source.id)setConnected(true);else sourceConnected(source.id,true);
          const scope = !source.id && !openedLocal ? undefined : source.id;
          if (!source.id) openedLocal = true;
          cancelRecovery(source.id);
          const attempt: { timer?: ReturnType<typeof setTimeout> } = {};
          recovery.set(source.id, attempt);
          const refreshSource = (target: string | undefined, delay: number) => {
            void refresh(true, target).then(() => {
              if (recovery.get(source.id) === attempt) recovery.delete(source.id);
            }, () => {
              if (recovery.get(source.id) !== attempt) return;
              attempt.timer = setTimeout(() => refreshSource(source.id, Math.min(30_000, delay * 2)), delay);
            });
          };
          refreshSource(scope, 1000);
        };
        es.onerror=()=>{
          cancelRecovery(source.id);
          if(source.id){sourceConnected(source.id,false);commitTasks(prev=>{let next=prev;for(const [id,t] of prev)if(id.startsWith(`w:${source.id}:`)&&t.runner_connected!==false){if(next===prev)next=new Map(prev);next.set(id,{...t,runner_connected:false});}return next;});}
          else {setConnected(false);fetch('/api/state',{method:'HEAD'}).then(r=>{if(r.status===401)location.reload();},()=>{});}
        };
        es.onmessage=msg=>{
          const mapped=mapMessage(source.id,source.view_index,JSON.parse(msg.data));
          if(mapped){api.remember(source.id,mapped);batch.push(mapped);timer??=setTimeout(flush,SSE_BATCH_MS);}
        };
      }
    };
    const unsubscribe=subscribeSources(update);
    const unsubscribeNotes = onNoteChange(change => {
      if (change.type === 'event_removed') setEvents(visibleNoteEvents);
      else if (!deleted.current.has(change.event.task_id)) setEvents(prev => mergeEvents(prev, [change.event], FEED_CAP));
    });
    update();
    const poll=setInterval(()=>{void discoverSources(true).catch(()=>{});},5000);
    void discoverSources(true).then(update,()=>{});
    return()=>{subscribed.current=false;refreshQueue.current.clear();unsubscribe();unsubscribeNotes();clearInterval(poll);
      for(const [id, es] of streams){cancelRecovery(id);es.close();}clearTimeout(timer);clearTimeout(projectTimer);};
  }, [refresh, commitTasks]);

  const onEvent = useCallback((fn: (e: HubEvent, task?: TaskView) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const onEventBatch: SubscribeEventBatch = useCallback(fn => {
    batchListeners.current.add(fn);
    return () => { batchListeners.current.delete(fn); };
  }, []);

  const onChannelEntry = useCallback((fn: (entry: ChannelEntry) => void) => {
    channelListeners.current.add(fn);
    return () => { channelListeners.current.delete(fn); };
  }, []);
  return { projects, channels, onChannelEntry, tasks, updateTaskTitle, approvals, questions, events, connected, runnerConnected, runnerProblem, local, access, synced, sourceSynced, gone, availableSources, refresh, onEvent, onEventBatch };
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

function matchesNoteQuery(q: FeedQuery, event: HubEvent, task: TaskView | undefined): boolean {
  const query = q.q?.toLowerCase();
  return accepts(q, event, task) && (!query || String(event.payload.text ?? '').toLowerCase().includes(query)
    || !!task?.title.toLowerCase().includes(query));
}

/** `total`: the column's posts in the hub's database, and their tasks; unknown until counted. */
export interface ColumnFeed {
  events: HubEvent[]; more: boolean; loading: boolean; total?: { posts: number; tasks: number };
  /** Identity of this query's request generation; changes when outstanding reads are cancelled. */
  token?: object;
  olderCursor?: HubEvent;
  gapCursor?: HubEvent;
  /** Only completed historical responses, never live events. */
  olderPage?: ReadonlySet<string>;
}

/** A query's total is counted again at most this often (ms) while its events arrive. */
const COUNT_EVERY = 3000;
/** Small newest pages keep startup/reconnect transfers bounded; older reads use FEED_PAGE. */
const NEWEST_FEED_PAGE = 200;


/**
 * A query's events. `live`: a shown column uses it, so live events reach it; one that was hidden
 * missed some and fetches its newest page again when shown. `at`: the state reload (`synced`) its
 * newest page is from.
 */
interface FeedEntry extends ColumnFeed {
  q: FeedQuery; at: number; live: boolean; token: object; requestedAt?: number; olderCursor?: HubEvent;
  sourceTotals?: Map<string, FeedTotal>;
  verifiedNewest?: Map<string, HubEvent>;
}

function retryPause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Each feed column's events, filtered by the hub to what the column shows, newest page first and
 * older pages on request (`loadEarlier`), kept live. Events are kept per query, not per column:
 * a view switch shows the queries it had at once and only fetches their newest page quietly.
 * Hidden queries keep a bounded recent-page LRU. A shown column being read keeps its older
 * pages until it returns to the top. Grouped columns retain a fixed history snapshot instead:
 * subsequent live events still use the recent-page limit. Hidden/ungrouped columns release it.
 */
export function useColumnFeeds(defs: ColumnDef[], kept: () => ColumnDef[], tasks: Map<string, TaskView>,
  onEvent: (fn: (e: HubEvent, task?: TaskView) => void) => () => void, synced: number, gone: Set<string> = new Set(), onEventBatch?: SubscribeEventBatch,
  sourceSynced?: ReadonlyMap<string, number>) {
  const cache = useRef(new Map<string, FeedEntry>());
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const queries = new Map(defs.filter((d) => !d.channelId).map((d) => [d.id, feedQuery(d.filter, tasks)]));
  const sig = JSON.stringify([...queries]);
  const grouped = new Set(defs.filter(d => d.byTask && !d.channelId).map(d => d.id));
  const groupedSig = JSON.stringify([...grouped]);
  const current = useRef({ tasks, kept, gone, grouped });
  current.current = { tasks, kept, gone, grouped };
  // The query each column showed last: a column whose query changes starts from those events.
  const shown = useRef(new Map<string, string>());
  const reading = useRef(new Set<string>());
  // Fixed IDs from explicit history reads: future SSE does not enlarge this snapshot.
  const retained = useRef(new Map<string, Set<number>>());
  const requests = useRef(new Map<string, Set<AbortController>>());
  const retries = useRef(new Map<string, number>());
  const retryAttempts = useRef(new Map<string, number>());
  const sourceEpochs = useRef(sourceSynced);
  const protectedQuery = (key: string) => [...reading.current].some(id => !current.current.grouped.has(id) && shown.current.get(id) === key);
  const retainedQuery = (key: string) => {
    let ids: ReadonlySet<number> | undefined;
    for (const [id, saved] of retained.current) if (current.current.grouped.has(id) && shown.current.get(id) === key)
      ids = ids ? new Set([...ids, ...saved]) : saved;
    return ids;
  };

  const set = (key: string, f: (e: FeedEntry) => FeedEntry) => {
    const e = cache.current.get(key);
    if (e) {
      cache.current.set(key, compactFeed(f(e), e.live ? protectedQuery(key) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT, current.current.gone, e.live ? retainedQuery(key) : undefined));
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
  const applyCounts = (key: string, total: FeedTotal & { bySource?: Map<string, FeedTotal> }) => set(key, entry => {
    if (!total.bySource) return { ...entry, total };
    const configured = new Set(['', ...getSources().map(source => source.id)]);
    const sourceTotals = new Map([...(entry.sourceTotals ?? []), ...total.bySource]);
    let posts = 0, tasks = 0;
    for (const [source, counts] of sourceTotals) {
      if (!configured.has(source)) { sourceTotals.delete(source); continue; }
      posts += counts.posts;
      tasks += counts.tasks;
    }
    return { ...entry, sourceTotals, total: { posts, tasks } };
  });
  const count = (key: string, delay = 0) => {
    if (counting.current.has(key)) return;
    counting.current.set(key, window.setTimeout(() => {
      counting.current.delete(key);
      const e = cache.current.get(key);
      // A hub not yet restarted has no count: the column shows only what it loaded.
      if (e) request(key, signal => api.feedCount(e.q, signal, undefined, true), total => applyCounts(key,total));
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
  const recheckNotes = (key: string, notes: HubEvent[]) => {
    const tasks = new Map<string, HubEvent[]>();
    for (const event of notes) {
      const held = tasks.get(event.task_id);
      if (held) held.push(event);
      else tasks.set(event.task_id, [event]);
    }
    for (const [taskId, events] of tasks) for (let offset = 0; offset < events.length; offset += 500) {
      const held = new Map(events.slice(offset, offset + 500).map(event => [event.id, event]));
      request(key, signal => api.events(taskId, { ids: [...held.keys()] }, signal), page => {
        const received = new Map(visibleNoteEvents(page.events).map(event => [event.id, event]));
        const task = current.current.tasks.get(taskId);
        set(key, entry => ({ ...entry, events: entry.events.flatMap(event => {
          if (held.get(event.id) !== event) return [event];
          const updated = received.get(event.id);
          if (!updated || !matchesNoteQuery(entry.q, updated, task)) return [];
          return [(noteRevision(updated) ?? 0) > (noteRevision(event) ?? 0) ? updated : event];
        }).sort(compareEvents) }));
      });
    }
  };
  const loadNewest = (key: string, epoch: number) => {
    const entry = cache.current.get(key);
    if (!entry) return;
    const token = entry.token;
    const limit = NEWEST_FEED_PAGE;
    const savedNotes = new Set(entry.events.filter(event => noteRevision(event) !== undefined));
    set(key, e => ({ ...e, loading: true, requestedAt: epoch }));
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
    request(key, signal => api.feedPage(limit, undefined, entry.q, signal, page => {
      if (signal.aborted || cache.current.get(key)?.token !== token) return;
      // Partial pages never advance the paging boundary or replace already visible posts.
      set(key, e => ({ ...e, events: mergeEvents(e.events, visibleNoteEvents(page.events)) }));
    }), page => {
      const oldest = page.complete && page.events.length >= limit ? page.events[0] : undefined;
      const ids = page.complete && savedNotes.size ? new Set(page.events.map(event => event.id)) : undefined;
      const older = oldest && ids ? [...savedNotes].filter(event => !ids.has(event.id) && compareEvents(event, oldest) < 0) : [];
      const checkOlder = new Set(older);
      set(key, e => {
        // Keep every readable source's posts while an unavailable source catches up.
        const received = visibleNoteEvents(page.events);
        // A note missing in the fresh page's range was deleted or stopped matching this query.
        const kept = ids ? e.events.filter(event => !savedNotes.has(event) || ids.has(event.id) || checkOlder.has(event)) : e.events;
        const verifiedNewest = new Map(e.verifiedNewest);
        for (const event of page.events) {
          const source = splitId(event.task_id)[0];
          const previous = verifiedNewest.get(source);
          if (!previous || compareEvents(event, previous) > 0) verifiedNewest.set(source, event);
        }
        return { ...e, events: mergeEvents(kept, received),
          verifiedNewest,
          more: page.events.length >= limit || (!page.complete && e.more),
          olderCursor: page.complete ? page.events[0] : e.olderCursor ?? page.events[0],
          loading: false, at: page.complete ? epoch : e.at };
      });
      if (page.complete) { cancelRetry(key); recheckNotes(key, older); }
      else if (!page.incompleteSources?.every(id => id && getSources().some(source => source.id === id && source.connected === false))) retry();
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
    cache.current.clear(); shown.current.clear(); reading.current.clear(); retained.current.clear();
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
      if (prev !== key) { reading.current.delete(id); retained.current.delete(id); }
      shown.current.set(id, key);
      if (started.has(key)) continue;
      started.add(key);
      if (cur?.live && (cur.at === synced || cur.loading && cur.requestedAt === synced)) continue;
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
    for (const id of shown.current.keys()) if (!want.some(([w]) => w === id)) { shown.current.delete(id); reading.current.delete(id); retained.current.delete(id); }
    const used = new Set(current.current.kept().filter((d) => !d.channelId).map((d) => JSON.stringify(feedQuery(d.filter, current.current.tasks))));
    for (const [k, e] of c) {
      if (!e.live && !used.has(k)) drop(k);
      else c.set(k, compactFeed(e, e.live ? protectedQuery(k) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT, current.current.gone, e.live ? retainedQuery(k) : undefined));
    }
    const idle = [...c].filter(([, e]) => !e.live);
    for (const [key] of idle.slice(0, Math.max(0, idle.length - IDLE_QUERY_LIMIT))) drop(key);
    bump();
  }, [sig, synced]);

  useEffect(() => {
    for (const id of retained.current.keys()) if (!current.current.grouped.has(id)) retained.current.delete(id);
    // A display-mode change can leave the query key and column ID unchanged.
    for (const id of current.current.grouped) reading.current.delete(id);
    let changed = false;
    for (const [key, entry] of cache.current) {
      const next = compactFeed(entry, entry.live ? protectedQuery(key) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT,
        current.current.gone, entry.live ? retainedQuery(key) : undefined);
      if (next !== entry) { cache.current.set(key, next); changed = true; }
    }
    if (changed) bump();
  }, [groupedSig]);

  useEffect(() => {
    const previous = sourceEpochs.current;
    sourceEpochs.current = sourceSynced;
    for (const [source, epoch] of sourceSynced ?? []) {
      if (previous?.get(source) === epoch) continue;
      for (const [key, entry] of cache.current) {
        if (!entry.live) continue;
        const notes = entry.events.filter(event => splitId(event.task_id)[0] === source && noteRevision(event) !== undefined);
        request(key, async signal => {
          // A live event may arrive before the scoped state read. Only a fetched page covers the gap.
          const anchor = entry.verifiedNewest?.get(source) ?? entry.olderCursor;
          let before: HubEvent | undefined, delay = 1000;
          let newest: HubEvent | undefined;
          for (;;) {
            const page = await api.feedPage(NEWEST_FEED_PAGE, before, entry.q, signal, undefined, source).catch(() => null);
            if (!page?.complete) {
              await retryPause(delay, signal);
              delay = Math.min(10_000, delay * 2);
              continue;
            }
            if (signal.aborted) return;
            delay = 1000;
            const oldest: HubEvent | undefined = page.events[0];
            newest ??= page.events.at(-1);
            set(key, e => ({ ...e, events: mergeEvents(e.events, visibleNoteEvents(page.events)),
              more: e.more || (!before && page.events.length >= NEWEST_FEED_PAGE) }));
            if (!anchor || !oldest || page.events.length < NEWEST_FEED_PAGE || compareEvents(oldest, anchor) <= 0) return newest;
            before = oldest;
          }
        }, newest => {
          if (newest) set(key, e => {
            const previous = e.verifiedNewest?.get(source);
            if (previous && compareEvents(newest, previous) <= 0) return e;
            return { ...e, verifiedNewest: new Map([...(e.verifiedNewest ?? []), [source, newest]]) };
          });
          recheckNotes(key, notes);
        });
        request(key, signal => api.feedCount(entry.q, signal, source, true), total => applyCounts(key,total));
      }
    }
  }, [sourceSynced]);

  useEffect(() => {
    const receive = (batch: FeedEventBatch) => {
      let any = false;
      for (const [k, f] of cache.current) {
        if (!f.live) continue;
        const incoming = batch.filter(({ event, task }) => !current.current.gone.has(event.task_id)
          && accepts(f.q, event, task ?? current.current.tasks.get(event.task_id))).map(({ event }) => event);
        if (!incoming.length) continue;
        // Keep the existing 50ms delivery boundary: merge each query once, before note edits/removals.
        cache.current.set(k, compactFeed({ ...f, events: mergeEvents(f.events, incoming) },
          protectedQuery(k) ? Infinity : LIVE_FEED_LIMIT, current.current.gone, retainedQuery(k)));
        count(k, COUNT_EVERY);
        any = true;
      }
      if (any) bump();
    };
    return onEventBatch ? onEventBatch(receive) : onEvent((event, task) => receive([{ event, task }]));
  }, [onEvent, onEventBatch]);

  useEffect(() => onNoteChange(change => {
    let changed = false;
    for (const [key, entry] of cache.current) {
      let events = entry.events;
      if (change.type === 'event_removed') events = visibleNoteEvents(events);
      else {
        const event = change.event;
        const task = current.current.tasks.get(event.task_id);
        const held = events.some(e => e.id === event.id);
        if (matchesNoteQuery(entry.q, event, task)) {
          if (held || entry.live) events = mergeEvents(events, [event]);
        } else if (held) events = events.filter(e => e.id !== event.id);
      }
      if (events !== entry.events) {
        cache.current.set(key, compactFeed({ ...entry, events }, entry.live ? protectedQuery(key) ? Infinity : LIVE_FEED_LIMIT : IDLE_FEED_LIMIT, current.current.gone, entry.live ? retainedQuery(key) : undefined));
        if (entry.live) count(key, COUNT_EVERY);
        changed = true;
      }
    }
    if (changed) bump();
  }), []);

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
    if (keep && !current.current.grouped.has(id)) reading.current.add(id);
    else if (reading.current.delete(id)) {
      const key = shown.current.get(id);
      const entry = key ? cache.current.get(key) : undefined;
      if (key && entry && !protectedQuery(key)) {
        const next = compactFeed(entry, LIVE_FEED_LIMIT, current.current.gone, retainedQuery(key));
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
    if (!key || !cur || !cur.more || cur.loading) return;
    // Deleting every cached task can leave a valid history/gap boundary behind.
    const before = feedCursor(cur);
    if (!before) return;
    if (current.current.grouped.has(id)) {
      retained.current.set(id, new Set([...(retained.current.get(id) ?? []), ...cur.events.map(e => e.id)]));
    } else reading.current.add(id);
    set(key, (e) => ({ ...e, loading: true }));
    request(key, signal => api.feed(FEED_PAGE, before, cur.q, signal),
      (page) => {
        const saved = retained.current.get(id);
        if (saved && current.current.grouped.has(id)) for (const event of page) saved.add(event.id);
        set(key, e => ({ ...e, events: mergeEvents(e.events, visibleNoteEvents(page)), olderCursor: page[0] ?? e.olderCursor,
          olderPage: new Set(visibleNoteEvents(page).map(event => event.task_id)),
          // A newer gap can be evicted by SSE while this request is in flight.
          gapCursor: e.gapCursor === cur.gapCursor ? undefined : e.gapCursor,
          more: page.length >= FEED_PAGE || !!(e.gapCursor && e.gapCursor !== cur.gapCursor), loading: false }));
      },
      () => set(key, (e) => ({ ...e, loading: false })));
  }, []);

  return { feeds, loadEarlier, setReading };
}

/** Inactive threads keep only a recent, successfully fetched and contiguous page. */
const THREAD_CACHE_SIZE = 4;
const THREAD_CACHE_EVENTS = 500;
const THREAD_CACHE_BYTES = 2_000_000;
const EMPTY_TASK_EVENTS: HubEvent[] = [];

interface TaskHistory {
  taskId: string;
  events: HubEvent[];
  more: boolean;
  /** Last event covered by a history read, excluding later live-only events. */
  cursor: number | null;
  /** Start of the contiguous ID page, excluding old notes moved into it by edit time. */
  beforeCursor?: number;
  firstLive: number | null;
  since: number | undefined;
  reload: number;
  sourceReload: number;
  loaded: boolean;
  loadingEarlier: boolean;
}

function historyFloor(history: TaskHistory | undefined, since?: number): number | undefined {
  const ids = [since, history?.cursor, history?.firstLive].filter((id): id is number => id != null);
  return ids.length ? Math.min(...ids) : undefined;
}

function recentHistory(history: TaskHistory, cursor: number): TaskHistory | undefined {
  const { events } = history;
  let end = events.length;
  while (end > 0 && events[end - 1].id > cursor) end--;
  let start = end, bytes = 0;
  while (start > Math.max(0, end - THREAD_CACHE_EVENTS)) {
    // Count serialized string storage and allow room for the event fields.
    bytes += 256 + 2 * JSON.stringify(events[start - 1].payload).length;
    if (bytes > THREAD_CACHE_BYTES) break;
    start--;
  }
  if (start === end) return;
  return { ...history, events: events.slice(start, end), more: history.more || start > 0,
    beforeCursor: start > 0 ? events[start].id : history.beforeCursor,
    firstLive: null, loaded: false, loadingEarlier: false };
}

/**
 * The newest events of one task and everything from an explicitly opened post onward.
 * Earlier pages stay available while the task is open. A revisit displays its recent cached page
 * immediately, and every open/reload still reads the authoritative source.
 */
export function useTaskEvents(taskId: string | null, onEvent: (fn: (e: HubEvent) => void) => () => void, since?: number, reload = 0, sourceReload = 0, note = false) {
  const active = useRef<TaskHistory | undefined>(undefined);
  const [history, setHistory] = useState<TaskHistory | undefined>(undefined);
  const cache = useRef(new Map<string, TaskHistory>());
  const earlier = useRef<(() => void) | null>(null);
  const publish = (value: TaskHistory | undefined) => { active.current = value; setHistory(value); };

  useEffect(() => {
    const previous = active.current;
    if (previous && previous.taskId !== taskId && previous.cursor != null) {
      const recent = recentHistory(previous, previous.cursor);
      if (recent) cache.current.set(previous.taskId, recent);
      while (cache.current.size > THREAD_CACHE_SIZE) cache.current.delete(cache.current.keys().next().value!);
    }
    if (!taskId) { publish(undefined); return; }
    const held = previous?.taskId === taskId ? previous : cache.current.get(taskId);
    cache.current.delete(taskId);
    const kept = visibleNoteEvents(held?.events ?? EMPTY_TASK_EVENTS);
    const reconnect = !note && !!held?.loaded && held === previous && held.since === since && held.reload === reload
      && held.sourceReload !== sourceReload && held.cursor != null;
    const oldestNote = note ? held?.beforeCursor : held?.events.find(e => noteRevision(e) !== undefined)?.id;
    const oldNotes = reconnect || oldestNote == null ? undefined : new Set(kept);
    publish({ taskId, events: kept, more: held?.more ?? false, cursor: held?.cursor ?? null, beforeCursor: held?.beforeCursor,
      firstLive: held?.firstLive ?? null, since, reload, sourceReload, loaded: reconnect, loadingEarlier: false });
    const floor = () => historyFloor(active.current, oldestNote == null ? since : Math.min(oldestNote, since ?? Infinity));
    const controller = new AbortController();
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const catchUp = async () => {
      let after = active.current!.cursor!;
      for (;;) {
        const page = await api.events(taskId, { after }, controller.signal);
        if (!alive) return;
        const events = page.events.filter(event => event.id > after);
        if (!events.length) break;
        after = events.at(-1)!.id;
        const current = active.current!;
        publish({ ...current, events: mergeTaskEvents(current.events, visibleNoteEvents(events)), cursor: after, firstLive: null });
        if (!('incremental' in page && page.incremental) || !page.more) break;
      }
      // Edits and deletions in an older loaded note do not get a new history ID.
      const notes = kept.filter(event => noteRevision(event) !== undefined);
      for (let offset = 0; offset < notes.length; offset += 500) {
        const held = new Map(notes.slice(offset, offset + 500).map(event => [event.id, event]));
        const page = await api.events(taskId, { ids: [...held.keys()] }, controller.signal);
        if (!alive) return;
        const received = new Map(visibleNoteEvents(page.events).map(event => [event.id, event]));
        const current = active.current!;
        const events = current.events.flatMap(event => {
          if (held.get(event.id) !== event) return [event];
          const fresh = received.get(event.id);
          if (!fresh) return [];
          return [(noteRevision(fresh) ?? 0) > (noteRevision(event) ?? 0) ? fresh : event];
        });
        publish({ ...current, events });
      }
    };
    const fetchHistory = async () => {
      try {
        if (reconnect) { await catchUp(); return; }
        let page = await api.events(taskId, { since: floor() }, controller.signal);
        if (!alive) return;
        // A live event can arrive while the newest page is in flight. Cover the gap before
        // advancing the cursor, so a reload never skips events between two reads.
        const gapBeforeLive = () => {
          const { cursor, firstLive } = active.current!;
          return cursor == null && firstLive != null && (!page.events.length || page.events[0].id > firstLive);
        };
        if (gapBeforeLive()) {
          page = await api.events(taskId, { since: floor() }, controller.signal);
          if (!alive) return;
        }
        if (gapBeforeLive()) throw new Error('Incomplete task history');
        const current = active.current!;
        const latest = page.events.at(-1)?.id;
        // Revalidate the entire held range of an editable thread. Live edits and newly posted
        // events that arrived after the read began still take precedence.
        const retained = oldNotes ? current.events.filter(event => !oldNotes.has(event)) : current.events;
        const keepsEarlier = current.beforeCursor != null && (!page.events.length || current.beforeCursor < page.events[0].id);
        const keepHistory = !oldNotes && keepsEarlier;
        const incoming = mergeTaskEvents(visibleNoteEvents(page.events), visibleNoteEvents(page.moved ?? []));
        publish({ ...current, events: mergeTaskEvents(retained, incoming),
          more: keepHistory ? current.more : page.more,
          beforeCursor: keepHistory ? current.beforeCursor : page.events[0]?.id,
          cursor: latest == null ? current.cursor : Math.max(current.cursor ?? 0, latest), firstLive: null, loaded: true });
      } catch {
        if (!alive) return;
        retry = setTimeout(fetchHistory, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
    };
    // Live events arrive clipped like the feed's. Gather a few before fetching them whole.
    const cut = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchWhole = () => {
      timer = undefined;
      const ids = [...cut];
      cut.clear();
      api.events(taskId, { ids }, controller.signal).then((page) => {
        if (!alive) return;
        const current = active.current!;
        publish({ ...current, events: mergeTaskEvents(current.events, visibleNoteEvents(page.events)) });
      }).catch(() => {});
    };
    const off = onEvent((e) => {
      if (e.task_id !== taskId) return;
      const current = active.current!;
      publish({ ...current, events: mergeTaskEvents(current.events, [e]),
        firstLive: current.cursor == null ? Math.min(current.firstLive ?? e.id, e.id) : null });
      if (e.payload?.clipped) {
        cut.add(e.id);
        timer ??= setTimeout(fetchWhole, WHOLE_DELAY_MS);
      }
    });
    const offNotes = onNoteChange(change => {
      const current = active.current!;
      if (change.type === 'event_removed') {
        if (change.task_id !== taskId) return;
        cut.delete(change.event_id);
        const events = visibleNoteEvents(current.events);
        const firstLive = current.firstLive === change.event_id ? events[0]?.id ?? null : current.firstLive;
        if (events !== current.events || firstLive !== current.firstLive) publish({ ...current, events, firstLive });
        return;
      }
      const event = change.event;
      if (event.task_id !== taskId || (!note && !current.events.some(held => held.id === event.id))) return;
      const events = mergeTaskEvents(current.events, [event]);
      if (events !== current.events) publish({ ...current, events });
      if (event.payload.clipped) {
        cut.add(event.id);
        timer ??= setTimeout(fetchWhole, WHOLE_DELAY_MS);
      }
    });
    void fetchHistory();

    earlier.current = () => {
      const current = active.current!;
      const before = current.beforeCursor ?? current.events[0]?.id;
      if (!current.more || before == null || current.loadingEarlier) return;
      publish({ ...current, loadingEarlier: true });
      api.events(taskId, { before }, controller.signal).then(page => {
        if (!alive) return;
        const latest = active.current!;
        publish({ ...latest, events: mergeTaskEvents(latest.events, visibleNoteEvents(page.events)),
          more: page.more, beforeCursor: page.events[0]?.id ?? before });
      }).catch(() => {}).finally(() => {
        if (alive) publish({ ...active.current!, loadingEarlier: false });
      });
    };
    return () => {
      alive = false; earlier.current = null; off(); offNotes();
      clearTimeout(timer); clearTimeout(retry);
      controller.abort();
    };
  }, [taskId, since, onEvent, reload, sourceReload, note]);

  const loadEarlier = useCallback(() => earlier.current?.(), []);
  const shown = taskId == null ? undefined : history?.taskId === taskId ? history : cache.current.get(taskId);
  return { events: shown?.events ?? EMPTY_TASK_EVENTS, beforeCursor: shown?.beforeCursor,
    more: shown?.more ?? false, loadingEarlier: shown?.loadingEarlier ?? false,
    loaded: !!shown?.loaded && shown.since === since && shown.reload === reload, loadEarlier };
}
