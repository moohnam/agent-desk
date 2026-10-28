import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Cpu, Ellipsis, Keyboard, ListRestart, PenLine, Pin, Plus, Puzzle, Settings, Smartphone, SquarePen } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { api } from './api.ts';
import { isAsk } from './AskCard.tsx';
import { AccessDialog } from './AccessDialog.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { ApprovalQueue, QUEUE_ROWS, queueItems, type QueueItem } from './ApprovalQueue.tsx';
import { ColumnDialog, KIND_LABEL } from './ColumnDialog.tsx';
import { ComposeDrawer, DenyDialog, Modal, ReplyBox } from './Compose.tsx';
import { SkillsDialog } from './Skills.tsx';
import { SessionsDialog, openSessions } from './Sessions.tsx';
import { ENGINE_LABEL, MODE_LABEL, MODEL_LABEL, engineOf } from '../../hub/src/compose.ts';
import { inBackground, STATUS_LABEL, stalledMinutes, statusLabel } from './format.ts';
import { HandoffPanel, pickable, toggleHandoff, togglePick, useHandoff } from './Handoff.tsx';
import { PostView } from './PostView.tsx';
import { pruneDrafts, useDraftTasks } from './drafts.ts';
import { DEFAULT_WIDTH, SAVE_DELAY, WIDTH_PRESETS, useColumnWidths, useColumns } from './columns.ts';
import { buildPosts, matches, placeFeed, placeThread } from './posts.ts';
import { modelShort, projectColor, projectListLabel } from './projects.ts';
import type { Approval, ColumnDef, ColumnFilter, HubEvent, PlacedPost, Post, Project, Question, TaskStatus, TaskView } from './types.ts';
import { useColumnFeeds, useHub, useTaskEvents } from './useHub.ts';
import { SearchHead } from './Search.tsx';
import { parseSearch } from './search.ts';
import { ORDERED, SORT_LABEL, VIEWS, VIEW_MAX, applyOrder, viewColumns, useView, type View, type ViewSort } from './views.ts';

const THREAD = 'thread';
/** The temporary search column, right of the column that shows everything; not saved. */
const SEARCH = 'search';
/** Typing pauses this long before the search column asks the hub again. */
const SEARCH_DEBOUNCE_MS = 250;
/** "작업별 컬럼으로 나누기" makes at most this many columns at once. */
const SPLIT_MAX = 6;
/** On a phone there are no columns: one feed of everything, with the thread laid over it. */
const PHONE_FEED: ColumnDef = { id: 'phone', title: '전체', filter: {} };
const THREAD_WIDTH = 460;
/** `<` and `>` change the active column's width by this much. */
const WIDTH_STEP = 40;
/** Below this width the compose drawer overlays the deck instead of sitting beside it. */
const NARROW = '(max-width: 900px)';
/** Phone-sized screens: one column at a time (matches the CSS breakpoint). */
const PHONE = '(max-width: 760px)';
/** Idle time after which a feed scrolled away from new posts returns to the top. */
const IDLE_RETURN_MS = 20_000;
const DRAWER_KEY = 'agent-desk.composeOpen';
/** '0': the thread opens as a column beside the others; otherwise it floats over the right half. */
const FLOAT_KEY = 'agent-desk.threadFloat';
/** Share of the workspace the split thread takes, as a percentage. */
const SPLIT_KEY = 'agent-desk.threadSplit';
const PANE_MIN = 30, PANE_MAX = 70, PANE_DEFAULT = 50;
/**
 * On a small workspace the split thread grows to at least PANE_MIN_PX; when that would leave the
 * deck less than DECK_MIN_PX, the thread covers the whole workspace instead.
 */
const PANE_MIN_PX = 560, DECK_MIN_PX = 420;
/** Shown when a built view (F2–F4) is asked to change its columns. */
const FIXED_NOTE = '자동으로 만든 뷰는 편집할 수 없습니다. F1(내 컬럼)에서 편집하세요.';
const EXTERNAL_NOTE = '터미널 세션입니다. 에이전트가 질문하면 여기서 답할 수 있습니다.';

interface DeckColumn { id: string; def?: ColumnDef; placed: PlacedPost[]; posts: Post[] }

const isNarrow = () => window.matchMedia(NARROW).matches;
/** A column that restricts nothing: "전체". */
const isAllFilter = (f: ColumnFilter) =>
  !f.taskIds?.length && !f.projectIds?.length && !f.kinds?.length && !f.statuses?.length && !f.query?.trim();

/** Whether a media query matches, following changes (rotating a phone, resizing a window). */
function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}

/** Model per task, taken from the session-start events seen so far. */
function modelsOf(...lists: HubEvent[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of lists) for (const e of list) {
    // The model a turn actually ran on: reported at the start and again after a model tag switch.
    if (e.kind === 'status' && (e.payload.state === 'started' || e.payload.state === 'model_changed') && e.payload.detail?.model) {
      out.set(e.task_id, e.payload.detail.model);
    }
  }
  return out;
}

/** Splits a placed feed into runs of connected posts, each shown under one task header. */
/** "작업별로 묶기": each task's newest post, newest first, drawn as one card. */
function newestPerTask(newestFirst: Post[]): PlacedPost[] {
  const seen = new Set<string>();
  return newestFirst.filter((p) => !seen.has(p.taskId) && seen.add(p.taskId)).map((post) => ({ post, up: false, down: false }));
}

/** Hue offset that tells a project's tasks apart: #1 keeps the project color, later ones turn around it. */
const TASK_HUES = [0, 45, -45, 90, -90, 135, -135];
const taskHue = (seq: number | undefined) => TASK_HUES[((seq ?? 1) - 1) % TASK_HUES.length];

function groupsOf(placed: PlacedPost[]): PlacedPost[][] {
  const out: PlacedPost[][] = [];
  for (const p of placed) {
    if (!p.up || !out.length) out.push([p]);
    else out[out.length - 1].push(p);
  }
  return out;
}

/**
 * The key pressed as on a US layout, for shortcuts: a letter key under another input source (ㅏ on
 * a Korean one, or an IME's 'Process') counts as its Latin letter (k), uppercase with Shift.
 */
