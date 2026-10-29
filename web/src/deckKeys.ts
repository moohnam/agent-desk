// The deck's keys (vim-style) and their help table: one handler for the window's keydown. What it
// may read and do is the DeckKeyContext the app hands it on each render.

import type { RefObject } from 'react';
import { api } from './api.ts';
import type { DeckColumn } from './FeedColumn.tsx';
import { pickable, toggleHandoff, togglePick, type HandoffState } from './Handoff.tsx';
import type { QueueItem } from './ApprovalQueue.tsx';
import { latinKey, nextMineIndex, nextTaskIndex, nextUserIndex } from './keys.ts';
import { SEARCH, THREAD } from './layout.ts';
import { modalOpen } from './Modal.tsx';
import type { Approval, ColumnDef, Post, TaskView } from './types.ts';
import { VIEWS, type View } from './views.ts';

/** `<` and `>` change the active column's width by this much. */
export const WIDTH_STEP = 40;
/** Shown when a built view (F2–F4) is asked to change its columns. */
export const FIXED_NOTE = '자동으로 만든 뷰는 편집할 수 없습니다. F1(내 컬럼)에서 편집하세요.';

/** The help (?): each key and what it does. Keep it in step with onDeckKey below. */
export const KEYS: [string, string][] = [
  ['j / k', '아래 / 위 글'], ['J / K', '다음 / 이전 작업의 글로 (같은 작업의 연속 글 건너뛰기, 프로젝트가 같아도 #번호가 다르면 다른 작업. 스레드에서는 다음 / 이전 내 글)'], ['Ctrl Shift J / K', '다음 / 이전 작업의 내 지시 글로 (같은 작업의 연속 글에서는 맨 위 지시 하나만)'], ['h / l', '왼쪽 / 오른쪽 컬럼'], ['gg / G', '맨 위 / 맨 아래'], ['gr', '전체 컬럼의 가장 최근 글로'], ['gh / gl', '맨 왼쪽 / 맨 오른쪽 컬럼으로'],
  ['Enter', '선택한 글의 스레드 열기'], ['q / Esc', '스레드 닫기 · 검색 컬럼에서는 검색 닫기 · 그다음 작성 서랍 닫기 · 열린 창은 Esc로 닫기'], ['o / Space', '본문·도구 기록 펼치기'],
  ['r', '스레드를 열고 답글 쓰기 (터미널 작업은 질문에 답하기)'], ['i', '새 작업 (작성 서랍, Esc로 닫기, 쓰던 내용은 유지)'], ['y / n', '승인 / 거절 (선택한 작업)'], ['s', '작업 중단'],
  ['a', '응답 대기열 (j/k · y/n · Enter: 스레드·질문에 답하기 · Esc)'], ['< / >', '컬럼 폭 줄이기 / 늘리기'],
  ['F1 – F4', '뷰: 내 컬럼 / 프로젝트별 / 작업별 / 상태 보드 (F2–F4는 자동 구성, 편집은 F1에서)'], [';', '컬럼 찾기: 지금 뷰의 컬럼을 이름 일부로 찾아 이동 (↑↓·Ctrl N/P로 고르고 Enter)'], ['/', '검색 컬럼 열기 (#project: #status: #kind: #task: 필터, Enter: 결과로, 빈 칸에서 Esc: 닫기)'], ['c', '컬럼 추가'], ['p', '선택한 글의 작업을 컬럼으로 고정'], ['f', '스레드를 오른쪽 절반 / 컬럼으로 보기 (절반일 때 경계선을 끌어 폭 조절)'], ['t', '스레드로 가기 / 이전 컬럼으로 돌아가기 (절반일 때 h/l은 스레드를 건너뜀)'], ['e', '컬럼 편집: 이름·작업·프로젝트·종류·상태·검색어 (이름은 더블클릭으로도)'], ['v', '작업별로 묶어 보기 (작업마다 최근 글 하나) / 모든 글 보기'], ['D D', '컬럼 삭제'], ['H / L', '컬럼 왼쪽 / 오른쪽으로 옮기기 (F2에서는 옮긴 순서를 기억, 컬럼 메뉴에서 이름순·만든 순 정렬·자동 순서. F3은 늘 최근 활동순)'],
  ['⌘ Enter', '작성창·답 입력란에서 보내기'], ['Tab', '@프로젝트 · #태그 완성'], ['#auto / #ask', '이제부터 자동 승인 / 매번 확인'],
  ['#스킬이름', '그 메시지에만 데스크 스킬 적용 (상단 스킬 버튼에서 관리)'],
  ['#later / #now', '실행 중에 보낸 메시지: 턴이 끝난 뒤 (기본) / 지금 턴에 끼워넣기'],
  ['@프로젝트#2', '그 프로젝트의 2번 작업에 보내기 (번호는 스레드 머리에 표시)'],
  ['X / x', '컨텍스트 재구성 패널 열기 / 닫기 · 패널이 열려 있으면 선택한 스레드 글 고르기 (고른 글의 핵심을 정리본에 담아 새 세션으로 넘김)'],
  ['#new / #fork', '같은 프로젝트의 새 작업으로 (이전 대화 없이) / 대화를 이어받은 새 작업으로'], ['?', '이 도움말'],
];

