import { Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { suggestSearch, type SearchOption } from './search.ts';
import type { Project, TaskView } from './types.ts';

/**
 * The search column's head: a query field with `#key:value` completion, the match count, and
 * buttons to keep the search as a column or close it.
 */
export function SearchHead({ value, onChange, inputRef, projects, tasks, count, unknown, onDone, onClose, onSave, plain }: {
  value: string; onChange: (v: string) => void; inputRef: RefObject<HTMLInputElement | null>;
  projects: Project[]; tasks: TaskView[]; count: string; unknown: string[];
  /** Enter with no completion open: leave the field for the results. */
  onDone: () => void; onClose: () => void; onSave?: () => void; plain?: boolean;
}) {
  const [caret, setCaret] = useState(value.length);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const sug = useMemo(() => plain ? null : suggestSearch(value, caret, projects, tasks), [value, caret, projects, tasks, plain]);
  const open = !dismissed && !!sug?.items.length;
  const cur = Math.min(index, (sug?.items.length ?? 1) - 1);

  useEffect(() => { setIndex(0); }, [sug?.start, sug?.items.length]);
  useEffect(() => { list.current?.querySelector('.opt.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, open]);

  const pick = (o: SearchOption) => {
    if (!sug) return;
    const ins = o.insert + (o.more ? '' : ' ');
    const after = value.slice(sug.end).replace(/^ /, '');
    const next = value.slice(0, sug.start) + ins + after;
    const pos = sug.start + ins.length;
    onChange(next);
    setCaret(pos);
    setDismissed(false);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); });
  };

  return (
    <header className="col-head search-head">
      <div className="search-row">
        <span className="search-icon" aria-hidden>⌕</span>
        <div className="search-field">
          <input ref={inputRef} className="input" value={value} spellCheck={false} autoComplete="off"
            placeholder={plain ? '이 채널의 제목·본문 검색' : '검색어 · #project: #status: #kind: #task:'}
            onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(false); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setDismissed(true)} onFocus={() => setDismissed(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (open && sug) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((cur + 1) % sug.items.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((cur - 1 + sug.items.length) % sug.items.length); return; }
                if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pick(sug.items[cur]); return; }
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
              }
              if (e.key === 'Enter') { e.preventDefault(); onDone(); return; }
              if (e.key === 'Escape') { e.preventDefault(); if (value.trim()) onDone(); else onClose(); }
            }} />
          {open && sug && (
            <div className="ac" role="listbox" onMouseDown={(e) => e.preventDefault()}>
              <div className="opts" ref={list}>
                {sug.items.map((o, i) => (
                  <div key={o.key} role="option" aria-selected={i === cur} className={`opt${i === cur ? ' on' : ''}`}
                    onMouseEnter={() => setIndex(i)} onClick={() => pick(o)}>
                    {o.color && <span className="pdot" style={{ background: o.color }} />}
                    <span className="k">{o.label}</span>
                    {o.desc && <span className="d">{o.desc}</span>}
                  </div>
                ))}
              </div>
              <div className="foot">↑↓ 이동 · Tab/Enter 선택 · Esc 닫기</div>
            </div>
          )}
        </div>
        {onSave && <button className="icon-btn" title="이 검색을 컬럼으로 저장" disabled={!value.trim()} aria-label="검색을 컬럼으로 저장" onClick={onSave}><Save /></button>}
        <button className="icon-btn" title="검색 닫기 (결과에서 q · 빈 검색창에서 Esc)" aria-label="검색 닫기" onClick={onClose}><X /></button>
      </div>
      <div className="search-meta">
        {value.trim() ? <span>글 {count}개</span> : <span>/ 로 언제든 검색 · Enter: 결과로 이동</span>}
        {unknown.length > 0 && <span className="warn" title="찾지 못한 필터는 적용하지 않았습니다.">모르는 필터: {unknown.join(' ')}</span>}
      </div>
    </header>
  );
}