function latinKey(e: KeyboardEvent): string {
  const m = /^Key([A-Z])$/.exec(e.code);
  if (!m || /^[a-zA-Z]$/.test(e.key)) return e.key;
  return e.shiftKey ? m[1] : m[1].toLowerCase();
}

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
  const [active, setActive] = useState(0);
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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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
    if (phone) return [PHONE_FEED];
    if (search == null) return columns;
    const k = columns.findIndex((c) => isAllFilter(c.filter));
    const next = [...columns];
    next.splice(k + 1, 0, { id: SEARCH, title: '검색', filter: parsedSearch.filter });
    return next;
  }, [phone, columns, search != null, parsedSearch]);
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
      const posts = (columnPosts.get(c.id) ?? []).filter((p) => matches(c.filter, p, hub.tasks.get(p.taskId)));
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
  }, [hub.synced, hub.tasks, hub.questions, hub.approvals]);

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
  // Keep the selected post (or column) visible.
  useEffect(() => {
    if (!activeCol) return;
    // The split thread is always in view; the deck beside it stays where it is.
    if (!(floatThread && activeCol.id === THREAD)) revealColumn(activeCol.id, activeCol.id === THREAD ? deck[activeIdx - 1]?.id : undefined);
    const id = selection[activeCol.id];
    if (id != null && !pressing.current) revealPost(activeCol.id, id);
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
  const stepColumn = (dir: -1 | 1) => {
    if (floatThread && activeCol?.id === THREAD) return backToDeck();
    const skip = (c: DeckColumn) => (view === 'status' && c.id.startsWith('v:s:') && c.posts.length === 0)
      || (floatThread && c.id === THREAD);
    for (let i = activeIdx + dir; i >= 0 && i < deck.length; i += dir) if (!skip(deck[i])) return focusColumn(i);
  };
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
    const ro = new ResizeObserver(stickThread);
    ro.observe(feed);
    return () => ro.disconnect();
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
  /** Toggles "작업별로 묶기" on a user column. */
  const toggleByTask = (colId: string) => {
    const col = columns.find((c) => c.id === colId);
    if (!col) return;
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
    const k = deck.findIndex((c) => c.id !== SEARCH && !!c.def && isAllFilter(c.def.filter));
    if (k < 0) { setToast('전체 컬럼이 없습니다.'); return; }
    setActive(k);
    showNewest(deck[k].id);
  };
  // Ctrl+`: open or close the compose drawer, even while typing in it.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.ctrlKey || ev.metaKey || ev.altKey || ev.code !== 'Backquote') return;
      ev.preventDefault();
      if (drawer) setDrawer(false); else openDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const openSearch = () => {
    if (phone) { setToast('검색은 PC 화면에서 쓸 수 있습니다.'); return; }
    if (search == null) setSearch('');
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
    const k = custom.findIndex((c) => isAllFilter(c.filter));
    const next = [...custom];
    next.splice(k + 1, 0, def);
    setCustom(next);
    setView('custom');
    if (threadAfter === SEARCH) setThreadAfter(def.id);
    closeSearch();
    setFocusCol(def.id);
    setToast('검색을 컬럼으로 저장했습니다.');
  };

  // vim-style navigation. Ignored while typing or while a dialog is open.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // Ctrl+Shift+J / K: only the user's own instructions; every other Ctrl/Alt/Cmd chord is left alone.
      const mine = ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey && (ev.code === 'KeyJ' || ev.code === 'KeyK');
      if (denying || columnDialog || menu || skillsOpen || ev.metaKey || (ev.ctrlKey && !mine) || ev.altKey) return;
      // F1–F4: the deck's views, also while typing.
      const fv = !ev.ctrlKey && !ev.shiftKey && VIEWS.find((x) => x.key === ev.key);
      if (fv) { if (!phone) switchView(fv.id); ev.preventDefault(); return; }
      const t = ev.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      const e = { key: latinKey(ev), preventDefault: () => ev.preventDefault() };
      if (help && !mine) { if (e.key === 'Escape' || e.key === '?' || e.key === 'q') setHelp(false); return; }

      if (queueFocus != null) {
        const item = queue[queueFocus];
        const a = item?.kind === 'approval' ? item.approval : undefined;
        let used = true;
        switch (e.key) {
          case 'j': case 'ArrowDown': setQueueFocus(Math.min(queueFocus + 1, queue.length - 1)); break;
          case 'k': case 'ArrowUp': setQueueFocus(Math.max(queueFocus - 1, 0)); break;
          case 'y': case 'n':
            if (a) { if (e.key === 'y') allow(a); else setDenying(a); }
            else if (item) setToast('질문은 Enter로 스레드를 열어 답합니다.');
            break;
          case 'Enter': if (item) openQueueItem(item); break;
          case 'Escape': case 'q': case 'a': setQueueFocus(null); break;
          case '?': setHelp(true); break;
          default: used = false;
        }
        if (used) { e.preventDefault(); return; }
      }

      const posts = activeCol?.posts ?? [];
      const cur = selectedPost ? posts.indexOf(selectedPost) : -1;
      const go = (i: number) => {
        if (!activeCol || !posts.length) return;
        select(activeCol.id, posts[Math.max(0, Math.min(i, posts.length - 1))].id);
      };
      // J / K: the first post of the next / previous run of another task's posts (`#1`, `#2` of a
      // project are different tasks).
      const taskOf = (i: number) => posts[i].taskId;
      // In a thread every post is the same task, so J / K step between the user's own posts instead.
      const nextUser = (dir: 1 | -1) => {
        let i = cur < 0 ? (dir > 0 ? 0 : posts.length - 1) : cur + dir;
        while (i >= 0 && i < posts.length && posts[i].kind !== 'user') i += dir;
        if (i >= 0 && i < posts.length) go(i);
        else setToast(dir > 0 ? '아래에 내 글이 더 없습니다.' : '위에 내 글이 더 없습니다.');
      };
      const nextTask = (dir: 1 | -1) => {
        if (activeCol?.id === THREAD) return nextUser(dir);
        if (cur < 0) return go(0);
        let i = cur;
        while (i + dir >= 0 && i + dir < posts.length && taskOf(i + dir) === taskOf(cur)) i += dir;
        i += dir;
        if (i < 0 || i >= posts.length) return go(dir > 0 ? posts.length - 1 : 0);
        if (dir < 0) while (i > 0 && taskOf(i - 1) === taskOf(i)) i--;
        go(i);
      };
      // Ctrl+Shift+J / K: the next / previous task run's topmost instruction (a post the user wrote);
      // a run's later instructions and runs without one are skipped.
      const landing = (i: number) => {
        if (posts[i].kind !== 'user') return false;
        for (let j = i - 1; j >= 0 && taskOf(j) === taskOf(i); j--) if (posts[j].kind === 'user') return false;
        return true;
      };
      const nextMine = (dir: 1 | -1) => {
        let i = cur < 0 ? (dir > 0 ? 0 : posts.length - 1) : cur + dir;
        while (i >= 0 && i < posts.length && !landing(i)) i += dir;
        if (i >= 0 && i < posts.length) go(i);
        else setToast(dir > 0 ? '아래에 지시한 글이 더 없습니다.' : '위에 지시한 글이 더 없습니다.');
      };
      if (mine) {
        if (help || queueFocus != null) return;
        nextMine(ev.code === 'KeyJ' ? 1 : -1);
        e.preventDefault();
        return;
      }
      const now = Date.now();
      let handled = true;
      // `gr`: back to the column showing everything, at its newest post.
      if (e.key === 'r' && now - pendingG.current < 600) {
        pendingG.current = 0;
        goRecent();
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'j': case 'ArrowDown': go(cur + 1); break;
        case 'k': case 'ArrowUp': go(cur < 0 ? 0 : cur - 1); break;
        case 'h': case 'ArrowLeft': stepColumn(-1); break;
        case 'l': case 'ArrowRight': stepColumn(1); break;
        case 'J': nextTask(1); break;
        case 'K': nextTask(-1); break;
        case 'G': go(posts.length - 1); break;
        case 'g':
          if (now - pendingG.current < 600) { go(0); pendingG.current = 0; } else pendingG.current = now;
          break;
        case 'H': moveColumn(activeIdx, -1); break;
        case 'L': moveColumn(activeIdx, 1); break;
        case 'Enter': if (selectedPost && activeCol?.id !== THREAD) openThread(selectedPost.taskId, { from: activeCol?.id, post: selectedPost.id }); break;
        case 'Escape': case 'q':
          // On the search column it closes the search; focus goes back to the column left of it (all).
          if (activeCol?.id === SEARCH) { closeSearch(); focusColumn(activeIdx - 1); }
          else if (threadTask) closeThread();
          else if (drawer && isNarrow()) setDrawer(false);
          break;
        case 'o': case ' ': if (selectedPost) toggleExpanded(selectedPost.id); break;
        case 'r': {
          const taskId = selectedPost?.taskId ?? (activeCol?.id === THREAD ? threadTask : null);
          if (taskId) replyTo(taskId, activeCol?.id);
          break;
        }
        case 'i': openDrawer(); break;
        case 'y': { const a = approvalFor(selectedPost); if (a) allow(a); break; }
        case 'n': { const a = approvalFor(selectedPost); if (a) setDenying(a); break; }
        case 's': {
          const taskId = selectedPost?.taskId ?? (activeCol?.id === THREAD ? threadTask : null);
          if (taskId) api.interrupt(taskId).then(() => setToast('중단을 요청했습니다.'), fail);
          break;
        }
        case 'c': if (editable) setColumnDialog({}); else setToast(FIXED_NOTE); break;
        case 'f': if (threadTask && !phone) toggleFloat(); break;
        case 't': toggleThreadFocus(); break;
        case 'X':
          if (threadTask && hub.tasks.get(threadTask)?.source === 'app') toggleHandoff(threadTask);
          else setToast(threadTask ? '터미널 작업은 컨텍스트를 재구성할 수 없습니다.' : '열린 스레드가 없습니다.');
          break;
        case 'x':
          if (handoff?.open && activeCol?.id === THREAD && selectedPost && pickable(selectedPost.event)) togglePick(selectedPost.taskId, selectedPost.event.id);
          break;
        case 'p': { const id = selectedPost?.taskId ?? (activeCol?.id === THREAD ? threadTask : null); if (id) pinTask(id); break; }
        case 'v': if (activeCol?.def && activeCol.id !== SEARCH) toggleByTask(activeCol.id); break;
        case 'e':
          if (activeCol?.id === SEARCH) openSearch();
          else if (activeCol?.def) { if (editable) setColumnDialog({ column: activeCol.def }); else setToast(FIXED_NOTE); }
          break;
        case '/': openSearch(); break;
        case 'D':
          if (!activeCol?.def) break;
          if (now - pendingDelete.current < 1500) { deleteColumn(activeCol.def.id); pendingDelete.current = 0; }
          else { pendingDelete.current = now; setToast(`D를 한 번 더 누르면 “${activeCol.def.title}” 컬럼을 삭제합니다.`); }
          break;
        case 'a': if (queue.length) setQueueFocus(0); else setToast('응답 대기가 없습니다.'); break;
        case '<': case '>':
          if (activeCol) setWidth(activeCol.id, widthOf(activeCol.id) + (e.key === '>' ? WIDTH_STEP : -WIDTH_STEP));
          break;
        case '?': setHelp(true); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
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
      expanded={expanded.has(p.id)} working={working.has(p.id)} inThread={inThread} tick={tick}
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
      if (col.id === THREAD) continue;
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
          onScroll={(e) => { const f = e.currentTarget; threadAtBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40; }}>
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
        <div className="brand"><span className="logo">AD</span><span className="word">Agent Desk</span></div>
        <span className="conns">
          <span className={`conn${hub.connected ? ' on' : ''}`} title={hub.connected ? '허브 연결됨' : '허브 연결 끊김'} />
          <span className={`conn${hub.connected && runnerOk ? ' on' : ''}`}
            title={!hub.connected ? '러너: 허브 연결이 끊겨 알 수 없음' : runnerOk ? '러너 연결됨' : '러너 연결 끊김'} />
        </span>
        {!phone && (
          <nav className="views" aria-label="뷰">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} title={v.title} onClick={() => switchView(v.id)}>
                <kbd>{v.key}</kbd>{v.label}
              </button>
            ))}
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
          <button className="btn" title="새 작업의 엔진별 기본 모델과 effort: 작업마다 #opus #sonnet #haiku · #sol #astra #terra #luna · #argon #flash · #low … #max (#ultra는 Codex)" aria-label="설정: 기본 모델" onClick={() => setModelOpen(true)}><Settings /></button>
          {hub.local && <button className="btn" title="같은 네트워크의 폰이나 다른 기기에서 열기: QR 코드" aria-label="폰에서 열기" onClick={() => setAccessOpen(true)}><Smartphone /></button>}
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
              openThread(task.id, { from: columns.find((c) => isAllFilter(c.filter))?.id });
            }} />
        )}
        <main className={`deck${phone ? ' phone' : ''}`} ref={deckRef}>
          {deck.map((col, i) => (floatThread && col.id === THREAD ? null : renderColumn(col, i)))}
          {!phone && editable && (
            <button className="add-col" title="컬럼 추가 (c)" onClick={() => setColumnDialog({})}>
              <Plus aria-label="컬럼 추가" /><kbd>c</kbd>
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

      <footer className="hints">
        <span><kbd>j</kbd><kbd>k</kbd> 글 이동</span>
        <span><kbd>h</kbd><kbd>l</kbd> 컬럼</span>
        <span><kbd>Enter</kbd> 스레드</span>
        <span className="opt"><kbd>o</kbd> 펼치기</span>
        <span><kbd>y</kbd><kbd>n</kbd> 승인·거절</span>
        <span className="opt"><kbd>r</kbd> 답글·답하기</span>
        <span className="opt"><kbd>i</kbd> 새 작업</span>
        <span className="opt"><kbd>a</kbd> 응답 대기열</span>
        <span className="opt"><kbd>/</kbd> 검색</span>
        <span><kbd>?</kbd> 전체 단축키</span>
        <ContextHint post={selectedPost} task={selectedPost && hub.tasks.get(selectedPost.taskId)}
          pending={!!approvalFor(selectedPost)} ask={isAsk(approvalFor(selectedPost)?.tool_name)}
          question={!!selectedPost && !!questionOf(selectedPost.taskId)} />
      </footer>
      {toast && <div className="toast" role="status">{toast}</div>}

      {menu && menuCol >= 0 && (
        <ColumnMenu x={menu.x} y={menu.y} width={widthOf(menu.colId)} thread={menu.colId === THREAD}
          fixed={!editable} reorderable={reorderable}
          sort={editable || !reorderable ? undefined : typeof viewOrder[view] === 'string' ? viewOrder[view] as ViewSort : null}
          onSort={(k) => { sortColumns(k); setMenu(null); }}
          onRename={menuDef >= 0 && editable ? () => { setRenaming(menu.colId); setMenu(null); } : undefined}
          addTo={menu.colId === THREAD && threadTask ? custom.filter((c) => c.filter.taskIds?.length && !c.filter.taskIds.includes(threadTask)) : []}
          onAddTo={(colId) => { if (threadTask) addToColumn(colId, threadTask); setMenu(null); }}
          onPin={() => { if (threadTask) pinTask(threadTask); setMenu(null); }}
          floating={floatThread} onFloat={phone ? undefined : () => { toggleFloat(); setMenu(null); }}
          byTask={menuDef >= 0 ? !!columns[menuDef].byTask : undefined}
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
        <ColumnDialog column={columnDialog.column} projects={hub.projects} tasks={taskList}
          onClose={() => setColumnDialog(null)}
          onSave={(c) => {
            setColumns(columnDialog.column ? columns.map((x) => (x.id === c.id ? c : x)) : [...columns, c]);
            if (!columnDialog.column) setFocusCol(c.id);
            setColumnDialog(null);
          }}
          onDelete={columnDialog.column ? () => { deleteColumn(columnDialog.column!.id); setColumnDialog(null); } : undefined} />
      )}
      {help && <Help onClose={() => setHelp(false)} />}
      {skillsOpen && <SkillsDialog onClose={() => setSkillsOpen(false)} />}
      {accessOpen && <AccessDialog onClose={() => setAccessOpen(false)} />}
      {sessionsOpen && <SessionsDialog tasks={hub.tasks} onOpen={(id) => openThread(id)} onClose={() => setSessionsOpen(false)} />}
      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
    </div>
  );
}