export interface DeckKeyContext {
  // What the deck shows and is in the middle of
  help: boolean;
  /** An open column menu (it takes the keys). */
  menu: unknown;
  phone: boolean;
  drawer: boolean;
  /** Whether the view's columns can be changed (F1). */
  editable: boolean;
  queue: QueueItem[];
  /** The focused row of the response queue, when the queue has the keys. */
  queueFocus: number | null;
  activeCol: DeckColumn | undefined;
  activeIdx: number;
  selectedPost: Post | undefined;
  threadTask: string | null;
  tasks: Map<string, TaskView>;
  handoff: HandoffState | undefined;
  /** When `g` and `D` were last pressed, for `gg`, `gr` and `DD`. */
  pendingG: RefObject<number>;
  pendingDelete: RefObject<number>;
  // What the keys do
  switchView: (v: View) => void;
  setHelp: (open: boolean) => void;
  setQueueFocus: (row: number | null) => void;
  allow: (a: Approval) => void;
  setDenying: (a: Approval) => void;
  setToast: (text: string) => void;
  fail: (err: unknown) => void;
  openQueueItem: (item: QueueItem) => void;
  select: (colId: string, postId: number) => void;
  goRecent: () => void;
  stepColumn: (dir: 1 | -1) => void;
  edgeColumn: (dir: 1 | -1) => void;
  moveColumn: (from: number, dir: 1 | -1) => void;
  focusColumn: (i: number) => void;
  openThread: (taskId: string, at?: { from?: string; post?: number }) => void;
  closeThread: () => void;
  toggleThreadFocus: () => void;
  toggleFloat: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  setDrawer: (open: boolean) => void;
  openDrawer: () => void;
  toggleExpanded: (postId: number) => void;
  replyTo: (taskId: string, from?: string) => void;
  approvalFor: (post: Post | undefined) => Approval | undefined;
  setColumnDialog: (d: { column?: ColumnDef }) => void;
  pinTask: (taskId: string) => void;
  toggleByTask: (colId: string) => void;
  setFinder: (open: boolean) => void;
  deleteColumn: (id: string) => void;
  setWidth: (id: string, px: number | null) => void;
  widthOf: (id: string) => number;
}

/** Handles a key pressed anywhere in the app; ignored while typing or while a dialog or menu is open. */
export function onDeckKey(ev: KeyboardEvent, c: DeckKeyContext) {
    const {
      help, menu, phone, drawer, editable, queue, queueFocus, activeCol,
      activeIdx, selectedPost, threadTask, tasks, handoff, pendingG, pendingDelete, switchView,
      setHelp, setQueueFocus, allow, setDenying, setToast, fail, openQueueItem, select,
      goRecent, stepColumn, edgeColumn, moveColumn, focusColumn, openThread, closeThread, toggleThreadFocus, toggleFloat,
      openSearch, closeSearch, setDrawer, openDrawer, toggleExpanded, replyTo, approvalFor, setColumnDialog,
      pinTask, toggleByTask, setFinder, deleteColumn, setWidth, widthOf,
    } = c;
    // Ctrl+Shift+J / K: only the user's own instructions; every other Ctrl/Alt/Cmd chord is left alone.
    const mine = ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey && (ev.code === 'KeyJ' || ev.code === 'KeyK');
    // Any open dialog, not a list of them that a new one can be left out of; help handles its own keys below.
    if ((modalOpen() && !help) || menu || ev.metaKey || (ev.ctrlKey && !mine) || ev.altKey) return;
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
    // In a thread every post is the same task, so J / K step between the user's own posts instead.
    const nextUser = (dir: 1 | -1) => {
      const i = nextUserIndex(posts, cur, dir);
      if (i != null) go(i);
      else setToast(dir > 0 ? '아래에 내 글이 더 없습니다.' : '위에 내 글이 더 없습니다.');
    };
    const nextTask = (dir: 1 | -1) => (activeCol?.id === THREAD ? nextUser(dir) : go(nextTaskIndex(posts, cur, dir)));
    const nextMine = (dir: 1 | -1) => {
      const i = nextMineIndex(posts, cur, dir);
      if (i != null) go(i);
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
    // `gh` / `gl`: the leftmost / rightmost column.
    if ((e.key === 'h' || e.key === 'l') && now - pendingG.current < 600) {
      pendingG.current = 0;
      edgeColumn(e.key === 'h' ? -1 : 1);
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
        else if (drawer) setDrawer(false);
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
        if (threadTask && tasks.get(threadTask)?.source === 'app') toggleHandoff(threadTask);
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
      case ';': setFinder(true); break;
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
}
