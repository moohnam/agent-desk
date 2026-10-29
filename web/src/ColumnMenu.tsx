import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { WIDTH_PRESETS } from './columns.ts';
import type { ColumnDef } from './types.ts';
import { SORT_LABEL, type View, type ViewSort } from './views.ts';

/** What a built view's own column order follows. */
export const AUTO_ORDER: Partial<Record<View, string>> = { project: '최근 만든 작업순' };

/** The ⋯ menu: width presets plus column actions, anchored under its button. */
export function ColumnMenu({ x, y, width, thread, floating, onFloat, fixed, reorderable, sort, autoOrder, onSort, canLeft, canRight, onClose, onWidth, onRename, addTo, onAddTo, onPin, byTask, onByTask, onSplit, onEdit, onMove, onDelete, remove, onRemoved }: {
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
          {autoOrder && <button className="item" role="menuitemradio" aria-checked={autoOrder.on} onClick={() => onSort(null)}
            title="정렬과 직접 옮긴 순서를 풀고 이 뷰의 자동 순서로">{autoOrder.on ? '✓ ' : ''}자동 순서 ({autoOrder.label})</button>}
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