/** Marks a task holding unsent text in its reply or answer box. */
export function DraftBadge() {
  return <span className="draft-badge" title="보내지 않은 답글이 있습니다 (이 기기에 저장됨)"><PenLine /> 작성 중</span>;
}

function Chip({ kind, n, label, hint, title, onClick }: {
  kind: string; n: number; label: string; hint?: string; title: string; onClick: () => void;
}) {
  return (
    <button className={`chip ${kind}${n ? '' : ' zero'}`} disabled={!n} title={title} onClick={onClick}>
      <span className="dot" /><span className="lbl-long">{label}</span><b>{n}</b>{hint && n > 0 && <kbd>{hint}</kbd>}
    </button>
  );
}

/** The status badge, or "응답 없음 N분" for a running app task that has gone quiet. */
function StatusBadge({ task, now }: { task: TaskView; now: number }) {
  const idle = stalledMinutes(task, now);
  if (idle != null) {
    return <span className="badge stalled" title="실행 중인데 3분 넘게 아무 이벤트가 없습니다.">응답 없음 {idle}분</span>;
  }
  if (inBackground(task)) {
    const bg = task.background!;
    return <span className="badge running" title={`백그라운드에서 일하는 중:\n${bg.map((b) => `· ${b.description}`).join('\n')}`}>
      {bg.some((b) => b.type === 'local_agent') ? '서브 에이전트' : '백그라운드'} {bg.length}</span>;
  }
  return <span className={`badge ${task.status}`}>{statusLabel(task)}</span>;
}

