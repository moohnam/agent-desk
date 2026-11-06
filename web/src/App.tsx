import { ArrowRight, ArrowUp, Bell, BellOff, Columns3, Cpu, Folder, Keyboard, LayoutDashboard, ListTodo, Plus, Puzzle, Settings, Smartphone, SquarePen } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from './api.ts';
import { isAsk } from './AskCard.tsx';
import { AccessDialog, AccessRequests } from './AccessDialog.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { ApprovalQueue, QUEUE_ROWS, queueItems, type QueueItem } from './ApprovalQueue.tsx';
import { ColumnFinder } from './ColumnFinder.tsx';
import { ChannelsDialog } from './Channels.tsx';
import { ChannelColumn } from './ChannelColumn.tsx';
import { ColumnDialog } from './ColumnDialog.tsx';
import { ComposeDrawer, DenyDialog, ReplyBox } from './Compose.tsx';
import { SkillsDialog } from './Skills.tsx';
import { SessionsDialog, openSessions } from './Sessions.tsx';
import { ENGINES, effortNote, modelTagsOf } from '../../shared/compose.ts';
import { stalledMinutes } from './format.ts';
import { HandoffPanel, pickable, toggleHandoff, togglePick, useHandoff } from './Handoff.tsx';
import { PostView } from './PostView.tsx';
import { pruneDrafts, useDraftTasks } from './drafts.ts';
import { DEFAULT_WIDTH, SAVE_DELAY, useColumnWidths, useColumns } from './columns.ts';
import { buildPosts, matches, placeFeed, placeThread } from './posts.ts';
import { projectColor } from './projects.ts';
import type { Approval, Channel, ColumnDef, HubEvent, PlacedPost, Post, TaskStatus, TaskView } from './types.ts';
import { useColumnFeeds, useHub, useTaskEvents } from './useHub.ts';
import { SearchHead } from './Search.tsx';
import { parseSearch, taskSearchQuery } from './search.ts';
import { ORDERED, SORT_LABEL, VIEWS, VIEW_MAX, applyOrder, defaultColumn, viewColumns, viewColumnLimit, useView, type View, type ViewSort } from './views.ts';
import { SEARCH, THREAD, firstPostBelow, isAllFilter, modelsOf, newestPerTask, observeThreadSize } from './layout.ts';
import { PHONE, isNarrow, useMedia } from './media.ts';
import { FIXED_NOTE, onDeckKey, type DeckKeyContext } from './deckKeys.ts';
import { Chip } from './badges.tsx';
import { EXTERNAL_NOTE, ExternalNote, FeedColumn, sameCtx, type ColumnActions, type ColumnCtx, type DeckColumn } from './FeedColumn.tsx';
import { ThreadHead } from './ThreadHead.tsx';
import { AUTO_ORDER, ColumnMenu } from './ColumnMenu.tsx';
import { Help } from './Help.tsx';
import { setNotify, useDeskNotifications, useNotifyState } from './notify.ts';
import { PANE_DEFAULT, PANE_MAX, PANE_MIN, ResizeHandle, SplitHandle } from './handles.tsx';

/** Typing pauses this long before the search column asks the hub again. */
const SEARCH_DEBOUNCE_MS = 250;
const VIEW_ICON = { custom: Columns3, project: Folder, task: ListTodo, status: LayoutDashboard };
/** "작업별 컬럼으로 나누기" makes at most this many columns at once. */
const SPLIT_MAX = 6;
/** On a phone there are no columns: one feed of everything, with the thread laid over it. */
const PHONE_FEED: ColumnDef = { id: 'phone', title: '전체', filter: {} };
const THREAD_WIDTH = 460;
/** Idle time after which a feed scrolled away from new posts returns to the top. */
const IDLE_RETURN_MS = 20_000;
const DRAWER_KEY = 'agent-desk.composeOpen';
/** '0': the thread opens as a column beside the others; otherwise it floats over the right half. */
const FLOAT_KEY = 'agent-desk.threadFloat';
/** Share of the workspace the split thread takes, as a percentage. */
const SPLIT_KEY = 'agent-desk.threadSplit';
/**
 * On a small workspace the split thread grows to at least PANE_MIN_PX; when that would leave the
 * deck less than DECK_MIN_PX, the thread covers the whole workspace instead.
 */
const PANE_MIN_PX = 560, DECK_MIN_PX = 420;

