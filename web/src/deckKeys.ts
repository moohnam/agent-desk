// The deck's keys (vim-style) and their help table: one handler for the window's keydown. What it
// may read and do is the DeckKeyContext the app hands it on each render.

import type { RefObject } from 'react';
import { api } from './api.ts';
import type { DeckColumn } from './FeedColumn.tsx';
import { pickable, toggleHandoff, togglePick, type HandoffState } from './Handoff.tsx';
import type { QueueItem } from './ApprovalQueue.tsx';
import { latinKey, nextMineIndex, nextTaskIndex, nextUserIndex, replyTaskId } from './keys.ts';
import { SEARCH, THREAD } from './layout.ts';
import { modalOpen } from './Modal.tsx';
import type { Approval, ColumnDef, Post, TaskView } from './types.ts';
import { VIEWS, type View } from './views.ts';

/** `<` and `>` change the active column's width by this much. */
export const WIDTH_STEP = 40;
/** Shown when a built view (F2–F4) is asked to change its columns. */
export const FIXED_NOTE = '자동으로 만든 뷰는 편집할 수 없습니다. F1(내 컬럼)에서 편집하세요.';

/** The help (?): each key and what it does. Keep it in step with onDeckKey below. */
export const KEY_GROUPS: { title: string; keys: [string, string, string?][] }[] = [
  { title: '이동·글 보기', keys: [
    ['j / k', '아래 / 위 글', '방향키 ↓ / ↑도 사용할 수 있습니다.'],
    ['h / l', '왼쪽 / 오른쪽 컬럼', '방향키 ← / →도 사용할 수 있습니다.'],
    ['J / K', '다음 / 이전 작업의 글', '같은 작업의 연속 글은 건너뜁니다. 스레드에서는 내 글 사이를 이동합니다.'],
    ['Ctrl Shift J / Ctrl Shift K', '다음 / 이전 작업의 내 지시', '같은 작업의 연속 글에서는 맨 위 지시 하나만 선택합니다.'],
    ['gg / G', '맨 위 / 맨 아래 글'],
    ['gh / gl', '맨 왼쪽 / 맨 오른쪽 컬럼'],
    ['gr', '전체 컬럼의 최신 글', '필터 없는 전체 컬럼이 있어야 합니다.'],
    ['o / Space', '본문·도구 기록 펼치기 / 접기'],
  ] },
  { title: '검색·스레드', keys: [
    [';', '컬럼 찾기', '아직 표시하지 않은 컬럼도 검색합니다. ↑↓ 또는 Ctrl N/P로 고르고 Enter로 이동합니다.'],
    ['/', '내용 검색', '스레드 선택 시 해당 작업만 검색합니다. #task: 필터를 지우면 전체 검색으로 바뀝니다. PC 화면에서 사용합니다.'],
    ['Enter', '선택한 글의 스레드 열기'],
    ['q / Esc', '스레드·검색·작성 서랍 닫기', '현재 검색 컬럼을 먼저 닫고, 스레드와 작성 서랍 순으로 닫습니다. 열린 창은 Esc로 닫습니다.'],
    ['f', '스레드를 분할 / 컬럼으로 보기', '분할 화면의 경계선을 끌어 폭을 조절합니다.'],
    ['t', '스레드 / 이전 컬럼으로 이동', '분할 화면에서 h/l은 스레드를 건너뜁니다.'],
  ] },
  { title: '작업·응답', keys: [
    ['i', '새 작업 작성', 'Esc로 닫아도 쓰던 내용은 유지됩니다.'],
    ['r', '답글 쓰기·질문에 답하기', '작업 컬럼은 선택한 글 또는 최신 글 기준입니다. RSS·봇 컬럼은 선택 자료로 채널 대화를 엽니다. 터미널 작업은 질문에 답합니다.'],
    ['y / n', '선택한 글의 작업 승인 / 거절', '질문형 승인 요청에서 y는 답변 화면을 엽니다.'],
    ['s', '선택한 글·스레드의 작업 중단'],
    ['a', '좌측 하단 응답 패널 열기 / 접기', 'j/k로 이동, y/n으로 승인·거절, Enter로 스레드·답변 열기, Esc로 접기.'],
    ['X', '컨텍스트 재구성 패널 열기 / 닫기', '고른 글을 정리해 새 세션으로 넘깁니다. 데스크가 실행한 작업에서 사용합니다.'],
    ['x', '정리본에 담을 글 선택 / 해제', '재구성 패널을 연 뒤 스레드의 글을 선택합니다.'],
  ] },
  { title: '뷰·컬럼 관리', keys: [
    ['F1 – F4', '내 컬럼 / 프로젝트 / 작업 / 상태', 'F2–F4는 자동 구성됩니다. 컬럼 추가·편집·삭제는 F1에서 합니다. Mac은 fn 키가 필요할 수 있습니다.'],
    ['c', '컬럼 추가'],
    ['e', '컬럼 조건 편집', '이름은 더블클릭으로도 바꿉니다. 검색 컬럼에서는 검색 입력란으로 이동합니다.'],
    ['p', '선택한 글·스레드의 작업을 컬럼으로 고정'],
    ['v', '작업별 최신 글 / 모든 글 보기'],
    ['< / >', '컬럼 폭 줄이기 / 늘리기'],
    ['H / L', '컬럼을 왼쪽 / 오른쪽으로 옮기기', 'F1·F2에서 사용합니다. F2는 순서를 기억하고 F3은 최근 활동순을 유지합니다.'],
    ['DD', '컬럼 삭제', 'D를 두 번 눌러 확인합니다.'],
  ] },
  { title: '입력·도움말', keys: [
    ['⌘ Enter / Ctrl Enter', '작성창·답 입력란에서 보내기', '스레드 답글을 대기열에 넣은 뒤 입력을 수정하지 않고 같은 입력란에서 다시 누르면, 방금 넣은 메시지 하나만 지금 보냅니다.'],
    ['Tab / Enter', '@프로젝트·#태그 제안 선택', '제안 목록이 열려 있을 때 사용합니다. ↑↓로 이동하고 Esc로 제안을 닫습니다.'],
    ['?', '단축키 도움말 열기 / 닫기', '상단 키보드 버튼으로도 열 수 있습니다.'],
  ] },
  { title: '메시지에 쓰는 태그', keys: [
    ['@프로젝트#2', '지정한 작업에 보내기', '작업 번호는 스레드 머리에 표시됩니다.'],
    ['#스킬이름', '이 메시지에 데스크 스킬 적용', '상단 스킬 버튼에서 관리합니다.'],
    ['#auto / #ask', '이후 자동 승인 / 매번 확인'],
    ['#later / #now', '턴이 끝난 뒤 전달 / 지금 끼워 넣기', '실행 중인 작업에 보낼 때 적용합니다. 기본은 #later입니다.'],
    ['#new / #fork', '새 작업 / 대화를 이어받은 새 작업', '같은 프로젝트에 만들며 #new는 이전 대화 없이 시작합니다.'],
  ] },
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

    if (activeCol?.def?.channelId && ['y', 'n', 's', 'X', 'x', 'p', 'v'].includes(e.key)) {
      setToast('알림 원본에는 작업 명령을 사용할 수 없습니다. 채널 대화는 r로 엽니다.');
      e.preventDefault();
      return;
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
        const taskId = replyTaskId(selectedPost, activeCol?.id === THREAD ? threadTask : null, activeCol?.def?.filter.taskIds, posts[0]);
        if (taskId && tasks.has(taskId)) replyTo(taskId, activeCol?.id);
        else setToast('답글을 보낼 작업이 없습니다.');
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