function TerminalBadge() {
  return <span className="badge term" title="터미널에서 실행 중인 세션이 MCP로 붙었습니다. 앱에서는 질문에만 답할 수 있습니다.">터미널</span>;
}

/** Posts a feed column draws at first, and adds at a time near its bottom. */
const DRAWN = 40, DRAW_STEP = 60;
/** How near the bottom (px) a feed draws or loads more. */
const EXTEND_PX = 600;
/** How long a feed stays at its top before it draws only its newest posts again. */
const SHRINK_MS = 20_000;
/** What a feed column shows besides its posts: only the tasks, models and the rest its posts refer to. */
interface ColumnCtx {
  tasks: Map<string, TaskView>; models: Map<string, string>; approvals: Map<string, Approval>; questions: Map<string, Question>;
  working: Set<number>; drafts: Set<number>;
}
const sameMap = <K, V>(a: Map<K, V>, b: Map<K, V>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
function sameCtx(a: ColumnCtx, b: ColumnCtx): boolean {
  return sameMap(a.tasks, b.tasks) && sameMap(a.models, b.models) && sameMap(a.approvals, b.approvals)
    && sameMap(a.questions, b.questions) && sameSet(a.working, b.working) && sameSet(a.drafts, b.drafts);
}
interface ColumnActions {
  press(colId: string): void;
  select(colId: string, postId: number): void;
  toggle(postId: number): void;
  allow(p: Post): void;
  deny(p: Post): void;
  openThread(taskId: string, from: string, post?: number): void;
  renaming(colId: string, on: boolean): void;
  rename(colId: string, title: string): void;
  menu(colId: string, r: DOMRect): void;
  scroll(colId: string, feed: HTMLElement): void;
  showNewest(colId: string): void;
  older(colId: string): void;
  resize(colId: string, px: number | null): void;
}

/**
 * A feed column. Memoized: it draws again only when its own posts, selection or context change, not
 * on every hub update or move to another column. `selected`: the selected post, given only while
 * the column is active. `head`: a header in place of the column's own (the search column's).
 */
const FeedColumn = memo(function FeedColumn({ col, active, selected, width, ctx, projects, flash, expanded, tick, unseen, more,
  loading, total, renaming, empty, head, onError, act }: {
  col: DeckColumn; active: boolean; selected?: number; width: number; ctx: ColumnCtx; projects: Map<string, Project>;
  flash: number | null; expanded: Set<number>; tick: number; unseen: number; more: boolean; loading: boolean; total?: number;
  renaming: boolean; empty: string; head?: ReactNode; onError: (msg: string) => void; act: RefObject<ColumnActions>;
}) {
  const now = Date.now();
  const id = col.id;
  const placed = col.placed;
  // Only the newest posts are drawn: those down to `floor` (a post id), or the first DRAWN while it
  // is unset. Posts arriving above do not push drawn ones out. The rest stay loaded, drawn as the
  // feed nears its bottom or the selection goes there.
  const [floor, setFloor] = useState<number | null>(null);
  const base = floor == null ? Math.min(DRAWN, placed.length) : (() => {
    const k = placed.findIndex((x) => x.post.id < floor);
    return k < 0 ? placed.length : k;
  })();
  const selectedAt = selected == null ? -1 : placed.findIndex((x) => x.post.id === selected);
  const count = Math.max(base, selectedAt + 1);
  const drawn = count < placed.length ? placed.slice(0, count) : placed;
  // The selection moved past the drawn posts (j, G): they stay drawn when it comes back up.
  useEffect(() => { if (count > base) setFloor(placed[count - 1].post.id); }, [count > base]);
  const feedRef = useRef<HTMLDivElement>(null);
  /** Near the bottom: draw more of the loaded posts, and load the next page before they run out. */
  const extend = (feed: HTMLElement) => {
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight >= EXTEND_PX) return;
    if (count < placed.length) setFloor(placed[Math.min(count + DRAW_STEP, placed.length) - 1].post.id);
    if (more && !loading && placed.length - count <= 2 * DRAW_STEP) act.current.older(id);
  };
  // Also after a render: a short column, or a page arriving while the feed sits at its bottom.
  useEffect(() => { if (feedRef.current) extend(feedRef.current); }, [placed, count, more, loading, width, expanded]);
  // Back at the top for a while: draw only the newest posts again (the rest stay loaded).
  const shrink = useRef(0);
  useEffect(() => () => clearTimeout(shrink.current), []);
  const onScroll = (feed: HTMLElement) => {
    act.current.scroll(id, feed);
    extend(feed);
    clearTimeout(shrink.current);
    if (feed.scrollTop >= 40) { if (floor == null && count) setFloor(placed[count - 1].post.id); return; }
    if (floor != null) shrink.current = window.setTimeout(() => setFloor(null), SHRINK_MS);
  };
  return (
    <section data-col={id} className={`column${active ? ' focused' : ''}`} style={{ '--w': `${width}px` } as CSSProperties}
      onMouseDown={() => act.current.press(id)}>
      {head ?? (
        <ColumnHead def={col.def!} loaded={col.posts.length} total={total} projects={projects} tasks={ctx.tasks}
          renaming={renaming} onRenaming={(on) => act.current.renaming(id, on)}
          onRename={(title) => act.current.rename(id, title)} onMenu={(r) => act.current.menu(id, r)} />
      )}
      <div className="feed" ref={feedRef} onScroll={(e) => onScroll(e.currentTarget)}>
        {unseen ? (
          <div className="new-posts">
            <button onClick={() => act.current.showNewest(id)}>↑ 새 글 {unseen}개</button>
          </div>
        ) : null}
        {groupsOf(drawn).map((group) => {
          const task = ctx.tasks.get(group[0].post.taskId);
          const pending = group.some(({ post }) => !post.resolution
            && (post.kind === 'approval' ? ctx.approvals.has(post.event.payload.approvalId)
              : post.kind === 'question' && ctx.questions.has(post.event.payload.questionId)));
          return (
            <div key={group[group.length - 1].post.id} className={`group${pending ? ' has-approval' : ''}`}
              style={task ? { '--pc': projectColor(task.project_id), '--th': taskHue(task.seq) } as CSSProperties : undefined}>
              {task && <GroupContext task={task} now={now} onOpen={() => act.current.openThread(task.id, id)} />}
              {group.map(({ post: p, up, down }) => (
                <PostView key={p.id} post={p} task={ctx.tasks.get(p.taskId)} model={ctx.models.get(p.taskId)} up={up} down={down}
                  approval={p.kind === 'approval' ? ctx.approvals.get(p.event.payload.approvalId) : undefined}
                  question={p.kind === 'question' ? ctx.questions.get(p.event.payload.questionId) : undefined} onError={onError}
                  colId={id} selected={selected === p.id} flash={flash === p.id} expanded={expanded.has(p.id)}
                  working={ctx.working.has(p.id)} inThread={false} tick={tick} draft={ctx.drafts.has(p.id)}
                  onSelect={() => act.current.select(id, p.id)} onToggle={() => act.current.toggle(p.id)}
                  onAllow={() => act.current.allow(p)} onDeny={() => act.current.deny(p)}
                  onOpenThread={() => act.current.openThread(p.taskId, id, p.id)} />
              ))}
            </div>
          );
        })}
        {empty && <p className="empty">{empty}</p>}
        {(more || count < placed.length) && (
          <div className="older-posts">
            <button disabled={loading} onClick={() => (count < placed.length
              ? setFloor(placed[Math.min(count + DRAW_STEP, placed.length) - 1].post.id) : act.current.older(id))}>
              {loading ? '불러오는 중…' : <><ArrowDown /> 이전 글 더 보기</>}
            </button>
          </div>
        )}
      </div>
      <ResizeHandle width={width} onResize={(px) => act.current.resize(id, px)} />
    </section>
  );
});

