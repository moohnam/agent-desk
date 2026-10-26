import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from './api.ts';
import { isAsk } from './AskCard.tsx';
import { AccessDialog } from './AccessDialog.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { ApprovalQueue, QUEUE_ROWS, queueItems, type QueueItem } from './ApprovalQueue.tsx';
import { ColumnDialog, KIND_LABEL } from './ColumnDialog.tsx';
import { ComposeDrawer, DenyDialog, Modal, ReplyBox } from './Compose.tsx';
import { SkillsDialog } from './Skills.tsx';
import { MODE_LABEL, MODEL_LABEL } from '../../hub/src/compose.ts';
import { STATUS_LABEL, stalledMinutes, statusLabel } from './format.ts';
import { PostView } from './PostView.tsx';
import { draftsOf, pruneDrafts, useDraftTasks } from './drafts.ts';
import { DEFAULT_WIDTH, WIDTH_PRESETS, useColumnWidths, useColumns } from './columns.ts';
import { buildPosts, matches, placeFeed, placeThread } from './posts.ts';
import { modelShort, projectColor, projectListLabel } from './projects.ts';
import type { Approval, ColumnDef, ColumnFilter, HubEvent, PlacedPost, Post, Project, TaskStatus, TaskView } from './types.ts';
import { useColumnFeeds, useHub, useTaskEvents } from './useHub.ts';
import { SearchHead } from './Search.tsx';
import { parseSearch } from './search.ts';
import { VIEWS, viewColumns, useView, type View } from './views.ts';

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
  const { view, setView, byTask: viewByTask, setByTask: setViewByTask } = useView();
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
  // Recomputed on every tick, since a task stalls without any new message.
  const stalled = useMemo(() => {
    const now = Date.now();
    return new Set([...hub.tasks.values()].filter((t) => stalledMinutes(t, now) != null).map((t) => t.id));
  }, [hub.tasks, tick]);
  // F1 is the user's columns; F2–F4 are built from the tasks and only change "작업별로 묶어 보기".
  const editable = view === 'custom';
  const columns = useMemo(() => (view === 'custom' ? custom
    : viewColumns(view, hub.tasks, hub.projects, stalled, drafts, viewByTask)),
  [view, custom, hub.tasks, hub.projects, stalled, drafts, viewByTask]);
  const setColumns: typeof setCustom = editable ? setCustom : () => setToast(FIXED_NOTE);
  const switchView = (v: View) => {
    if (v === view) return;
    setView(v);
    setActive(0);
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
  const phone = useMedia(PHONE);
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
  const { feeds, loadEarlier: loadEarlierColumn } = useColumnFeeds(feedDefs, hub.tasks, hub.onEvent, hub.synced);
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
  const deck: DeckColumn[] = useMemo(() => {
    const column = (id: string, placed: PlacedPost[], def?: ColumnDef): DeckColumn =>
      ({ id, def, placed, posts: placed.map((x) => x.post) });
    const cols = deckDefs.map((c) => {
      const posts = (columnPosts.get(c.id) ?? []).filter((p) => matches(c.filter, p, hub.tasks.get(p.taskId)));
      return column(c.id, c.byTask ? newestPerTask(posts) : placeFeed(posts), c);
    });
    if (threadTask) cols.splice(threadSlot(threadAfter), 0, column(THREAD, placeThread(threadPosts)));
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
    const el = [...feed.querySelectorAll<HTMLElement>('[data-post]')].find((x) => x.getBoundingClientRect().bottom > feedTop);
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
  /** Older posts of a feed column, loaded at its bottom by button or by scrolling there. */
  const olderOf = (colId: string) => {
    const f = feeds.get(colId);
    return { more: !!f?.more, loading: !!f?.loading, load: () => loadEarlierColumn(colId) };
  };
  // A filtered column may find nothing (or too little to scroll) in the recent events: keep loading
  // older pages until it fills its height or the history runs out.
  useEffect(() => {
    for (const col of deck) {
      if (col.id === THREAD) continue;
      const feed = document.querySelector<HTMLElement>(`section[data-col="${col.id}"] .feed`);
      const older = olderOf(col.id);
      if (feed && older.more && !older.loading && feed.scrollHeight - feed.clientHeight < 300) { older.load(); return; }
    }
  });
  const onFeedScroll = (colId: string, feed: HTMLElement) => {
    const older = olderOf(colId);
    if (older.more && !older.loading && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 300) older.load();
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

  const queue = useMemo(() => queueItems(hub.approvals.values(), hub.questions.values()), [hub.approvals, hub.questions]);
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
  /** Scrolls a column's feed (only it, not the deck) to show a post. */
  const revealPost = (colId: string, postId: number) => {
    const feed = document.querySelector(`section[data-col="${colId}"] .feed`);
    const el = feed?.querySelector(`[data-post="${postId}"]`);
    if (!feed || !el) return;
    const top = el.getBoundingClientRect().top - feed.getBoundingClientRect().top;
    const bottom = top + el.getBoundingClientRect().height;
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
  // Keep the selected post (or column) visible.
  useEffect(() => {
    if (!activeCol) return;
    revealColumn(activeCol.id, activeCol.id === THREAD ? deck[activeIdx - 1]?.id : undefined);
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
    const el = [...feed.querySelectorAll<HTMLElement>('[data-post]')].find((x) => x.getBoundingClientRect().bottom > feedTop);
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
  }, [threadTask, threadAt]);
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
    if (item.kind === 'question' || isAsk(item.approval.tool_name)) answerQuestion(item.task_id, item.id);
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
  /** "작성 중": opens the threads holding unsent text in turn, with the cursor in that box. */
  const jumpDraft = () => {
    const list = [...drafts].filter((id) => hub.tasks.has(id))
      .sort((a, b) => hub.tasks.get(b)!.updated_at.localeCompare(hub.tasks.get(a)!.updated_at));
    if (!list.length) return;
    const i = (jumpIndex.current.draft ?? -1) + 1;
    jumpIndex.current.draft = i;
    const taskId = list[i % list.length];
    const key = draftsOf(taskId).find((k) => !k.startsWith('reply:'));
    if (key) answerQuestion(taskId, key.slice(key.indexOf(':') + 1));
    else replyTo(taskId, activeCol?.id);
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
    setColumns(next);
    setFocusCol(id!);
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
        case 'h': case 'ArrowLeft': focusColumn(activeIdx - 1); break;
        case 'l': case 'ArrowRight': focusColumn(activeIdx + 1); break;
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
          <button className="btn primary" title="새 작업 (i)" onClick={() => (drawer ? setDrawer(false) : openDrawer())}>
            새 작업 <kbd>i</kbd>
          </button>
          <button className="btn" title="스킬 관리: #스킬이름으로 메시지에 적용" onClick={() => setSkillsOpen(true)}>스킬</button>
          <button className="btn" title="새 작업의 엔진별 기본 모델과 effort: 작업마다 #opus #sonnet #haiku · #sol #astra #terra #luna · #low … #max (#ultra는 Codex)" onClick={() => setModelOpen(true)}>모델</button>
          {hub.local && <button className="btn" title="같은 네트워크의 폰이나 다른 기기에서 열기: QR 코드" onClick={() => setAccessOpen(true)}>폰에서 열기</button>}
          <button className="btn help-btn" title="단축키 (?)" onClick={() => setHelp(true)}>?</button>
        </div>
      </header>

      {hub.connected && hub.runnerConnected === false && (
        <div className="runner-warn" role="alert">러너 연결이 끊겼습니다. 실행 중인 세션 상태를 확인할 수 없습니다.</div>
      )}

      <ApprovalQueue items={queue} tasks={hub.tasks} drafts={drafts} focus={queueFocus} showAll={queueAll}
        onShowAll={setQueueAll} onAllow={allow} onDeny={setDenying} onOpen={openQueueItem} onFocus={setQueueFocus} />

      <div className="workspace">
        {drawer && (
          <ComposeDrawer projects={hub.projects} tasks={[...hub.tasks.values()]} inputRef={composeRef}
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
          {deck.map((col, i) => {
            const isThread = col.id === THREAD;
            return (
              <section key={col.id} data-col={col.id}
                className={`column${i === activeIdx ? ' focused' : ''}${isThread ? ' thread' : ''}`}
                style={{ '--w': `${widthOf(col.id)}px`,
                  ...(isThread && threadTaskView ? { '--pc': projectColor(threadTaskView.project_id) } : {}) } as CSSProperties}
                onMouseDown={() => { press(); setActive(i); setQueueFocus(null); }}>
                {isThread ? (
                  <ThreadHead task={threadTaskView} project={threadTaskView && projectsById.get(threadTaskView.project_id)}
                    model={threadTask ? models.get(threadTask) : undefined} events={threadEvents} now={now} draft={!!threadTask && drafts.has(threadTask)}
                    onClose={closeThread} onPin={() => threadTask && pinTask(threadTask)}
                    onMenu={(r) => setMenu({ colId: col.id, x: r.right, y: r.bottom })} />
                ) : col.id === SEARCH ? (
                  <SearchHead value={search ?? ''} onChange={setSearch} inputRef={searchRef} projects={hub.projects}
                    tasks={[...hub.tasks.values()]} count={`${col.posts.length}${feeds.get(SEARCH)?.more ? '+' : ''}`}
                    unknown={parsedSearch.unknown} onDone={searchResults} onClose={closeSearch} onSave={saveSearch} />
                ) : (
                  <ColumnHead def={col.def!} count={col.posts.length} projects={projectsById} tasks={hub.tasks}
                    renaming={renaming === col.id} onRenaming={(on) => setRenaming(on && editable ? col.id : null)}
                    onRename={(title) => setColumns((cs) => cs.map((c) => (c.id === col.id ? { ...c, title } : c)))}
                    onMenu={(r) => setMenu({ colId: col.id, x: r.right, y: r.bottom })} />
                )}
                <div className={`feed${isThread ? ' thread-feed' : ''}`}
                  onScroll={isThread ? (e) => { const f = e.currentTarget; threadAtBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40; }
                    : (e) => onFeedScroll(col.id, e.currentTarget)}>
                  {!isThread && unseen[col.id] ? (
                    <div className="new-posts">
                      <button onClick={() => showNewest(col.id)}>↑ 새 글 {unseen[col.id]}개</button>
                    </div>
                  ) : null}
                  {isThread && threadMore && (
                    <div className="older-posts">
                      <button disabled={threadLoadingEarlier} onClick={loadEarlierThread}>
                        {threadLoadingEarlier ? '불러오는 중…' : '↑ 이전 기록 더 보기'}
                      </button>
                    </div>
                  )}
                  {isThread
                    ? col.placed.map((pp) => renderPost(pp, col.id, i, true))
                    : groupsOf(col.placed).map((group) => {
                        const task = hub.tasks.get(group[0].post.taskId);
                        const pending = group.some(({ post }) => !post.resolution
                          && (post.kind === 'approval' ? hub.approvals.has(post.event.payload.approvalId)
                            : post.kind === 'question' && hub.questions.has(post.event.payload.questionId)));
                        return (
                          <div key={group[group.length - 1].post.id} className={`group${pending ? ' has-approval' : ''}`}
                            style={task ? { '--pc': projectColor(task.project_id), '--th': taskHue(task.seq) } as CSSProperties : undefined}>
                            {task && <GroupContext task={task} now={now} onOpen={() => openThread(task.id, { from: col.id })} />}
                            {group.map((pp) => renderPost(pp, col.id, i, false))}
                          </div>
                        );
                      })}
                  {col.posts.length === 0 && (
                    <p className="empty">{col.id === SEARCH && !searching ? '검색어나 #project: 같은 필터를 입력하세요.' : isThread ? (threadLoaded && !threadMore && !threadLoadingEarlier ? '글이 없습니다.' : '불러오는 중…') : hub.events.length === 0
                      ? 'i를 눌러 첫 작업을 시작하세요.' : feeds.get(col.id)?.loading ? '불러오는 중…' : '조건에 맞는 글이 없습니다.'}</p>
                  )}
                  {!isThread && (() => {
                    const older = olderOf(col.id);
                    return older.more && (
                      <div className="older-posts">
                        <button disabled={older.loading} onClick={older.load}>
                          {older.loading ? '불러오는 중…' : '↓ 이전 글 더 보기'}
                        </button>
                      </div>
                    );
                  })()}
                </div>
                {isThread && threadTaskView && (threadTaskView.source === 'external' ? (
                  <ExternalNote pending={!!questionOf(threadTaskView.id)}
                    onAnswer={() => { const q = questionOf(threadTaskView.id); if (q) answerQuestion(threadTaskView.id, q); }} />
                ) : (
                  <ReplyBox key={threadTaskView.id} task={threadTaskView} inputRef={replyRef} onError={setToast} onSend={onThreadSend} />
                ))}
                <ResizeHandle width={widthOf(col.id)} onResize={(px) => setWidth(col.id, px)} />
              </section>
            );
          })}
          {!phone && editable && (
            <button className="add-col" title="컬럼 추가 (c)" onClick={() => setColumnDialog({})}>
              <span>＋ 컬럼 추가</span><kbd>c</kbd>
            </button>
          )}
        </main>
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
          fixed={!editable}
          onRename={menuDef >= 0 && editable ? () => { setRenaming(menu.colId); setMenu(null); } : undefined}
          addTo={menu.colId === THREAD && threadTask ? custom.filter((c) => c.filter.taskIds?.length && !c.filter.taskIds.includes(threadTask)) : []}
          onAddTo={(colId) => { if (threadTask) addToColumn(colId, threadTask); setMenu(null); }}
          onPin={() => { if (threadTask) pinTask(threadTask); setMenu(null); }}
          byTask={menuDef >= 0 ? !!columns[menuDef].byTask : undefined}
          onByTask={() => { toggleByTask(menu.colId); setMenu(null); }}
          onSplit={() => { splitColumn(menu.colId); setMenu(null); }}
          canLeft={menuDef > 0} canRight={menuDef >= 0 && menuDef < columns.length - 1} onClose={() => setMenu(null)}
          onWidth={(px) => setWidth(menu.colId, px)}
          onEdit={() => { if (menu.colId === SEARCH) openSearch(); else setColumnDialog({ column: deck[menuCol].def }); setMenu(null); }}
          onMove={(dir) => { moveColumn(menuCol, dir); setMenu(null); }}
          onDelete={() => { if (menu.colId === THREAD) closeThread(); else deleteColumn(menu.colId); setMenu(null); }} />
      )}
      {denying && <DenyDialog approval={denying} onClose={() => setDenying(null)} onDone={() => setDenying(null)} />}
      {columnDialog && (
        <ColumnDialog column={columnDialog.column} projects={hub.projects} tasks={[...hub.tasks.values()]}
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
      {modelOpen && <ModelDialog onClose={() => setModelOpen(false)} />}
    </div>
  );
}

/** Marks a task holding unsent text in its reply or answer box. */
export function DraftBadge() {
  return <span className="draft-badge" title="보내지 않은 답글이 있습니다 (이 기기에 저장됨)">✎ 작성 중</span>;
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
  return <span className={`badge ${task.status}`}>{statusLabel(task)}</span>;
}

function TerminalBadge() {
  return <span className="badge term" title="터미널에서 실행 중인 세션이 MCP로 붙었습니다. 앱에서는 질문에만 답할 수 있습니다.">터미널</span>;
}

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

function ColumnHead({ def, count, projects, tasks, renaming, onRenaming, onRename, onMenu }: {
  def: ColumnDef; count: number; projects: Map<string, Project>; tasks: Map<string, TaskView>;
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
      <span className="count">{count}</span>
      <span className="filter" title={label}>{label}</span>
      <button className="icon-btn" title="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}>⋯</button>
    </header>
  );
}

function ThreadHead({ task, project, model, events, now, draft, onClose, onPin, onMenu }: {
  task: TaskView | undefined; project: Project | undefined; model: string | undefined; events: HubEvent[];
  now: number; draft: boolean; onClose: () => void; onPin: () => void; onMenu: (r: DOMRect) => void;
}) {
  const turns = events.filter((e) => e.kind === 'status' && e.payload.state === 'turn_done').length;
  return (
    <header className="thread-head">
      <div className="row1">
        <button className="back" title="스레드 닫기 (q)" onClick={onClose}>←</button>
        {task && <span className="thread-chip" style={{ '--pc': projectColor(task.project_id) } as CSSProperties} title={project?.root_path}>{task.project_name}#{task.seq}</span>}
        <h2 title={task?.title}>{task?.title ?? '스레드'}</h2>
        {task?.source === 'external' && <TerminalBadge />}
        {task && <StatusBadge task={task} now={now} />}
        {draft && <DraftBadge />}
        {task && <button className="icon-btn" title="컬럼으로 고정 (p)" onClick={onPin}>📌</button>}
        <button className="icon-btn" title="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}>⋯</button>
      </div>
      {task && (
        <div className="meta">
          <span title={project?.root_path}><span className="pdot" style={{ background: projectColor(task.project_id) }} />{task.project_name}
            <span className="seq" title={`@${task.project_name}#${task.seq}로 이 작업에 보낼 수 있습니다`}>#{task.seq}</span></span>
          <span title="모델은 #opus #sonnet #haiku(Claude) 또는 #sol #astra #terra #luna(Codex), effort는 #low … #max(#ultra는 Codex) 태그로 바꿉니다">
            {task.engine === 'codex' ? 'Codex' : 'Claude'}{model ? ` · ${modelShort(model)}` : ''}
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
function ColumnMenu({ x, y, width, thread, fixed, canLeft, canRight, onClose, onWidth, onRename, addTo, onAddTo, onPin, byTask, onByTask, onSplit, onEdit, onMove, onDelete }: {
  x: number; y: number; width: number; thread: boolean; canLeft: boolean;
  /** A column of a built view (F2–F4): only width and grouping change. */
  fixed: boolean; canRight: boolean;
  onClose: () => void; onRename?: () => void;
  /** A user column: whether it shows one card per task; undefined for others (search). */
  byTask?: boolean; onByTask: () => void; onSplit: () => void;
  /** Thread: the columns of tasks this task can join. */
  addTo: ColumnDef[]; onAddTo: (colId: string) => void; onPin: () => void; onWidth: (px: number) => void; onEdit: () => void; onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);
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
          <button className="item" onClick={onPin}>새 컬럼으로 고정 <kbd>p</kbd></button>
          {addTo.length > 0 && <div className="lbl"><span>이 작업을 컬럼에 추가</span></div>}
          {addTo.map((c) => <button key={c.id} className="item" onClick={() => onAddTo(c.id)}>＋ {c.title}</button>)}
          <hr />
          <button className="item" onClick={onDelete}>스레드 닫기 <kbd>q</kbd></button>
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
          {fixed ? <div className="lbl"><span>자동 뷰: 편집은 <kbd>F1</kbd> 내 컬럼에서</span></div> : <>
          <button className="item" disabled={!canLeft} onClick={() => onMove(-1)}>왼쪽으로 <kbd>H</kbd></button>
          <button className="item" disabled={!canRight} onClick={() => onMove(1)}>오른쪽으로 <kbd>L</kbd></button>
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
  ['Enter', '선택한 글의 스레드 열기'], ['q / Esc', '스레드 닫기 · 검색 컬럼에서는 검색 닫기'], ['o / Space', '본문·도구 기록 펼치기'],
  ['r', '스레드를 열고 답글 쓰기 (터미널 작업은 질문에 답하기)'], ['i', '새 작업 (작성 서랍)'], ['Ctrl `', '작성 서랍 열기 / 닫기 (입력 중에도, 쓰던 내용은 유지)'], ['y / n', '승인 / 거절 (선택한 작업)'], ['s', '작업 중단'],
  ['a', '응답 대기열 (j/k · y/n · Enter: 스레드·질문에 답하기 · Esc)'], ['< / >', '컬럼 폭 줄이기 / 늘리기'],
  ['F1 – F4', '뷰: 내 컬럼 / 프로젝트별 / 작업별 / 상태 보드 (F2–F4는 자동 구성, 편집은 F1에서)'], ['/', '검색 컬럼 열기 (#project: #status: #kind: #task: 필터, Enter: 결과로, 빈 칸에서 Esc: 닫기)'], ['c', '컬럼 추가'], ['p', '선택한 글의 작업을 컬럼으로 고정'], ['e', '컬럼 편집: 이름·작업·프로젝트·종류·상태·검색어 (이름은 더블클릭으로도)'], ['v', '작업별로 묶어 보기 (작업마다 최근 글 하나) / 모든 글 보기'], ['D D', '컬럼 삭제'], ['H / L', '컬럼 왼쪽 / 오른쪽으로 옮기기'],
  ['⌘ Enter', '작성창·답 입력란에서 보내기'], ['Tab', '@프로젝트 · #태그 완성'], ['#auto / #ask', '이제부터 자동 승인 / 매번 확인'],
  ['#스킬이름', '그 메시지에만 데스크 스킬 적용 (상단 스킬 버튼에서 관리)'],
  ['#later / #now', '실행 중에 보낸 메시지: 턴이 끝난 뒤 (기본) / 지금 턴에 끼워넣기'],
  ['@프로젝트#2', '그 프로젝트의 2번 작업에 보내기 (번호는 스레드 머리에 표시)'],
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
          const up = () => {
            setDrag(null);
            document.body.classList.remove('resizing');
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }} />
    </>
  );
}