export function App() {
  const hub = useHub();
  const [custom, setCustom] = useColumns();
  const { view, setView, byTask: viewByTask, setByTask: setViewByTask, order: viewOrder, setOrder: setViewOrder } = useView();
  const [widths, setWidth] = useColumnWidths();
  // Index into the approval queue while it has keyboard focus (`a`).
  const [queueFocus, setQueueFocus] = useState<number | null>(null);
  const [queueAll, setQueueAll] = useState(false);
  const [threadTask, setThreadTask] = useState<string | null>(null);
  /** The thread column sits right of this column (or last, when unset or deleted). */
  const [threadAfter, setThreadAfter] = useState<string | null>(null);
  /** The post a thread opens at (top of the view); null opens at the newest post. */
  const [threadFocus, setThreadFocus] = useState<number | null>(null);
  // A new object per call, so choosing the same index again still re-renders and counts as a choice.
  const [activeState, setActiveState] = useState({ i: 0 });
  const active = activeState.i;
  /** Set when the focus is chosen; otherwise a reorder of the deck (F3 by activity) keeps it on its column. */
  const chosen = useRef(true);
  const defaultFocusPending = useRef(true);
  const setActive = (i: number) => { defaultFocusPending.current = false; chosen.current = true; setActiveState({ i }); };
  const activeId = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<number | null>(null);
  const [drawer, setDrawerState] = useState(() => {
    try { const v = localStorage.getItem(DRAWER_KEY); if (v != null) return v === '1' && !isNarrow(); } catch { /* ignore */ }
    return !isNarrow();
  });
  const [denying, setDenying] = useState<Approval | null>(null);
  const [columnDialog, setColumnDialog] = useState<{ column?: ColumnDef } | null>(null);
  const [menu, setMenu] = useState<{ colId: string; x: number; y: number } | null>(null);
  /** The column whose name is being edited in its header. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  /** `;`: the column finder. */
  const [finder, setFinder] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [phoneChannel, setPhoneChannel] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const pendingDelete = useRef(0);
  const pendingG = useRef(0);
  const jumpIndex = useRef<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  // A question whose answer box should get focus once its thread has rendered it.
  const questionFocus = useRef<string | null>(null);
  /** The search column's query; null: no search column. `searchApplied` follows it after a pause. */
  const [search, setSearch] = useState<string | null>(null);
  const [searchApplied, setSearchApplied] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setSearchApplied(search ?? ''), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Re-render periodically so relative times and stall detection stay fresh.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const drafts = useDraftTasks();
  const liveCount = useMemo(() => openSessions(hub.tasks.values()).length, [hub.tasks]);
  // Recomputed on every tick, since a task stalls without any new message.
  const stalled = useMemo(() => {
    const now = Date.now();
    return new Set([...hub.tasks.values()].filter((t) => stalledMinutes(t, now) != null).map((t) => t.id));
  }, [hub.tasks, tick]);
  // F1 is the user's columns; F2–F4 are built from the tasks and only change "작업별로 묶어 보기"
  // (and, on F2, the column order; F3 always follows recent activity).
  const editable = view === 'custom';
  const reorderable = editable || ORDERED.includes(view);
  /** Per column, its posts in all when the view opened or the "글 많은 순" sort was picked. */
  const [countSnap, setCountSnap] = useState<Record<string, number>>({});
  /** How many columns F2 and F3 show: VIEW_MAX, raised by going right past the last column (older ones). */
  const [viewLimit, setViewLimit] = useState(VIEW_MAX);
  const columns = useMemo(() => (view === 'custom' ? custom
    : applyOrder(viewColumns(view, hub.tasks, hub.projects, stalled, drafts, viewByTask, viewLimit), ORDERED.includes(view) ? viewOrder[view] : undefined, (c) =>
      (c.filter.projectIds ? hub.projects.find((p) => p.id === c.filter.projectIds![0])?.created_at
        : hub.tasks.get(c.filter.taskIds?.[0] ?? '')?.created_at) ?? '', (c) => countSnap[c.id])),
  [view, custom, hub.tasks, hub.projects, stalled, drafts, viewByTask, viewOrder, countSnap, viewLimit]);
  /** F2 projects (with tasks) or F3 tasks not shown yet: older ones. */
  const olderCols = view === 'task' ? Math.max(0, hub.tasks.size - viewLimit)
    : view === 'project' ? Math.max(0, new Set([...hub.tasks.values()].map((t) => t.project_id)).size - viewLimit) : 0;
  const setColumns: typeof setCustom = editable ? setCustom : () => setToast(FIXED_NOTE);
  const switchView = (v: View) => {
    if (v === view) return;
    setView(v);
    setCountSnap({});
    setViewLimit(VIEW_MAX);
    // The open thread belonged to the old view's columns; the new view starts without it.
    if (threadTask) { if (history.state?.thread) history.back(); else setThreadTask(null); }
    // So did the search column.
    setSearch(null); setSearchApplied('');
    setActive(0);
    defaultFocusPending.current = true;
    // A view opens at its top: no selection or kept scroll position carries over from the last visit.
    setSelection({});
    atTop.current.clear(); feedAnchor.current.clear(); seenTop.current.clear();
    const x = VIEWS.find((y) => y.id === v)!;
    setToast(`${x.key} ${x.label} 뷰`);
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (flash == null) return;
    const t = setTimeout(() => setFlash(null), 1000);
    return () => clearTimeout(t);
  }, [flash]);

  const setDrawer = (open: boolean) => {
    setDrawerState(open);
    try { localStorage.setItem(DRAWER_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  };
  const openDrawer = () => {
    setDrawer(true);
    requestAnimationFrame(() => composeRef.current?.focus());
  };

  const { events: threadEvents, loaded: threadLoaded, more: threadMore, loadingEarlier: threadLoadingEarlier, loadEarlier }
    = useTaskEvents(threadTask, hub.onEvent, threadFocus ?? undefined);
  const threadPosts = useMemo(() => buildPosts(threadEvents), [threadEvents]);
  /** The thread task's context reset (컨텍스트 재구성), if one is being prepared; never for terminal tasks. */
  const handoff = useHandoff(threadTask && hub.tasks.get(threadTask)?.source === 'app' ? threadTask : null);
  const phone = useMedia(PHONE);
  // Search metadata for every column, without fetching the hidden columns' feeds.
  const finderColumns = useMemo(() => {
    if (phone) return phoneChannel ? [{ id: `phone-channel:${phoneChannel}`, title: hub.channels.get(phoneChannel)?.name ?? '채널', channelId: phoneChannel, filter: {} }] : [PHONE_FEED];
    if (!finder || (view !== 'project' && view !== 'task')) return columns;
    const shown = new Set(columns.map((c) => c.id));
    return [...columns, ...viewColumns(view, hub.tasks, hub.projects, stalled, drafts, viewByTask, Infinity)
      .filter((c) => !shown.has(c.id))];
  }, [finder, phone, phoneChannel, hub.channels, columns, view, hub.tasks, hub.projects, stalled, drafts, viewByTask]);
  /** One list per hub update, so the boxes given it keep their memoized suggestions between renders. */
  const taskList = useMemo(() => [...hub.tasks.values()], [hub.tasks]);
  // The thread as a panel on the right half of the workspace, next to a narrower deck, instead of a column.
  const [floatPref, setFloatPref] = useState(() => { try { return localStorage.getItem(FLOAT_KEY) !== '0'; } catch { return true; } });
  /**
   * The thread's selected post and its offset from the feed's top across a float switch: the
   * thread is drawn anew elsewhere, and it should come back showing the same post at the same place.
   */
  const floatAnchor = useRef<{ id: number; top: number } | null>(null);
  const [split, setSplit] = useState(() => {
    const v = Number((() => { try { return localStorage.getItem(SPLIT_KEY); } catch { return null; } })());
    return v >= PANE_MIN && v <= PANE_MAX ? v : PANE_DEFAULT;
  });
  const resizeSplit = (pct: number | null) => setSplit(pct ?? PANE_DEFAULT);
  // Saved once a drag settles, not on every pointer move; the default is stored as no value.
  useEffect(() => {
    const t = setTimeout(() => {
      try { if (split === PANE_DEFAULT) localStorage.removeItem(SPLIT_KEY); else localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* ignore */ }
    }, SAVE_DELAY);
    return () => clearTimeout(t);
  }, [split]);
  const toggleFloat = () => {
    const id = selection[THREAD];
    const feed = threadFeed();
    const el = id != null ? feed?.querySelector(`[data-post="${id}"]`) : null;
    floatAnchor.current = id != null ? { id, top: el && feed ? el.getBoundingClientRect().top - feed.getBoundingClientRect().top : 0 } : null;
    try { localStorage.setItem(FLOAT_KEY, floatPref ? '0' : '1'); } catch { /* ignore */ }
    setToast(floatPref ? '스레드를 컬럼으로 보기' : '스레드를 오른쪽 절반에 보기');
    setFloatPref(!floatPref);
  };
  const floatThread = floatPref && !phone && !!threadTask;
  const parsedSearch = useMemo(() => parseSearch(searchApplied, hub.projects, hub.tasks.values()),
    [searchApplied, hub.projects, hub.tasks]);
  const deckDefs = useMemo(() => {
    if (phone) return phoneChannel ? [{ id: `phone-channel:${phoneChannel}`, title: hub.channels.get(phoneChannel)?.name ?? '채널', channelId: phoneChannel, filter: {} }] : [PHONE_FEED];
    if (search == null) return columns;
    const k = columns.findIndex((c) => !c.channelId && isAllFilter(c.filter));
    const next = [...columns];
    next.splice(k + 1, 0, { id: SEARCH, title: '검색', filter: parsedSearch.filter });
    return next;
  }, [phone, phoneChannel, hub.channels, columns, search != null, parsedSearch]);
  // Each feed column loads its own events, filtered by the hub, so older history is a page away.
  // An empty search shows a hint, not a second copy of everything.
  const searching = !!searchApplied.trim();
  const feedDefs = useMemo(() => (searching ? deckDefs : deckDefs.filter((c) => c.id !== SEARCH)), [deckDefs, searching]);
  // Every view's columns: their loaded events stay while any of them uses the query.
  const keptDefs = () => [...custom, ...(['project', 'task', 'status'] as const)
    .flatMap((v) => viewColumns(v, hub.tasks, hub.projects, stalled, drafts, viewByTask))];
  const { feeds, loadEarlier: loadEarlierColumn } = useColumnFeeds(feedDefs, keptDefs, hub.tasks, hub.onEvent, hub.synced, hub.gone);
  // "글 많은 순": a column takes its place by its first count, and keeps it until the view opens again.
  useEffect(() => {
    if (viewOrder[view] !== 'count') return;
    const add: Record<string, number> = {};
    for (const c of columns) {
      const t = feeds.get(c.id)?.total;
      if (t && countSnap[c.id] == null) add[c.id] = t.posts;
    }
    if (Object.keys(add).length) setCountSnap((s) => ({ ...s, ...add }));
  }, [feeds, columns, view, viewOrder]);
  const postsCache = useRef(new WeakMap<HubEvent[], Post[]>());
  const columnPosts = useMemo(() => new Map([...feeds].map(([id, f]) => {
    let posts = postsCache.current.get(f.events);
    if (!posts) postsCache.current.set(f.events, posts = buildPosts(f.events).reverse());
    return [id, posts];
  })), [feeds]);
  const models = useMemo(() => modelsOf(hub.events, threadEvents, ...[...feeds.values()].map((f) => f.events)),
    [hub.events, threadEvents, feeds]);
  const projectsById = useMemo(() => new Map(hub.projects.map((p) => [p.id, p])), [hub.projects]);

  // The newest post of a running task shows a "working" marker.
  const working = useMemo(() => {
    const last = new Map<string, number>();
    for (const posts of [...columnPosts.values(), threadPosts]) {
      for (const p of posts) last.set(p.taskId, Math.max(p.id, last.get(p.taskId) ?? 0));
    }
    return new Set([...last].filter(([t]) => hub.tasks.get(t)?.status === 'running').map(([, id]) => id));
  }, [columnPosts, threadPosts, hub.tasks]);

  /** Deck index of the thread column when it sits right of column `after`. */
  const threadSlot = (after: string | null) => {
    if (phone) return 1;
    const k = deckDefs.findIndex((c) => c.id === after);
    return k < 0 ? deckDefs.length : k + 1;
  };
  const lastDeck = useRef(new Map<string, DeckColumn>());
  const deck: DeckColumn[] = useMemo(() => {
    const column = (id: string, placed: PlacedPost[], def?: ColumnDef): DeckColumn => {
      // The same posts under the same filter: the same object, so the column is not drawn again.
      const old = lastDeck.current.get(id);
      if (old && old.placed.length === placed.length
        && placed.every((x, k) => x.post === old.placed[k].post && x.up === old.placed[k].up && x.down === old.placed[k].down)
        && (old.def === def || JSON.stringify(old.def) === JSON.stringify(def))) return old;
      return { id, def, placed, posts: placed.map((x) => x.post) };
    };
    const cols = deckDefs.map((c) => {
      const posts = (c.channelId ? [] : columnPosts.get(c.id) ?? []).filter((p) => matches(c.filter, p, hub.tasks.get(p.taskId)));
      return column(c.id, c.byTask ? newestPerTask(posts) : placeFeed(posts), c);
    });
    if (threadTask) cols.splice(threadSlot(threadAfter), 0, column(THREAD, placeThread(threadPosts)));
    lastDeck.current = new Map(cols.map((c) => [c.id, c]));
    return cols;
  }, [deckDefs, columnPosts, hub.tasks, threadTask, threadPosts, threadAfter]);

  // Feed columns follow new posts only while scrolled to the top; further down, the reading
  // position stays put and a "새 글 N개" button counts the posts that arrived above it.
  const atTop = useRef(new Map<string, boolean>());
  const seenTop = useRef(new Map<string, number>());
  const [unseen, setUnseen] = useState<Record<string, number>>({});
  /**
   * Per feed column scrolled away from the top: the first post in view and its offset from the
   * feed's top. Posts arriving above it are pushed out of view instead of pushing it down; done
   * here rather than by the browser's scroll anchoring, which WebKit (the desktop app) lacks.
   */
  const feedAnchor = useRef(new Map<string, { id: number; top: number }>());
  const markAnchor = (colId: string, feed: HTMLElement) => {
    const feedTop = feed.getBoundingClientRect().top;
    const el = firstPostBelow(feed, feedTop);
    if (el) feedAnchor.current.set(colId, { id: Number(el.dataset.post), top: el.getBoundingClientRect().top - feedTop });
    else feedAnchor.current.delete(colId);
  };
  // Layout effect: runs before the browser's scroll anchoring reports the insert as a scroll.
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    for (const col of deck) {
      const top = col.posts[0]?.id;
      if (col.id === THREAD || top == null) continue;
      const seen = seenTop.current.get(col.id);
      const anchor = atTop.current.get(col.id) === false ? feedAnchor.current.get(col.id) : undefined;
      if (anchor) {
        const feed = document.querySelector<HTMLElement>(`section[data-col="${col.id}"] .feed`);
        const el = feed?.querySelector<HTMLElement>(`[data-post="${anchor.id}"]`);
        if (feed && el) {
          const moved = el.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.top;
          if (Math.abs(moved) >= 1) feed.scrollTop += moved;
        }
      }
      if (seen == null || atTop.current.get(col.id) !== false) {
        seenTop.current.set(col.id, top);
        const feed = document.querySelector(`section[data-col="${col.id}"] .feed`);
        if (feed && seen != null && top !== seen) feed.scrollTop = 0;
        continue;
      }
      const n = col.posts.findIndex((p) => p.id <= seen);
      if (n !== 0) next[col.id] = n < 0 ? col.posts.length : n;
    }
    setUnseen((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [deck]);
  // Older posts (drawn or loaded as a feed nears its bottom) are FeedColumn's.
  const onFeedScroll = (colId: string, feed: HTMLElement) => {
    const top = feed.scrollTop < 40;
    atTop.current.set(colId, top);
    if (!top) { markAnchor(colId, feed); return; }
    feedAnchor.current.delete(colId);
    const first = deck.find((c) => c.id === colId)?.posts[0];
    if (first) seenTop.current.set(colId, first.id);
    setUnseen(({ [colId]: _, ...rest }) => rest);
  };
  // After a while without input, a feed that new posts arrived above returns to the top and follows
  // them again. The mouse resting over a column does not hold it: on a desktop it nearly always does.
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const mark = () => { lastInput.current = Date.now(); };
    const kinds = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;
    for (const k of kinds) window.addEventListener(k, mark, { capture: true, passive: true });
    return () => { for (const k of kinds) window.removeEventListener(k, mark, { capture: true }); };
  }, []);
  useEffect(() => {
    const ids = Object.keys(unseen);
    if (!ids.length) return;
    const t = setInterval(() => {
      if (Date.now() - lastInput.current < IDLE_RETURN_MS) return;
      for (const id of ids) {
        document.querySelector(`section[data-col="${id}"] .feed`)?.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [unseen]);
  /** Jumps a feed column to its newest post. */
  const showNewest = (colId: string) => {
    const first = deck.find((c) => c.id === colId)?.posts[0];
    if (first) select(colId, first.id);
    document.querySelector(`section[data-col="${colId}"] .feed`)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeIdx = Math.min(active, deck.length - 1);
  const activeCol = deck[activeIdx] as DeckColumn | undefined;
  // The focus follows its column when the columns move under it; a choice of column takes its place.
  useLayoutEffect(() => {
    if (!chosen.current) {
      const at = deck.findIndex((c) => c.id === activeId.current);
      if (at >= 0 && at !== activeIdx) { setActiveState({ i: at }); return; }
    }
    chosen.current = false;
    activeId.current = deck[activeIdx]?.id;
  }, [deck, activeState]);
  useLayoutEffect(() => {
    if (!defaultFocusPending.current || !hub.synced) return;
    const id = defaultColumn(deck.filter((column) => column.def && column.id !== SEARCH).map((column) => column.def?.channelId
      ? { id: column.id, posts: hub.channels.get(column.def.channelId)?.latest_entry_id ? [{}] : [] } : column), (id) => {
      if (deck.find((column) => column.id === id)?.def?.channelId) return true;
      const feed = feeds.get(id);
      return !!feed && !feed.loading && !feed.more;
    });
    if (id === undefined) return;
    defaultFocusPending.current = false;
    const at = deck.findIndex((column) => column.id === id);
    if (at >= 0) setActive(at);
  }, [hub.synced, deck, feeds, hub.channels]);
  const selectedPost = activeCol?.posts.find((p) => p.id === selection[activeCol.id]);

  const queue = useMemo(() => queueItems(hub.approvals.values(), hub.questions.values(), hub.tasks.values()), [hub.approvals, hub.questions, hub.tasks]);
  // Keep the queue focus on a valid row as approvals are resolved.
  useEffect(() => {
    if (queueFocus == null) return;
    if (!queue.length) setQueueFocus(null);
    else if (queueFocus >= queue.length) setQueueFocus(queue.length - 1);
    else if (queueFocus >= QUEUE_ROWS) setQueueAll(true);
  }, [queue, queueFocus]);
  const counts = useMemo(() => {
    const c = { running: 0, error: 0 };
    for (const t of hub.tasks.values()) if (t.status === 'running' || t.status === 'error') c[t.status]++;
    return c;
  }, [hub.tasks]);
  // Drafts outlive nothing they belong to: a deleted task, or a question answered elsewhere.
  useEffect(() => {
    if (!hub.synced) return;
    pruneDrafts((k, d) => (!d.taskId || hub.tasks.has(d.taskId))
      && (!k.startsWith('question:') || hub.questions.has(k.slice('question:'.length)))
      && (!k.startsWith('ask:') || hub.approvals.has(k.slice('ask:'.length))));
    pruneDrafts((k) => !k.startsWith('channel-chat:') && !k.startsWith('channel-sources:') || hub.channels.has(k.slice(k.indexOf(':') + 1)));
  }, [hub.synced, hub.tasks, hub.questions, hub.approvals, hub.channels]);

  const widthOf = (id: string) => widths[id] ?? (id === THREAD ? THREAD_WIDTH : DEFAULT_WIDTH);

  const deckRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  /** The workspace's width left for the deck and the split thread (the compose drawer's taken out). */
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const measure = () => setWorkspaceWidth(el.clientWidth - (el.querySelector<HTMLElement>(':scope > .compose')?.offsetWidth ?? 0));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawer]);
  const paneWidth = Math.max(Math.round(workspaceWidth * split / 100), PANE_MIN_PX);
  const paneCover = workspaceWidth - paneWidth < DECK_MIN_PX;
  /**
   * Glides the deck sideways just enough to show column `id` whole, and the column before it too
   * when both fit (a thread next to the column it was opened from). No movement if already shown.
   */
  const revealColumn = (id: string, keep?: string) => {
    if (phone) return;
    const deckEl = deckRef.current;
    const el = deckEl?.querySelector<HTMLElement>(`section[data-col="${id}"]`);
    if (!deckEl || !el) return;
    // Layout positions (the deck is the offsetParent), unaffected by the thread's entrance transform.
    const x = (e: HTMLElement) => e.offsetLeft;
    const pad = 8;
    const left = x(el) - pad;
    const right = x(el) + el.offsetWidth + pad;
    const keepEl = keep ? deckEl.querySelector<HTMLElement>(`section[data-col="${keep}"]`) : null;
    const start = keepEl && right - (x(keepEl) - pad) <= deckEl.clientWidth ? x(keepEl) - pad : left;
    const view = deckEl.scrollLeft;
    const target = start < view ? start : right > view + deckEl.clientWidth ? Math.min(right - deckEl.clientWidth, left) : view;
    if (Math.abs(target - view) > 1) glide(deckEl, target);
  };
  const glideStop = useRef<(() => void) | null>(null);
  /**
   * Scrolls the deck to `to` with an ease-out. Unlike behavior: 'smooth', each frame advances at most
   * one frame's worth, so a long render (opening a big thread) pauses the motion instead of jumping.
   * Wheel or pointer input takes over at once.
   */
  const glide = (deckEl: HTMLElement, to: number) => {
    glideStop.current?.();
    const from = deckEl.scrollLeft;
    const DURATION = 280;
    let t = 0;
    let last = performance.now();
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      deckEl.removeEventListener('wheel', stop);
      deckEl.removeEventListener('pointerdown', stop);
      deckEl.style.scrollSnapType = '';
      if (glideStop.current === stop) glideStop.current = null;
    };
    // Mandatory snapping (narrow screens) would pull every frame back to a column edge.
    deckEl.style.scrollSnapType = 'none';
    const step = (now: number) => {
      t = Math.min(DURATION, t + Math.min(now - last, 20));
      last = now;
      const k = 1 - (1 - t / DURATION) ** 3;
      deckEl.scrollLeft = from + (to - from) * k;
      if (t < DURATION) raf = requestAnimationFrame(step);
      else stop();
    };
    deckEl.addEventListener('wheel', stop, { passive: true });
    deckEl.addEventListener('pointerdown', stop);
    glideStop.current = stop;
    raf = requestAnimationFrame(step);
  };
  /**
   * Scrolls a column's feed (only it, not the deck) to show a post, with its group's head line
   * (project and task) too when both fit on screen. The post's top always shows: a post taller
   * than the feed lands at its top, not its bottom.
   */
  const revealPost = (colId: string, postId: number) => {
    const feed = document.querySelector(`section[data-col="${colId}"] .feed`);
    const el = feed?.querySelector(`[data-post="${postId}"]`);
    if (!feed || !el) return;
    const at = feed.getBoundingClientRect().top;
    const box = el.getBoundingClientRect();
    const elTop = box.top - at, bottom = box.bottom - at;
    // Thread posts have no group head line; then the post's own top is the line to show.
    const head = el.closest('.group')?.querySelector(':scope > .ctx');
    const headTop = head ? head.getBoundingClientRect().top - at : elTop;
    const top = bottom - headTop <= feed.clientHeight ? headTop : elTop;
    if (top < 0) feed.scrollTop += top;
    else if (bottom > feed.clientHeight) feed.scrollTop += Math.min(top, bottom - feed.clientHeight);
  };
  /** The post shows at least partly in its column's feed. */
  const postInView = (colId: string, postId: number) => {
    const feed = document.querySelector(`section[data-col="${colId}"] .feed`);
    const el = feed?.querySelector(`[data-post="${postId}"]`);
    if (!feed || !el) return false;
    const f = feed.getBoundingClientRect(), box = el.getBoundingClientRect();
    return box.bottom > f.top && box.top < f.bottom;
  };
  /** The first post whose top shows in the column's feed (else the first showing at all). */
  const topPostInView = (colId: string): number | null => {
    const feed = document.querySelector(`section[data-col="${colId}"] .feed`);
    if (!feed) return null;
    const f = feed.getBoundingClientRect();
    let partly: number | null = null;
    for (const el of feed.querySelectorAll<HTMLElement>('[data-post]')) {
      const box = el.getBoundingClientRect();
      if (box.bottom <= f.top) continue;
      if (box.top >= f.bottom) break;
      if (box.top >= f.top) return Number(el.dataset.post);
      partly ??= Number(el.dataset.post);
    }
    return partly;
  };
  // Pressed into a column with the pointer: its feed must not jump to an older selection under the
  // press, or the release lands on another post and the click is lost.
  const pressing = useRef(false);
  const press = () => {
    pressing.current = true;
    window.addEventListener('pointerup', () => { pressing.current = false; }, { once: true });
  };
  useLayoutEffect(() => {
    deckRef.current?.scrollTo({ left: 0 });
    for (const f of deckRef.current?.querySelectorAll<HTMLElement>('section[data-col] .feed') ?? []) f.scrollTop = 0;
  }, [view]);
  // Keep the selected post (or column) visible. Coming into a column whose post selected last is out
  // of view (scrolled away from, or pushed down by new posts), the post at the top of its view is
  // selected instead: the feed stays where the user left it.
  const revealedCol = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeCol) return;
    const entered = revealedCol.current !== activeCol.id;
    revealedCol.current = activeCol.id;
    // The split thread is always in view; the deck beside it stays where it is.
    if (!(floatThread && activeCol.id === THREAD)) revealColumn(activeCol.id, activeCol.id === THREAD ? deck[activeIdx - 1]?.id : undefined);
    const id = selection[activeCol.id];
    if (id == null || pressing.current) return;
    if (entered && activeCol.id !== THREAD) {
      const top = postInView(activeCol.id, id) ? id : topPostInView(activeCol.id);
      if (top != null && top !== id) { select(activeCol.id, top); return; }
    }
    revealPost(activeCol.id, id);
  }, [activeCol?.id, selection]);
  // The thread column eases in where it opens (or moves to) rather than popping up.
  const threadAt = threadTask ? threadSlot(threadAfter) : null;
  useLayoutEffect(() => {
    if (threadAt == null) return;
    deckRef.current?.querySelector(`section[data-col="${THREAD}"]`)?.animate(
      [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'ease-out' });
  }, [threadAt]);

  const select = (colId: string, postId: number) => setSelection((s) => ({ ...s, [colId]: postId }));
  const focusColumn = (i: number) => setActive(Math.max(0, Math.min(i, deck.length - 1)));
  /** The deck column focused last, for t and h/l to come back to from the thread. */
  const lastDeckCol = useRef<string | undefined>(undefined);
  useEffect(() => { if (activeCol && activeCol.id !== THREAD) lastDeckCol.current = activeCol.id; }, [activeCol?.id]);
  const backToDeck = () => {
    const at = deck.findIndex((c) => c.id === lastDeckCol.current);
    focusColumn(at >= 0 ? at : deck.findIndex((c) => c.id !== THREAD));
  };
  /**
   * h/l: the next column that way; on the status board (F4), empty columns are passed over. The
   * split thread is beside the deck, not in it: h/l pass it over, and from it they go back to the deck.
   */
  /** Columns h/l pass over: empty status columns, and the thread while it sits beside the deck. */
  const skipColumn = (c: DeckColumn) => (view === 'status' && c.id.startsWith('v:s:') && c.posts.length === 0)
    || (floatThread && c.id === THREAD);
  const stepColumn = (dir: -1 | 1) => {
    if (floatThread && activeCol?.id === THREAD) return backToDeck();
    for (let i = activeIdx + dir; i >= 0 && i < deck.length; i += dir) if (!skipColumn(deck[i])) return focusColumn(i);
    // Past F2's or F3's last column: older ones come in, and the focus moves on to the first of them.
    if (dir === 1 && olderCols > 0) showOlder(activeIdx + 1);
  };
  /** gh / gl: the deck's first or last column (the columns shown; F2/F3 load no older ones). */
  const edgeColumn = (dir: -1 | 1) => {
    const order = deck.map((_, i) => (dir === -1 ? i : deck.length - 1 - i));
    const i = order.find((k) => !skipColumn(deck[k]));
    if (i != null) focusColumn(i);
  };
  const focusAfterMore = useRef<number | null>(null);
  const showOlder = (focusAt?: number) => {
    focusAfterMore.current = focusAt ?? null;
    setViewLimit((n) => n + VIEW_MAX);
  };
  useEffect(() => {
    if (focusAfterMore.current == null) return;
    focusColumn(focusAfterMore.current);
    focusAfterMore.current = null;
  }, [viewLimit]);
  /** t: to the open thread, and from it back to the column focused before. */
  const toggleThreadFocus = () => {
    if (!threadTask) return setToast('열린 스레드가 없습니다.');
    if (activeCol?.id === THREAD) backToDeck();
    else focusColumn(deck.findIndex((c) => c.id === THREAD));
  };
  const toggleExpanded = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const notifyState = useNotifyState();
  useDeskNotifications(hub, (taskId) => openThread(taskId));
  /**
   * Opens a task's thread. `from`: the column it was opened from; the thread column moves right of
   * it (otherwise it stays where it is). `post`: start reading at that post's top; otherwise the
   * thread lands on its newest post. Reopening the open thread lands again.
   */
  const openThread = (taskId: string, at: { from?: string; post?: number } = {}) => {
    const after = at.from && at.from !== THREAD ? at.from : threadAfter;
    if (threadTask !== taskId) setThreadTask(taskId);
    setThreadAfter(after);
    setThreadFocus(at.post ?? null);
    setSelection((s) => { const { [THREAD]: _, ...rest } = s; return rest; });
    setActive(threadSlot(after));
    // On a phone the thread fills the screen, so the system back gesture should close it.
    if (phone && !history.state?.thread) history.pushState({ thread: true }, '');
  };
  const dropThread = () => {
    setThreadTask(null);
    if (activeCol?.id === THREAD) setActive(Math.max(threadSlot(threadAfter) - 1, 0));
  };
  const closeThread = () => (history.state?.thread ? history.back() : dropThread());
  // The thread's task was deleted (here or in another window).
  useEffect(() => { if (threadTask && hub.gone.has(threadTask)) closeThread(); }, [hub.gone]);
  /** Deletes a task or a project for good (the menu asks twice first). */
  const remove = (what: 'task' | 'project', id: string) => {
    (what === 'task' ? api.deleteTask(id) : api.deleteProject(id))
      .then(() => setToast(what === 'task' ? '작업을 삭제했습니다' : '프로젝트를 삭제했습니다'))
      .catch((e) => setToast(`삭제하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** What the ⋯ menu of a column can delete: the thread's or a task column's task, a project column's project. */
  const removable = (colId: string): { label: string; onRemove: () => void } | undefined => {
    const taskId = colId === THREAD ? threadTask : colId.startsWith('v:t:') ? colId.slice(4) : null;
    const task = taskId ? hub.tasks.get(taskId) : undefined;
    if (task) return { label: `작업 삭제 (${task.project_name}#${task.seq})`, onRemove: () => remove('task', task.id) };
    const project = colId.startsWith('v:p:') ? hub.projects.find((p) => p.id === colId.slice(4)) : undefined;
    if (!project) return undefined;
    const n = [...hub.tasks.values()].filter((t) => t.project_id === project.id).length;
    return { label: `프로젝트 삭제 (@${project.name}, 작업 ${n}개)`, onRemove: () => remove('project', project.id) };
  };
  const dropThreadRef = useRef(dropThread);
  dropThreadRef.current = dropThread;
  useEffect(() => {
    const onPop = () => { if (!history.state?.thread) dropThreadRef.current(); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  // When a thread opens, select the post it opens at (else its newest) and scroll there: that post's
  // top at the top, or the bottom when the newest post fits. Right after switching tasks the posts
  // still belong to the previous thread until the new events load; wait.
  useEffect(() => {
    if (!threadTask || selection[THREAD] != null) return;
    const last = threadPosts[threadPosts.length - 1];
    if (!last || last.taskId !== threadTask) return;
    const target = threadFocus != null ? threadPosts.find((p) => p.id === threadFocus) : undefined;
    // A live event can arrive before the history that holds the post to open at; wait for it.
    if (threadFocus != null && !target && !threadLoaded) return;
    select(THREAD, (target ?? last).id);
    requestAnimationFrame(() => {
      const feed = document.querySelector(`section[data-col="${THREAD}"] .feed`);
      if (!feed) return;
      const el = feed.querySelector(`[data-post="${(target ?? last).id}"]`);
      const top = el ? feed.scrollTop + el.getBoundingClientRect().top - feed.getBoundingClientRect().top : Infinity;
      feed.scrollTop = target ? top : Math.min(top, feed.scrollHeight);
      // Decided here, not by the scroll event that follows: the bottom-sticking below (a new event, the
      // resize observer's first call) would otherwise pull the thread off the post it just opened at.
      threadAtBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    });
  }, [threadTask, threadPosts, selection, threadFocus, threadLoaded]);

  // The thread sticks to its bottom while scrolled there (new posts, a growing reply box), and
  // jumps there after the user sends from it; the own message gets selected when it arrives.
  const threadAtBottom = useRef(true);
  const sentFrom = useRef<number | null>(null);
  const threadFeed = () => document.querySelector<HTMLElement>(`section[data-col="${THREAD}"] .feed`);
  const stickThread = () => {
    const feed = threadFeed();
    if (feed && threadAtBottom.current) feed.scrollTop = feed.scrollHeight;
  };
  /**
   * While earlier history loads, the post read at the top of the thread and its offset from the
   * feed's top: the older posts go in above it without moving it. `first`: the oldest post then.
   */
  const threadAnchor = useRef<{ id: number; top: number; first: number } | null>(null);
  const loadEarlierThread = () => {
    const feed = threadFeed();
    if (!feed) return;
    if (!threadPosts.length) return loadEarlier();
    const feedTop = feed.getBoundingClientRect().top;
    const el = firstPostBelow(feed, feedTop);
    if (el) threadAnchor.current = { id: Number(el.dataset.post), top: el.getBoundingClientRect().top - feedTop, first: threadPosts[0].id };
    loadEarlier();
  };
  useEffect(() => { threadAtBottom.current = true; sentFrom.current = null; threadAnchor.current = null; }, [threadTask]);
  // The newest page can be all tool calls (a long agent turn): go back until there is a post to show.
  // Once per page, so a failing request leaves the button instead of retrying forever.
  const autoEarlier = useRef<number | null>(null);
  useEffect(() => {
    const oldest = threadEvents[0]?.id ?? null;
    if (!threadLoaded || threadPosts.length || !threadMore || threadLoadingEarlier || autoEarlier.current === oldest) return;
    autoEarlier.current = oldest;
    loadEarlier();
  }, [threadLoaded, threadEvents, threadPosts, threadMore, threadLoadingEarlier, loadEarlier]);
  // A page that brought no older posts (or failed) has nothing to hold in place.
  useEffect(() => { if (!threadLoadingEarlier) threadAnchor.current = null; }, [threadLoadingEarlier]);
  /** Puts the anchored post back where it was read; false when the thread should stick to its bottom. */
  const holdThreadAnchor = () => {
    const anchor = threadAnchor.current;
    const feed = threadFeed();
    const el = anchor && feed?.querySelector<HTMLElement>(`[data-post="${anchor.id}"]`);
    if (!anchor || !feed || !el) return false;
    feed.scrollTop += el.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.top;
    // Live posts arriving meanwhile land below; only the earlier page ends the hold.
    if (threadPosts[0] && threadPosts[0].id < anchor.first) threadAnchor.current = null;
    threadAtBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    return !threadAtBottom.current;
  };
  useLayoutEffect(() => {
    // Until the open effect has landed, the thread is where that effect puts it.
    if (selection[THREAD] == null) return;
    const last = threadPosts[threadPosts.length - 1];
    if (sentFrom.current != null && last && last.id > sentFrom.current && last.kind === 'user') {
      sentFrom.current = null;
      threadAnchor.current = null;
      threadAtBottom.current = true;
      select(THREAD, last.id);
    }
    if (!holdThreadAnchor()) stickThread();
  }, [threadPosts]);
  useEffect(() => {
    const feed = threadFeed();
    if (!feed) return;
    return observeThreadSize(feed, stickThread);
  }, [threadTask, threadAt, floatThread]);
  useLayoutEffect(() => {
    const anchor = floatAnchor.current;
    floatAnchor.current = null;
    const feed = threadFeed();
    const el = anchor && feed?.querySelector(`[data-post="${anchor.id}"]`);
    if (!anchor || !feed || !el) return;
    // A narrower or wider thread rewraps the posts; keep at least the post's top in view.
    const top = Math.max(0, Math.min(anchor.top, feed.clientHeight - 40));
    feed.scrollTop += el.getBoundingClientRect().top - feed.getBoundingClientRect().top - top;
    threadAtBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  }, [floatThread]);
  const onThreadSend = () => {
    sentFrom.current = threadPosts[threadPosts.length - 1]?.id ?? 0;
    threadAtBottom.current = true;
    stickThread();
  };

  /** Focuses the pending answer box, if the thread has rendered it yet. */
  const tryFocusQuestion = () => {
    const id = questionFocus.current;
    const el = id && document.querySelector<HTMLElement>(`section[data-col="${THREAD}"] [data-question="${id}"]`);
    if (!el) return;
    questionFocus.current = null;
    el.scrollIntoView({ block: 'nearest' });
    el.focus();
  };
  useEffect(() => { requestAnimationFrame(tryFocusQuestion); }, [threadPosts]);
  /** Opens the task's thread with the cursor in that question's answer box (or first option). */
  const answerQuestion = (taskId: string, questionId: string) => {
    setQueueFocus(null);
    openThread(taskId);
    questionFocus.current = questionId;
    requestAnimationFrame(() => requestAnimationFrame(tryFocusQuestion));
  };
  /** The task's oldest unanswered question. */
  const questionOf = (taskId: string) => queue.find((x) => x.kind === 'question' && x.task_id === taskId)?.id;

  /**
   * `r`: open the task's thread and put the cursor in its reply box (a terminal task: its question's box).
   * `from`: the column the post was picked in, so the thread opens beside it.
   */
  const replyTo = (taskId: string, from?: string) => {
    if (hub.tasks.get(taskId)?.source === 'external') {
      const q = questionOf(taskId);
      if (q) answerQuestion(taskId, q);
      else setToast(EXTERNAL_NOTE);
      return;
    }
    openThread(taskId, { from });
    // The reply box mounts with the thread column; wait a frame for it.
    requestAnimationFrame(() => requestAnimationFrame(() => replyRef.current?.focus()));
  };

  const fail = (err: unknown) => setToast(err instanceof Error ? err.message : String(err));
  // An agent's question can't be approved blindly: `y` takes the user to its options instead.
  const allow = (a: Approval) => {
    if (isAsk(a.tool_name)) answerQuestion(a.task_id, a.id);
    else api.resolve(a.id, true).catch(fail);
  };
  const openQueueItem = (item: QueueItem) => {
    // A Codex async question: answered by a reply in its thread.
    if (item.kind === 'ask') { setQueueFocus(null); replyTo(item.task_id); }
    else if (item.kind === 'question' || isAsk(item.approval.tool_name)) answerQuestion(item.task_id, item.id);
    else { setQueueFocus(null); openThread(item.task_id); }
  };
  /** The approval a post refers to: its own if it is a request, else its task's oldest pending one. */
  const approvalFor = (post: Post | undefined) => {
    if (!post) return undefined;
    if (post.kind === 'approval') return hub.approvals.get(post.event.payload.approvalId);
    const item = queue.find((x) => x.kind === 'approval' && x.task_id === post.taskId);
    return item?.kind === 'approval' ? item.approval : undefined;
  };

  /** Topbar chips: cycle through matching tasks and show each one's newest post. */
  /** Per column, the newest post of each task holding a draft: where "작성 중" shows. */
  const draftPosts = useMemo(() => {
    const out = new Set<string>();
    if (!drafts.size) return out;
    for (const col of deck) {
      if (col.id === THREAD) continue;
      const seen = new Set<string>();
      for (const p of col.posts) {
        if (drafts.has(p.taskId) && !seen.has(p.taskId)) { seen.add(p.taskId); out.add(`${col.id}:${p.id}`); }
      }
    }
    return out;
  }, [deck, drafts]);
  /** "작성 중": opens the threads holding an unsent reply in turn, with the cursor in the reply box. */
  const jumpDraft = () => {
    const list = [...drafts].filter((id) => hub.tasks.has(id))
      .sort((a, b) => hub.tasks.get(b)!.updated_at.localeCompare(hub.tasks.get(a)!.updated_at));
    if (!list.length) return;
    const i = (jumpIndex.current.draft ?? -1) + 1;
    jumpIndex.current.draft = i;
    replyTo(list[i % list.length], activeCol?.id);
  };
  const jumpTo = (key: TaskStatus | 'stalled') => {
    const hit = (t: TaskView) => (key === 'stalled' ? stalled.has(t.id) : t.status === key);
    const list = [...hub.tasks.values()].filter(hit).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (!list.length) return;
    const i = (jumpIndex.current[key] ?? -1) + 1;
    jumpIndex.current[key] = i;
    const task = list[i % list.length];
    const order = [activeIdx, ...deck.map((_, k) => k).filter((k) => k !== activeIdx)];
    for (const k of order) {
      const col = deck[k];
      if (col.id === THREAD) continue;
      const newest = col.posts.filter((p) => p.taskId === task.id).sort((a, b) => b.id - a.id)[0];
      if (newest) { setActive(k); select(col.id, newest.id); setFlash(newest.id); return; }
    }
    openThread(task.id);
  };

  /** `from` is a deck index; the thread column, wherever it sits, is not one of `columns`. */
  const moveColumn = (from: number, dir: -1 | 1) => {
    const id = deck[from]?.def?.id;
    const k = columns.findIndex((c) => c.id === id);
    const to = k + dir;
    if (k < 0 || to < 0 || to >= columns.length) return;
    const next = [...columns];
    [next[k], next[to]] = [next[to], next[k]];
    if (editable) setColumns(next);
    // A built view keeps the order it is left in; new projects and tasks still come in automatically.
    else if (reorderable) setViewOrder((o) => ({ ...o, [view]: next.map((c) => c.id) }));
    else { setToast(FIXED_NOTE); return; }
    setFocusCol(id!);
  };
  /** `null`: back to the view's own order, dropping a sort picked or columns moved. */
  const sortColumns = (sort: ViewSort | null) => {
    setViewOrder((o) => { const next = { ...o }; if (sort) next[view] = sort; else delete next[view]; return next; });
    setCountSnap({});
    setToast(`${VIEWS.find((x) => x.id === view)!.label} 뷰: ${sort ? `${SORT_LABEL[sort]} 정렬` : `자동 순서 (${AUTO_ORDER[view] ?? '기본'})`}`);
  };
  /**
   * Shows a task as its own feed column (`p`), right of the column it is viewed from, or focuses
   * the column that already shows it.
   */
  const [focusCol, setFocusCol] = useState<string | null>(null);
  useEffect(() => {
    const k = deck.findIndex((c) => c.id === focusCol);
    if (k >= 0) { setActive(k); setFocusCol(null); }
  }, [deck, focusCol]);
  const openChannel = (channel: Channel) => {
    setChannelsOpen(false);
    setThreadTask(null);
    if (phone) { setPhoneChannel(channel.id); setActive(0); return; }
    switchView('custom');
    const existing = custom.find((column) => column.channelId === channel.id);
    if (existing) { setFocusCol(existing.id); return; }
    const def: ColumnDef = { id: crypto.randomUUID(), title: channel.name, channelId: channel.id, filter: {} };
    setCustom((columns) => [...columns, def]);
    setFocusCol(def.id);
  };
  useEffect(() => {
    if (!hub.synced) return;
    setCustom((columns) => columns.some((column) => column.channelId && !hub.channels.has(column.channelId))
      ? columns.filter((column) => !column.channelId || hub.channels.has(column.channelId)) : columns);
    if (phoneChannel && !hub.channels.has(phoneChannel)) setPhoneChannel(null);
  }, [hub.synced, hub.channels, phoneChannel]);
  /** Toggles "작업별로 묶기" on a user column. */
  const toggleByTask = (colId: string) => {
    const col = columns.find((c) => c.id === colId);
    if (!col || col.channelId) return;
    if (editable) setColumns((cs) => cs.map((c) => (c.id === colId ? { ...c, byTask: !c.byTask } : c)));
    else setViewByTask((b) => ({ ...b, [colId]: !col.byTask }));
    setToast(col.byTask ? `“${col.title}”: 글을 모두 봅니다.` : `“${col.title}”: 작업마다 최근 글 하나만 봅니다.`);
  };
  /**
   * "작업별 컬럼으로 나누기": a column per task shown in the column, right after it. Active tasks
   * first, then the most recent, at most SPLIT_MAX; tasks that already have their own column are skipped.
   */
  const splitColumn = (colId: string) => {
    if (phone) { setToast('컬럼은 PC 화면에서 쓸 수 있습니다.'); return; }
    const col = deck.find((c) => c.id === colId);
    if (!col) return;
    const own = new Set(custom.filter((c) => c.filter.taskIds?.length === 1).map((c) => c.filter.taskIds![0]));
    const ids = [...new Set(col.posts.map((p) => p.taskId))].filter((id) => hub.tasks.has(id) && !own.has(id));
    const active = (id: string) => ['running', 'waiting'].includes(hub.tasks.get(id)!.status);
    const pick = [...ids.filter(active), ...ids.filter((id) => !active(id))].slice(0, SPLIT_MAX);
    if (!pick.length) { setToast(ids.length || !col.posts.length ? '나눌 작업이 없습니다.' : '이 컬럼의 작업은 모두 이미 컬럼이 있습니다.'); return; }
    const made: ColumnDef[] = pick.map((id) => ({ id: crypto.randomUUID(), title: hub.tasks.get(id)!.title, filter: { taskIds: [id] } }));
    // From a built view the columns go to the end of F1, which then shows.
    const k = custom.findIndex((c) => c.id === colId);
    const next = [...custom];
    next.splice(k < 0 ? next.length : k + 1, 0, ...made);
    setCustom(next);
    setView('custom');
    setFocusCol(made[0].id);
    setToast(`작업 ${made.length}개를 컬럼으로 나눴습니다${ids.length > made.length ? ` (진행 중·최근 순으로 ${SPLIT_MAX}개까지)` : ''}.`);
  };
  const pinTask = (taskId: string) => {
    if (phone) { setToast('컬럼은 PC 화면에서 쓸 수 있습니다.'); return; }
    const have = custom.find((c) => c.filter.taskIds?.length === 1 && c.filter.taskIds[0] === taskId);
    setView('custom');
    if (have) { setFocusCol(have.id); setToast('이미 컬럼으로 고정한 작업입니다.'); return; }
    const def: ColumnDef = { id: crypto.randomUUID(), title: hub.tasks.get(taskId)?.title ?? '작업', filter: { taskIds: [taskId] } };
    const from = activeCol?.id === THREAD ? threadAfter : activeCol?.def?.id;
    const k = custom.findIndex((c) => c.id === from);
    const next = [...custom];
    next.splice(k < 0 ? next.length : k + 1, 0, def);
    setCustom(next);
    setFocusCol(def.id);
  };
  /** Adds a task to a column that already lists tasks (a column without one shows every task). */
  const addToColumn = (colId: string, taskId: string) => {
    const col = custom.find((c) => c.id === colId);
    if (!col?.filter.taskIds?.length) return;
    setView('custom');
    if (!col.filter.taskIds.includes(taskId)) {
      setCustom(custom.map((c) => (c.id === colId ? { ...c, filter: { ...c.filter, taskIds: [...col.filter.taskIds!, taskId] } } : c)));
    }
    setFocusCol(colId);
    setToast(`“${col.title}” 컬럼에 추가했습니다.`);
  };
  const deleteColumn = (id: string) => {
    if (id === SEARCH) { closeSearch(); return; }
    if (!editable) { setToast(FIXED_NOTE); return; }
    setColumns(columns.filter((c) => c.id !== id));
    setToast('컬럼을 삭제했습니다.');
  };

  const goRecent = () => {
    if (phone && threadTask) closeThread();
    const k = deck.findIndex((c) => c.id !== SEARCH && !!c.def && !c.def.channelId && isAllFilter(c.def.filter));
    if (k < 0) { setToast('전체 컬럼이 없습니다.'); return; }
    setActive(k);
    showNewest(deck[k].id);
  };
  const openSearch = () => {
    if (phone) { setToast('검색은 PC 화면에서 쓸 수 있습니다.'); return; }
    const task = activeCol?.id === THREAD && threadTask ? hub.tasks.get(threadTask) : undefined;
    if (task) {
      const query = taskSearchQuery(task);
      setSearch(query);
      // Scope immediately, so an already open global search does not flash unrelated results.
      setSearchApplied(query);
    } else if (search == null) setSearch('');
    setFocusCol(SEARCH);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => { setSearch(null); setSearchApplied(''); };
  /** Leaves the search field for its results, selecting the first. */
  const searchResults = () => {
    searchRef.current?.blur();
    const k = deck.findIndex((c) => c.id === SEARCH);
    if (k < 0) return;
    setActive(k);
    const first = deck[k].posts[0];
    if (first) select(SEARCH, first.id);
  };
  /** Keeps the search as a column in its place, the query as its filter and title. */
  const saveSearch = () => {
    const text = (search ?? '').trim();
    if (!text) return;
    const def: ColumnDef = { id: crypto.randomUUID(), title: text, filter: parseSearch(text, hub.projects, hub.tasks.values()).filter };
    const k = custom.findIndex((c) => !c.channelId && isAllFilter(c.filter));
    const next = [...custom];
    next.splice(k + 1, 0, def);
    setCustom(next);
    setView('custom');
    if (threadAfter === SEARCH) setThreadAfter(def.id);
    closeSearch();
    setFocusCol(def.id);
    setToast('검색을 컬럼으로 저장했습니다.');
  };

  // The deck's keys (deckKeys.ts). Registered again each render, so the handler sees the current state.
  useEffect(() => {
    const keys: DeckKeyContext = {
      help, menu, phone, drawer, editable, queue, queueFocus, activeCol, activeIdx, selectedPost, threadTask, tasks: hub.tasks,
      handoff, pendingG, pendingDelete,
      switchView, setHelp, setQueueFocus, allow, setDenying, setToast, fail, openQueueItem, select, goRecent, stepColumn, edgeColumn,
      moveColumn, focusColumn, openThread, closeThread, toggleThreadFocus, toggleFloat, openSearch, closeSearch, setDrawer,
      openDrawer, toggleExpanded, replyTo, approvalFor, setColumnDialog, pinTask, toggleByTask, setFinder, deleteColumn,
      setWidth, widthOf,
    };
    const onKey = (ev: KeyboardEvent) => onDeckKey(ev, keys);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const threadTaskView = threadTask ? hub.tasks.get(threadTask) : undefined;
  const runnerOk = hub.runnerConnected !== false;
  const now = Date.now();
  const menuCol = menu ? deck.findIndex((c) => c.id === menu.colId) : -1;
  const menuDef = menu ? columns.findIndex((c) => c.id === menu.colId) : -1;

  // Post handlers go through the latest state: a memoized post keeps the closures of the render that drew it.
  const postActions = useRef({ select, toggleExpanded, approvalFor, allow, setDenying, openThread, setActive, deck });
  postActions.current = { select, toggleExpanded, approvalFor, allow, setDenying, openThread, setActive, deck };
  const renderPost = ({ post: p, up, down }: PlacedPost, colId: string, i: number, inThread: boolean) => (
    <PostView key={p.id} post={p} task={hub.tasks.get(p.taskId)} model={models.get(p.taskId)} up={up} down={down}
      approval={p.kind === 'approval' ? hub.approvals.get(p.event.payload.approvalId) : undefined}
      question={p.kind === 'question' ? hub.questions.get(p.event.payload.questionId) : undefined} onError={setToast}
      colId={colId} selected={i === activeIdx && selection[colId] === p.id} flash={flash === p.id}
      expanded={expanded.has(p.id)} working={working.has(p.id)} inThread={inThread}
      draft={draftPosts.has(`${colId}:${p.id}`)}
      picked={inThread && handoff?.open && pickable(p.event) ? handoff.picked.includes(p.event.id) : undefined}
      onPick={() => togglePick(p.taskId, p.event.id)}
      onSelect={() => {
        const a = postActions.current;
        const k = a.deck.findIndex((c) => c.id === colId);
        if (k >= 0) a.setActive(k);
        a.select(colId, p.id);
      }}
      onToggle={() => postActions.current.toggleExpanded(p.id)}
      onAllow={() => { const a = postActions.current.approvalFor(p); if (a) postActions.current.allow(a); }}
      onDeny={() => { const a = postActions.current.approvalFor(p); if (a) postActions.current.setDenying(a); }}
      onOpenThread={inThread ? undefined : () => postActions.current.openThread(p.taskId, { from: colId, post: p.id })} />
  );

  // Per feed column, what it shows of the tasks, approvals and the rest; kept the same object while
  // that part is unchanged, so a hub update or a move between columns redraws only the columns it touches.
  const lastCtx = useRef(new Map<string, ColumnCtx>());
  const columnCtx = useMemo(() => {
    const out = new Map<string, ColumnCtx>();
    for (const col of deck) {
      if (col.id === THREAD || col.def?.channelId) continue;
      const c: ColumnCtx = { tasks: new Map(), models: new Map(), approvals: new Map(), questions: new Map(), working: new Set(), drafts: new Set() };
      const addTask = (id: string) => { const t = hub.tasks.get(id); if (t) c.tasks.set(id, t); };
      for (const id of col.def?.filter.taskIds ?? []) addTask(id);
      for (const p of col.posts) {
        addTask(p.taskId);
        const m = models.get(p.taskId);
        if (m) c.models.set(p.taskId, m);
        if (p.kind === 'approval') { const k = p.event.payload.approvalId, a = hub.approvals.get(k); if (a) c.approvals.set(k, a); }
        if (p.kind === 'question') { const k = p.event.payload.questionId, q = hub.questions.get(k); if (q) c.questions.set(k, q); }
        if (working.has(p.id)) c.working.add(p.id);
        if (draftPosts.has(`${col.id}:${p.id}`)) c.drafts.add(p.id);
      }
      const old = lastCtx.current.get(col.id);
      out.set(col.id, old && sameCtx(old, c) ? old : c);
    }
    lastCtx.current = out;
    return out;
  }, [deck, hub.tasks, models, hub.approvals, hub.questions, working, draftPosts]);
  // Column handlers go through the latest state, like the posts' (a memoized column keeps old closures).
  const columnActions = useRef<ColumnActions>(null!);
  columnActions.current = {
    press: (colId) => { press(); setActive(deck.findIndex((c) => c.id === colId)); setQueueFocus(null); },
    select: (colId, postId) => { const k = deck.findIndex((c) => c.id === colId); if (k >= 0) setActive(k); select(colId, postId); },
    toggle: (postId) => toggleExpanded(postId),
    allow: (p) => { const a = approvalFor(p); if (a) allow(a); },
    deny: (p) => { const a = approvalFor(p); if (a) setDenying(a); },
    openThread: (taskId, from, post) => openThread(taskId, post == null ? { from } : { from, post }),
    renaming: (colId, on) => setRenaming(on && editable ? colId : null),
    rename: (colId, title) => setColumns((cs) => cs.map((c) => (c.id === colId ? { ...c, title } : c))),
    menu: (colId, r) => setMenu({ colId, x: r.right, y: r.bottom }),
    scroll: (colId, el) => onFeedScroll(colId, el),
    showNewest: (colId) => showNewest(colId),
    older: (colId) => loadEarlierColumn(colId),
    resize: (colId, px) => setWidth(colId, px),
  };

  const threadIdx = deck.findIndex((c) => c.id === THREAD);
  /** One deck column; the thread is drawn outside the deck when it floats. */
  const renderColumn = (col: DeckColumn, i: number) => {
    const isThread = col.id === THREAD;
    if (col.def?.channelId) return <ChannelColumn key={col.id} def={col.def} channel={hub.channels.get(col.def.channelId)}
      active={i === activeIdx} keyboardEnabled={queueFocus == null && !menu && !help} width={widthOf(col.id)} synced={hub.synced} onEntry={hub.onChannelEntry}
      onPress={() => { setActive(i); setQueueFocus(null); }} onResize={(px) => setWidth(col.id, px)} onManage={() => setChannelsOpen(true)}
      onClose={() => phone ? setPhoneChannel(null) : deleteColumn(col.id)} onError={setToast} onRead={() => {}}
      chat={{ projects: hub.projects, tasks: hub.tasks, approvals: hub.approvals, questions: hub.questions, onEvent: hub.onEvent,
        onOpenTask: (taskId) => openThread(taskId, { from: col.id }), onApproval: (approval, yes) => yes ? allow(approval) : setDenying(approval) }}
      onEdge={edgeColumn} onRecent={goRecent} onBack={phone ? () => setPhoneChannel(null) : undefined} />;
    if (!isThread) {
      const f = feeds.get(col.id);
      return (
        <FeedColumn key={col.id} col={col} active={i === activeIdx} selected={i === activeIdx ? selection[col.id] : undefined}
          width={widthOf(col.id)} ctx={columnCtx.get(col.id)!} projects={projectsById} flash={flash} expanded={expanded}
          tick={tick} unseen={unseen[col.id] ?? 0} more={!!f?.more} loading={!!f?.loading} renaming={renaming === col.id}
          total={f?.total && (col.def?.byTask ? f.total.tasks : f.total.posts)}
          empty={col.posts.length ? '' : col.id === SEARCH && !searching ? '검색어나 #project: 같은 필터를 입력하세요.' : hub.events.length === 0
            ? 'i를 눌러 첫 작업을 시작하세요.' : f?.loading ? '불러오는 중…' : '조건에 맞는 글이 없습니다.'}
          head={col.id === SEARCH ? (
            <SearchHead value={search ?? ''} onChange={setSearch} inputRef={searchRef} projects={hub.projects}
              tasks={taskList} count={f?.total ? `${col.posts.length} / ${Math.max(f.total.posts, col.posts.length)}` : `${col.posts.length}${f?.more ? '+' : ''}`}
              unknown={parsedSearch.unknown} onDone={searchResults} onClose={closeSearch} onSave={saveSearch} />
          ) : undefined}
          onError={setToast} act={columnActions} />
      );
    }
    return (
      <section key={col.id} data-col={col.id} className={`column thread${i === activeIdx ? ' focused' : ''}`}
        style={{ '--w': `${widthOf(col.id)}px`,
          ...(threadTaskView ? { '--pc': projectColor(threadTaskView.project_id) } : {}) } as CSSProperties}
        onMouseDown={() => { press(); setActive(i); setQueueFocus(null); }}>
        <ThreadHead task={threadTaskView} project={threadTaskView && projectsById.get(threadTaskView.project_id)}
          model={threadTask ? models.get(threadTask) : undefined} events={threadEvents} now={now} draft={!!threadTask && drafts.has(threadTask)}
          onClose={closeThread} onPin={() => threadTask && pinTask(threadTask)}
          handoff={handoff ? (handoff.open ? 'open' : 'kept') : null} onHandoff={() => threadTask && toggleHandoff(threadTask)}
          onMenu={(r) => setMenu({ colId: col.id, x: r.right, y: r.bottom })} />
        <div className="feed thread-feed"
          onScroll={(e) => {
            const f = e.currentTarget;
            threadAtBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
            if (f.scrollTop < 80 && !threadAtBottom.current && threadLoaded && threadMore && !threadLoadingEarlier) loadEarlierThread();
          }}>
          <div className="thread-content">
            {threadMore && (
              <div className="older-posts">
                <button disabled={threadLoadingEarlier} onClick={loadEarlierThread}>
                  {threadLoadingEarlier ? '불러오는 중…' : <><ArrowUp /> 이전 기록 더 보기</>}
                </button>
              </div>
            )}
            {col.placed.map((pp) => renderPost(pp, col.id, i, true))}
            {col.posts.length === 0 && (
              <p className="empty">{threadLoaded && !threadMore && !threadLoadingEarlier ? '글이 없습니다.' : '불러오는 중…'}</p>
            )}
          </div>
        </div>
        {threadTaskView && (threadTaskView.source === 'external' ? (
          <ExternalNote pending={!!questionOf(threadTaskView.id)}
            onAnswer={() => { const q = questionOf(threadTaskView.id); if (q) answerQuestion(threadTaskView.id, q); }} />
        ) : handoff?.open ? (
          <HandoffPanel key={threadTaskView.id} task={threadTaskView} state={handoff} model={models.get(threadTaskView.id)} events={threadEvents}
            onError={setToast} onDone={setToast} />
        ) : (
          <ReplyBox key={threadTaskView.id} task={threadTaskView} projects={hub.projects} tasks={taskList} inputRef={replyRef} onError={setToast} onSend={onThreadSend} />
        ))}
        <ResizeHandle width={widthOf(col.id)} onResize={(px) => setWidth(col.id, px)} />
      </section>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><img className="logo" src="/favicon.png?v=sage-20261103" alt="" /><span className="word">Agent Desk</span></div>
        <span className="conns">
          <span className={`conn${hub.connected ? ' on' : ''}`} title={hub.connected ? '허브 연결됨' : '허브 연결 끊김'} />
          <span className={`conn${hub.connected && runnerOk ? ' on' : ''}`}
            title={!hub.connected ? '러너: 허브 연결이 끊겨 알 수 없음' : runnerOk ? '러너 연결됨' : '러너 연결 끊김'} />
        </span>
        {!phone && (
          <nav className="views" aria-label="뷰">
            {VIEWS.map((v) => {
              const Icon = VIEW_ICON[v.id];
              return <button key={v.id} aria-pressed={view === v.id} title={`${v.title} (${v.key})`}
                aria-label={`${v.label} (${v.key})`} aria-keyshortcuts={v.key} onClick={() => switchView(v.id)}>
                <Icon aria-hidden="true" /><span>{v.label}</span>
              </button>;
            })}
          </nav>
        )}
        <nav className="attn" aria-label="주의가 필요한 작업">
          <Chip kind="wait" n={queue.length} label="응답 대기" hint="a"
            title="응답 대기열로 이동: 승인 요청과 에이전트 질문 (a)" onClick={() => setQueueFocus(0)} />
          <Chip kind="run" n={counts.running} label="실행 중" title="실행 중인 작업을 차례로 보기" onClick={() => jumpTo('running')} />
          <Chip kind="stall" n={stalled.size} label="멈춤" title="3분 넘게 응답이 없는 실행 중 작업을 차례로 보기" onClick={() => jumpTo('stalled')} />
          <Chip kind="draft" n={drafts.size} label="작성 중" title="보내지 않은 답글이 있는 스레드를 차례로 열기" onClick={jumpDraft} />
          <Chip kind="err" n={counts.error} label="오류" title="오류 난 작업을 차례로 보기" onClick={() => jumpTo('error')} />
        </nav>
        <div className="top-actions">
          <button className="btn primary" title="새 작업 (i)" aria-label="새 작업" onClick={() => (drawer ? setDrawer(false) : openDrawer())}>
            <SquarePen />
          </button>
          <button className="btn sessions-btn" title="열린 세션: 데스크가 띄운 엔진 프로세스 목록과 닫기" aria-label={`열린 세션 ${liveCount}개`}
            onClick={() => setSessionsOpen(true)}><Cpu /><span>{liveCount}</span></button>
          <button className="btn" title="스킬 관리: #스킬이름으로 메시지에 적용" aria-label="스킬" onClick={() => setSkillsOpen(true)}><Puzzle /></button>
          <button className="btn" aria-pressed={notifyState === 'on'} aria-label="알림"
            title={notifyState === 'on' ? '알림 켜짐: 데스크를 보고 있지 않을 때 승인 요청·질문·작업 끝남·오류를 OS 알림으로 (누르면 끄기)'
              : notifyState === 'blocked' ? '알림이 차단되어 있습니다. 브라우저나 시스템 설정에서 이 사이트의 알림을 허용하세요'
              : notifyState === 'unsupported' ? '이 화면에서는 알림을 쓸 수 없습니다 (데스크톱 앱이나 PC 브라우저에서 사용)'
              : '알림 켜기: 데스크를 보고 있지 않을 때 승인 요청·질문·작업 끝남·오류를 OS 알림으로'}
            onClick={() => {
              if (notifyState === 'unsupported') { setToast('이 화면에서는 알림을 쓸 수 없습니다. 데스크톱 앱이나 PC 브라우저에서 켜 주세요.'); return; }
              void setNotify(notifyState !== 'on').then((s) => {
                if (s === 'blocked') setToast('알림이 차단되어 있습니다. 브라우저나 시스템 설정에서 허용해 주세요.');
                else if (s === 'off' && notifyState !== 'on') setToast(window.__AGENT_DESK_APP__
                  ? 'macOS가 알림을 허용하지 않았습니다. 시스템 설정 > 알림 > Agent Desk에서 허용한 뒤 다시 켜 주세요.' : '알림을 허용하지 않아 켜지 않았습니다.');
                else setToast(s === 'on' ? '알림을 켰습니다.' : '알림을 껐습니다.');
              });
            }}>
            {notifyState === 'on' ? <Bell /> : <BellOff />}</button>
          <button className="btn" title={`새 작업의 엔진별 기본 모델과 effort: 작업마다 ${ENGINES.map(modelTagsOf).join(' · ')} · #low … #max (${effortNote()})`} aria-label="설정: 기본 모델" onClick={() => setModelOpen(true)}><Settings /></button>
          {hub.local && <button className="btn" title="다른 기기 연결: 접속 요청, 연결한 기기, QR 코드" aria-label="다른 기기 연결" onClick={() => setAccessOpen(true)}><Smartphone /></button>}
          <button className="btn help-btn" title="단축키 (?)" aria-label="단축키" onClick={() => setHelp(true)}><Keyboard /></button>
        </div>
      </header>

      {hub.connected && hub.runnerConnected === false && (
        <div className="runner-warn" role="alert">러너 연결이 끊겼습니다. 실행 중인 세션 상태를 확인할 수 없습니다.</div>
      )}

      <ApprovalQueue items={queue} tasks={hub.tasks} focus={queueFocus} showAll={queueAll}
        onShowAll={setQueueAll} onAllow={allow} onDeny={setDenying} onOpen={openQueueItem} onFocus={setQueueFocus} />

      <div className="workspace" ref={workspaceRef}>
        {drawer && (
          <ComposeDrawer projects={hub.projects} tasks={taskList} inputRef={composeRef}
            onClose={() => setDrawer(false)}
            onSent={(task) => {
              setToast('보냈습니다.');
              void hub.refresh();
              // The drawer has done its job; the thread opens beside the column that shows everything.
              setDrawer(false);
              openThread(task.id, { from: columns.find((c) => !c.channelId && isAllFilter(c.filter))?.id });
            }} />
        )}
        <main className={`deck${phone ? ' phone' : ''}`} ref={deckRef}>
          {deck.map((col, i) => (floatThread && col.id === THREAD ? null : renderColumn(col, i)))}
          {!phone && editable && (
            <button className="add-col" title="컬럼 추가 (c)" onClick={() => setColumnDialog({})}>
              <Plus aria-label="컬럼 추가" /><kbd>c</kbd>
            </button>
          )}
          {olderCols > 0 && (
            <button className="add-col more-tasks" title={`더 이전 ${view === 'project' ? '프로젝트' : '작업'} 보기 (마지막 컬럼에서 l)`} onClick={() => showOlder()}>
              <ArrowRight aria-hidden />이전 {view === 'project' ? '프로젝트' : '작업'}<small>{Math.min(VIEW_MAX, olderCols)}개 더 · 남은 {olderCols}개</small>
            </button>
          )}
        </main>
        {floatThread && threadIdx >= 0 && (
          // Covering the whole workspace, the thread steps aside (keeping its place) while the focus is in the deck.
          <div className={`thread-split${paneCover ? ` cover${activeCol?.id === THREAD ? '' : ' away'}` : ''}`}
            style={paneCover ? undefined : { flexBasis: paneWidth }}>
            {!paneCover && <SplitHandle split={split} onResize={resizeSplit} />}
            {renderColumn(deck[threadIdx], threadIdx)}
          </div>
        )}
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
      {hub.local && !accessOpen && hub.access && <AccessRequests requests={hub.access.requests} onError={setToast} />}

      {menu && menuCol >= 0 && (
        <ColumnMenu x={menu.x} y={menu.y} width={widthOf(menu.colId)} thread={menu.colId === THREAD}
          fixed={!editable} reorderable={reorderable}
          sort={editable || !reorderable ? undefined : typeof viewOrder[view] === 'string' ? viewOrder[view] as ViewSort : null}
          autoOrder={!editable && reorderable && AUTO_ORDER[view] ? { label: AUTO_ORDER[view]!, on: viewOrder[view] === undefined } : undefined}
          onSort={(k) => { sortColumns(k); setMenu(null); }}
          onRename={menuDef >= 0 && editable ? () => { setRenaming(menu.colId); setMenu(null); } : undefined}
          addTo={menu.colId === THREAD && threadTask ? custom.filter((c) => c.filter.taskIds?.length && !c.filter.taskIds.includes(threadTask)) : []}
          onAddTo={(colId) => { if (threadTask) addToColumn(colId, threadTask); setMenu(null); }}
          onPin={() => { if (threadTask) pinTask(threadTask); setMenu(null); }}
          floating={floatThread} onFloat={phone ? undefined : () => { toggleFloat(); setMenu(null); }}
          byTask={menuDef >= 0 && !columns[menuDef].channelId ? !!columns[menuDef].byTask : undefined}
          onByTask={() => { toggleByTask(menu.colId); setMenu(null); }}
          onSplit={() => { splitColumn(menu.colId); setMenu(null); }}
          canLeft={menuDef > 0} canRight={menuDef >= 0 && menuDef < columns.length - 1} onClose={() => setMenu(null)}
          onWidth={(px) => setWidth(menu.colId, px)}
          onEdit={() => { if (menu.colId === SEARCH) openSearch(); else setColumnDialog({ column: deck[menuCol].def }); setMenu(null); }}
          onMove={(dir) => { moveColumn(menuCol, dir); setMenu(null); }}
          onDelete={() => { if (menu.colId === THREAD) closeThread(); else deleteColumn(menu.colId); setMenu(null); }}
          remove={removable(menu.colId)} onRemoved={() => setMenu(null)} />
      )}
      {denying && <DenyDialog approval={denying} onClose={() => setDenying(null)} onDone={() => setDenying(null)} />}
      {columnDialog && (
        <ColumnDialog column={columnDialog.column} projects={hub.projects} tasks={taskList} channels={[...hub.channels.values()]}
          onManageChannels={() => { setColumnDialog(null); setChannelsOpen(true); }}
          onClose={() => setColumnDialog(null)}
          onSave={(c) => {
            setColumns(columnDialog.column ? columns.map((x) => (x.id === c.id ? c : x)) : [...columns, c]);
            if (!columnDialog.column) setFocusCol(c.id);
            setColumnDialog(null);
          }}
          onDelete={columnDialog.column ? () => { deleteColumn(columnDialog.column!.id); setColumnDialog(null); } : undefined} />
      )}
      {help && <Help onClose={() => setHelp(false)} />}
      {finder && (
        <ColumnFinder onClose={() => setFinder(false)}
          items={finderColumns.map((c) => ({ id: c.id, title: c.title, sub: c.note }))}
          onPick={(id) => {
            const at = deck.findIndex((c) => c.id === id);
            if (at >= 0) { focusColumn(at); return; }
            const limit = viewColumnLimit(view, id, hub.tasks, hub.projects, viewLimit);
            if (limit == null) return;
            setViewLimit(limit);
            setFocusCol(id);
          }} />
      )}
      {skillsOpen && <SkillsDialog onClose={() => setSkillsOpen(false)} />}
      {accessOpen && <AccessDialog access={hub.access} onError={setToast} onClose={() => setAccessOpen(false)} />}
      {sessionsOpen && <SessionsDialog tasks={hub.tasks} onOpen={(id) => openThread(id)} onClose={() => setSessionsOpen(false)} />}
      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} onChannels={() => { setModelOpen(false); setChannelsOpen(true); }} />}
      {channelsOpen && <ChannelsDialog channels={[...hub.channels.values()]} onClose={() => setChannelsOpen(false)} onChanged={hub.refresh} onOpen={openChannel} />}
    </div>
  );
}