function GroupContext({ task, now, onOpen }: { task: TaskView; now: number; onOpen: () => void }) {
  return (
    <div className="ctx" title="스레드 열기 (Enter)" onClick={onOpen}>
      <span className="pdot" style={{ background: projectColor(task.project_id) }} />
      <span className="pname">{task.project_name}<span className="seq">#{task.seq}</span></span>
      <span className="ttl">› {task.title}</span>
      {task.source === 'external' && <TerminalBadge />}
      <StatusBadge task={task} now={now} />
    </div>
  );
}

/** Replaces the reply box on a terminal task: the app can only answer its questions. */
function ExternalNote({ pending, onAnswer }: { pending: boolean; onAnswer: () => void }) {
  return (
    <div className="reply-box external-note">
      <span>{EXTERNAL_NOTE}</span>
      {pending && <button className="link" title="질문에 답하기 (r)" onClick={onAnswer}>대기 중인 질문에 답하기 <kbd>r</kbd></button>}
    </div>
  );
}

function filterLabel(def: ColumnDef, projects: Map<string, Project>, tasks: Map<string, TaskView>): string {
  const f = def.filter;
  const text = def.note ?? ([
    f.taskIds?.length ? f.taskIds.map((id) => {
      const t = tasks.get(id);
      return t ? `${t.project_name}#${t.seq} · ${STATUS_LABEL[t.status]}` : '삭제된 작업';
    }).join(', ') : null,
    f.projectIds?.length ? projectListLabel(f.projectIds.map((id) => projects.get(id)?.name ?? '?')) : null,
    f.kinds?.length ? f.kinds.map((k) => KIND_LABEL[k]).join('·') : null,
    f.statuses?.length ? f.statuses.map((s) => STATUS_LABEL[s]).join('·') : null,
    f.query ? `“${f.query}”` : null,
  ].filter(Boolean).join(' · ') || '모든 글');
  return def.byTask ? `${text} · 작업별` : text;
}

/** `loaded`: the posts the column has loaded; `total`: all it has in the hub, when counted. */
function ColumnHead({ def, loaded, total, projects, tasks, renaming, onRenaming, onRename, onMenu }: {
  def: ColumnDef; loaded: number; total?: number; projects: Map<string, Project>; tasks: Map<string, TaskView>;
  renaming: boolean; onRenaming: (on: boolean) => void; onRename: (title: string) => void; onMenu: (r: DOMRect) => void;
}) {
  const label = filterLabel(def, projects, tasks);
  return (
    <header className="col-head">
      {renaming ? (
        <input className="input col-rename" defaultValue={def.title} aria-label="컬럼 이름" autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.value = def.title; e.currentTarget.blur(); }
          }}
          onBlur={(e) => { const t = e.currentTarget.value.trim(); if (t && t !== def.title) onRename(t); onRenaming(false); }} />
      ) : (
        <h2 title={`${def.title} (더블클릭: 이름 바꾸기)`} onDoubleClick={() => onRenaming(true)}>{def.title}</h2>
      )}
      {total == null ? <span className="count" title="불러온 글">{loaded}</span> : (
        <span className="count" title={`불러온 글 ${loaded}개 / 전체 ${Math.max(total, loaded)}개`}>
          {loaded}<span className="of"> / {Math.max(total, loaded).toLocaleString()}</span>
        </span>
      )}
      <span className="filter" title={label}>{label}</span>
      <button className="icon-btn" title="컬럼 메뉴" aria-label="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}><Ellipsis /></button>
    </header>
  );
}

function ThreadHead({ task, project, model, events, now, draft, handoff, onClose, onPin, onHandoff, onMenu }: {
  task: TaskView | undefined; project: Project | undefined; model: string | undefined; events: HubEvent[];
  now: number; draft: boolean; onClose: () => void; onPin: () => void; onMenu: (r: DOMRect) => void;
  /** Context reset: its panel is open, or closed with work kept; null: none. */
  handoff: 'open' | 'kept' | null; onHandoff: () => void;
}) {
  const turns = events.filter((e) => e.kind === 'status' && e.payload.state === 'turn_done').length;
  return (
    <header className="thread-head">
      <div className="row1">
        <button className="back" title="스레드 닫기 (q)" aria-label="스레드 닫기" onClick={onClose}><ArrowLeft /></button>
        {task && <span className="thread-chip" style={{ '--pc': projectColor(task.project_id) } as CSSProperties} title={project?.root_path}>{task.project_name}#{task.seq}</span>}
        <h2 title={task?.title}>{task?.title ?? '스레드'}</h2>
        {task?.source === 'external' && <TerminalBadge />}
        {task && <StatusBadge task={task} now={now} />}
        {draft && <DraftBadge />}
        {task?.source === 'app' && (
          <button className={`icon-btn${handoff === 'kept' ? ' kept' : ''}`} aria-pressed={handoff === 'open'}
            title={handoff === 'kept' ? '컨텍스트 재구성 이어서 하기 (X) · 쓰던 정리본이 있습니다' : handoff === 'open' ? '컨텍스트 재구성 패널 닫기 (X)' : '컨텍스트 재구성: 글을 골라 정리본을 만들고 새 세션으로 넘기기 (X)'}
            aria-label="컨텍스트 재구성" onClick={onHandoff}><ListRestart /></button>
        )}
        {task && <button className="icon-btn" title="컬럼으로 고정 (p)" aria-label="컬럼으로 고정" onClick={onPin}><Pin /></button>}
        <button className="icon-btn" title="컬럼 메뉴" aria-label="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}><Ellipsis /></button>
      </div>
      {task && (
        <div className="meta">
          <span title={project?.root_path}><span className="pdot" style={{ background: projectColor(task.project_id) }} />{task.project_name}
            <span className="seq" title={`@${task.project_name}#${task.seq}로 이 작업에 보낼 수 있습니다`}>#{task.seq}</span></span>
          <span title="모델은 #opus #sonnet #haiku(Claude), #sol #astra #terra #luna(Codex), #argon #flash(agy), effort는 #low … #max(#ultra는 Codex) 태그로 바꿉니다">
            {ENGINE_LABEL[engineOf(task.engine)]}{model ? ` · ${modelShort(model)}` : ''}
            {/* Switched by a tag, but no turn has run on it yet. */}
            {task.model && !new RegExp(`-${task.model}(-|$)`).test(model ?? '') ? ` → ${MODEL_LABEL[task.model]} (다음 턴)` : ''}
            {task.effort ? ` · effort ${task.effort}` : ''}</span>
          {turns > 0 && <span>턴 {turns}</span>}
          {task.permission_mode && task.source !== 'external' && <span>{task.permission_mode === 'auto' ? '자동 승인' : '매번 확인'} ({MODE_LABEL[task.permission_mode]})</span>}
          {!task.live && task.source !== 'external' && <span title="세션이 닫혀 있습니다. 답글을 보내면 이어서 다시 시작합니다.">세션 닫힘</span>}
        </div>
      )}
    </header>
  );
}

/** `ask`: the pending approval is an agent's question, answered rather than approved. */
function ContextHint({ post, task, pending, ask, question }: {
  post: Post | undefined; task: TaskView | undefined; pending: boolean; ask?: boolean; question: boolean;
}) {
  if (!post) return null;
  let text: ReactNode = <>이 글: <kbd>Enter</kbd> 스레드 · <kbd>r</kbd> 답글</>;
  if (task?.source === 'external') {
    text = question ? <>이 작업: <kbd>r</kbd> 질문에 답하기</> : <>터미널 작업: <kbd>Enter</kbd> 스레드</>;
  } else if (pending && ask) text = <>{post.kind === 'approval' ? '이 글' : '이 작업'}: <kbd>y</kbd> 질문에 답하기 · <kbd>n</kbd> 답하지 않기</>;
  else if (pending) text = <>{post.kind === 'approval' ? '이 글' : '이 작업'}: <kbd>y</kbd> 승인 · <kbd>n</kbd> 거절</>;
  else if (task?.status === 'running') text = <>이 작업: <kbd>s</kbd> 중단 · <kbd>r</kbd> 답글</>;
  return <span className="ctx-hint">{text}</span>;
}

/** The ⋯ menu: width presets plus column actions, anchored under its button. */
/** What a built view's own column order follows. */
const AUTO_ORDER: Partial<Record<View, string>> = { project: '최근 만든 작업순' };

function ColumnMenu({ x, y, width, thread, floating, onFloat, fixed, reorderable, sort, autoOrder, onSort, canLeft, canRight, onClose, onWidth, onRename, addTo, onAddTo, onPin, byTask, onByTask, onSplit, onEdit, onMove, onDelete, remove, onRemoved }: {
  x: number; y: number; width: number; thread: boolean; canLeft: boolean;
  /** Thread: whether it takes the right half beside the deck; `onFloat` toggles that (not on a phone). */
  floating?: boolean; onFloat?: () => void;
  /** A column of a built view (F2–F4): only width and grouping change. */
  fixed: boolean; canRight: boolean;
  /** F2 moves columns too. `sort`: their sort in force (null: automatic or moved); undefined elsewhere. */
  reorderable: boolean; sort?: ViewSort | null; onSort: (sort: ViewSort | null) => void;
  /** A built view's own order (shown when no sort is picked and no column moved); undefined elsewhere. */
  autoOrder?: { label: string; on: boolean };
  onClose: () => void; onRename?: () => void;
  /** A user column: whether it shows one card per task; undefined for others (search). */
  byTask?: boolean; onByTask: () => void; onSplit: () => void;
  /** Thread: the columns of tasks this task can join. */
  addTo: ColumnDef[]; onAddTo: (colId: string) => void; onPin: () => void; onWidth: (px: number) => void; onEdit: () => void; onMove: (dir: -1 | 1) => void; onDelete: () => void;
  /** The task or project this column shows, which can be deleted for good. */
  remove?: { label: string; onRemove: () => void }; onRemoved: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeItem = remove && (
    <button className="item danger" title="기록까지 모두 지우며 되돌릴 수 없습니다"
      onClick={() => { if (confirmRemove) { remove.onRemove(); onRemoved(); } else setConfirmRemove(true); }}>
      {confirmRemove ? '한 번 더 누르면 영구 삭제' : remove.label}
    </button>
  );
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [onClose]);
  const left = Math.max(8, Math.min(x - 236, window.innerWidth - 244));
  return (
    <div ref={ref} className="menu" role="menu" style={{ left, top: y + 4 }}>
      <div className="lbl"><span>컬럼 폭</span><span className="mono">{width}px</span></div>
      <div className="seg">
        {WIDTH_PRESETS.map((p) => (
          <button key={p.px} aria-pressed={p.px === width} onClick={() => onWidth(p.px)}>{p.label}<small>{p.px}</small></button>
        ))}
      </div>
      <div className="lbl"><span>오른쪽 가장자리를 끌거나 <kbd>&lt;</kbd> <kbd>&gt;</kbd></span></div>
      <hr />
      {thread ? (
        <>
          {onFloat && <button className="item" role="menuitemcheckbox" aria-checked={floating} onClick={onFloat}>
            {floating ? '✓ ' : ''}오른쪽 절반에 보기 <kbd>f</kbd></button>}
          <button className="item" onClick={onPin}>새 컬럼으로 고정 <kbd>p</kbd></button>
          {addTo.length > 0 && <div className="lbl"><span>이 작업을 컬럼에 추가</span></div>}
          {addTo.map((c) => <button key={c.id} className="item" onClick={() => onAddTo(c.id)}><Plus /> {c.title}</button>)}
          <hr />
          <button className="item" onClick={onDelete}>스레드 닫기 <kbd>q</kbd></button>
          {removeItem}
        </>
      ) : (
        <>
          {onRename && <button className="item" onClick={onRename}>이름 바꾸기</button>}
          {!fixed && <button className="item" onClick={onEdit}>작업·필터 편집 <kbd>e</kbd></button>}
          {byTask != null && <>
            <button className="item" role="menuitemcheckbox" aria-checked={byTask} onClick={onByTask}>
              {byTask ? '✓ ' : ''}작업별로 묶어 보기 <kbd>v</kbd></button>
            <button className="item" onClick={onSplit}>작업별 컬럼으로 나누기</button>
          </>}
          {reorderable && <>
          <button className="item" disabled={!canLeft} onClick={() => onMove(-1)}>왼쪽으로 <kbd>H</kbd></button>
          <button className="item" disabled={!canRight} onClick={() => onMove(1)}>오른쪽으로 <kbd>L</kbd></button>
          {sort !== undefined && (Object.keys(SORT_LABEL) as ViewSort[]).map((k) => (
            <button key={k} className="item" role="menuitemradio" aria-checked={sort === k} onClick={() => onSort(k)}>
              {sort === k ? '✓ ' : ''}{SORT_LABEL[k]} 정렬</button>
          ))}
          </>}
          {fixed && removeItem && <><hr />{removeItem}</>}
          {fixed ? <div className="lbl"><span>자동 뷰: 편집은 <kbd>F1</kbd> 내 컬럼에서</span></div> : <>
          <hr />
          <button className="item danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? '한 번 더 누르면 삭제' : '컬럼 삭제'} <kbd>D D</kbd>
          </button>
          </>}
        </>
      )}
    </div>
  );
}

const KEYS: [string, string][] = [
  ['j / k', '아래 / 위 글'], ['J / K', '다음 / 이전 작업의 글로 (같은 작업의 연속 글 건너뛰기, 프로젝트가 같아도 #번호가 다르면 다른 작업. 스레드에서는 다음 / 이전 내 글)'], ['Ctrl Shift J / K', '다음 / 이전 작업의 내 지시 글로 (같은 작업의 연속 글에서는 맨 위 지시 하나만)'], ['h / l', '왼쪽 / 오른쪽 컬럼'], ['gg / G', '맨 위 / 맨 아래'], ['gr', '전체 컬럼의 가장 최근 글로'],
  ['Enter', '선택한 글의 스레드 열기'], ['q / Esc', '스레드 닫기 · 검색 컬럼에서는 검색 닫기 · 그다음 작성 서랍 닫기 · 열린 창은 Esc로 닫기'], ['o / Space', '본문·도구 기록 펼치기'],
  ['r', '스레드를 열고 답글 쓰기 (터미널 작업은 질문에 답하기)'], ['i', '새 작업 (작성 서랍, Esc로 닫기, 쓰던 내용은 유지)'], ['y / n', '승인 / 거절 (선택한 작업)'], ['s', '작업 중단'],
  ['a', '응답 대기열 (j/k · y/n · Enter: 스레드·질문에 답하기 · Esc)'], ['< / >', '컬럼 폭 줄이기 / 늘리기'],
  ['F1 – F4', '뷰: 내 컬럼 / 프로젝트별 / 작업별 / 상태 보드 (F2–F4는 자동 구성, 편집은 F1에서)'], ['/', '검색 컬럼 열기 (#project: #status: #kind: #task: 필터, Enter: 결과로, 빈 칸에서 Esc: 닫기)'], ['c', '컬럼 추가'], ['p', '선택한 글의 작업을 컬럼으로 고정'], ['f', '스레드를 오른쪽 절반 / 컬럼으로 보기 (절반일 때 경계선을 끌어 폭 조절)'], ['t', '스레드로 가기 / 이전 컬럼으로 돌아가기 (절반일 때 h/l은 스레드를 건너뜀)'], ['e', '컬럼 편집: 이름·작업·프로젝트·종류·상태·검색어 (이름은 더블클릭으로도)'], ['v', '작업별로 묶어 보기 (작업마다 최근 글 하나) / 모든 글 보기'], ['D D', '컬럼 삭제'], ['H / L', '컬럼 왼쪽 / 오른쪽으로 옮기기 (F2에서는 옮긴 순서를 기억, 컬럼 메뉴에서 이름순·만든 순 정렬·자동 순서. F3은 늘 최근 활동순)'],
  ['⌘ Enter', '작성창·답 입력란에서 보내기'], ['Tab', '@프로젝트 · #태그 완성'], ['#auto / #ask', '이제부터 자동 승인 / 매번 확인'],
  ['#스킬이름', '그 메시지에만 데스크 스킬 적용 (상단 스킬 버튼에서 관리)'],
  ['#later / #now', '실행 중에 보낸 메시지: 턴이 끝난 뒤 (기본) / 지금 턴에 끼워넣기'],
  ['@프로젝트#2', '그 프로젝트의 2번 작업에 보내기 (번호는 스레드 머리에 표시)'],
  ['X / x', '컨텍스트 재구성 패널 열기 / 닫기 · 패널이 열려 있으면 선택한 스레드 글 고르기 (고른 글의 핵심을 정리본에 담아 새 세션으로 넘김)'],
  ['#new / #fork', '같은 프로젝트의 새 작업으로 (이전 대화 없이) / 대화를 이어받은 새 작업으로'], ['?', '이 도움말'],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="단축키" onClose={onClose}>
      <dl className="keys">
        {KEYS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
      </dl>
    </Modal>
  );
}

/**
 * The first post in `feed` whose bottom is below `top`. Posts lie top to bottom in document order,
 * so a binary search reads a handful of positions instead of every post above the view.
 */
function firstPostBelow(feed: HTMLElement, top: number): HTMLElement | undefined {
  const all = feed.querySelectorAll<HTMLElement>('[data-post]');
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return all[lo];
}

/** Drag the split thread's left edge to share the workspace; double-click restores half and half. */
function SplitHandle({ split, onResize }: { split: number; onResize: (pct: number | null) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <>
      {drag != null && <span className="wbadge">{drag}%</span>}
      <div className={`split-resize${drag != null ? ' dragging' : ''}`} title="끌어서 폭 조절 · 더블클릭은 절반"
        onDoubleClick={() => onResize(null)}
        onPointerDown={(e) => {
          e.preventDefault();
          const el = e.currentTarget, startX = e.clientX;
          const total = el.closest('.workspace')?.getBoundingClientRect().width ?? window.innerWidth;
          el.setPointerCapture(e.pointerId);
          document.body.classList.add('resizing');
          const move = (ev: PointerEvent) => {
            const pct = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(split + (startX - ev.clientX) / total * 100)));
            setDrag(pct);
            onResize(pct);
          };
          // A cancelled pointer or a lost capture ends the drag as a release does.
          const up = () => {
            setDrag(null);
            document.body.classList.remove('resizing');
            el.removeEventListener('pointermove', move);
            for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.removeEventListener(t, up);
          };
          el.addEventListener('pointermove', move);
          for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        }} />
    </>
  );
}

/** Snap to a preset when the drag ends this close to it. */
const SNAP = 12;

/** Drag the column's right edge to set a fixed width; double-click restores the default. */
function ResizeHandle({ width, onResize }: { width: number; onResize: (px: number | null) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <>
      {drag != null && <span className="wbadge">{drag}px</span>}
      <div className={`col-resize${drag != null ? ' dragging' : ''}`} title="끌어서 폭 조절 · 더블클릭은 기본값"
        onDoubleClick={() => onResize(null)}
        onPointerDown={(e) => {
          e.preventDefault();
          const el = e.currentTarget, startX = e.clientX;
          el.setPointerCapture(e.pointerId);
          document.body.classList.add('resizing');
          const at = (ev: PointerEvent) => {
            const raw = Math.round((width + ev.clientX - startX) / 10) * 10;
            return WIDTH_PRESETS.find((p) => Math.abs(p.px - raw) <= SNAP)?.px ?? raw;
          };
          const move = (ev: PointerEvent) => { const px = at(ev); setDrag(px); onResize(px); };
          // A cancelled pointer or a lost capture ends the drag as a release does.
          const up = () => {
            setDrag(null);
            document.body.classList.remove('resizing');
            el.removeEventListener('pointermove', move);
            for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.removeEventListener(t, up);
          };
          el.addEventListener('pointermove', move);
          for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        }} />
    </>
  );
}
