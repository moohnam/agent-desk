import { useMemo, useState } from 'react';
import { Modal } from './Modal.tsx';

/** A column the finder can jump to. `sub`: a second line (the column's note), also searched. */
export interface FinderItem { id: string; title: string; sub?: string }

const START = /[\s#@/_.:\-›]/;

/**
 * Fuzzy match of `query` in `text`: every space-separated word of the query must appear in order
 * (letters may be apart). Higher is better: letters in a row and at word starts count more, gaps
 * less. Null when it doesn't match. `hits`: the matched positions, for highlighting.
 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const t = text.toLowerCase();
  let score = 0;
  const hits: number[] = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    // The word as a whole scores best; else its letters in order.
    const at = t.indexOf(word);
    if (at >= 0) {
      score += word.length * 4 + (at === 0 || START.test(t[at - 1]) ? 6 : 0);
      for (let i = 0; i < word.length; i++) hits.push(at + i);
      continue;
    }
    let from = 0, prev = -2;
    for (const ch of word) {
      const i = t.indexOf(ch, from);
      if (i < 0) return null;
      score += 1 + (i === prev + 1 ? 3 : 0) + (i === 0 || START.test(t[i - 1]) ? 2 : 0) - Math.min(3, (i - from) * 0.1);
      hits.push(i);
      prev = i;
      from = i + 1;
    }
  }
  return { score, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  const on = new Set(hits);
  return <>{[...text].map((ch, i) => (on.has(i) ? <b key={i}>{ch}</b> : ch))}</>;
}

/** `;`: find a column of the current view by name and focus it. */
export function ColumnFinder({ items, onPick, onClose }: { items: FinderItem[]; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const found = useMemo(() => {
    if (!query.trim()) return items.map((item) => ({ item, hits: [] as number[] }));
    return items.map((item, order) => ({ item, order, m: fuzzy(query, item.title) ?? (item.sub ? fuzzy(query, item.sub) && { score: 0, hits: [] } : null) }))
      .filter((x): x is typeof x & { m: { score: number; hits: number[] } } => !!x.m)
      .sort((a, b) => b.m.score - a.m.score || a.order - b.order)
      .map((x) => ({ item: x.item, hits: x.m.hits }));
  }, [items, query]);
  const at = Math.min(cur, Math.max(0, found.length - 1));
  const pick = (i: number) => { const x = found[i]; if (x) { onPick(x.item.id); onClose(); } };
  return (
    <Modal title="컬럼 찾기" onClose={onClose}>
      <div className="finder">
        <input className="input" autoFocus value={query} placeholder="컬럼 이름 (글자 일부만 써도 됩니다)"
          onChange={(e) => { setQuery(e.target.value); setCur(0); }}
          onKeyDown={(e) => {
            const down = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'j'));
            const up = e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'k'));
            if (down || up) { e.preventDefault(); setCur(Math.max(0, Math.min(found.length - 1, at + (down ? 1 : -1)))); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(at); }
          }} />
        <ul className="finder-list" role="listbox">
          {found.map((x, i) => (
            <li key={x.item.id} role="option" aria-selected={i === at} className={i === at ? 'on' : undefined}
              onMouseEnter={() => setCur(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
              <span className="t"><Highlight text={x.item.title} hits={x.hits} /></span>
              {x.item.sub && <span className="s muted">{x.item.sub}</span>}
            </li>
          ))}
          {!found.length && <li className="muted empty">맞는 컬럼이 없습니다</li>}
        </ul>
        <p className="muted small">↑↓ 또는 Ctrl+N/P로 고르고 Enter로 이동 · Esc 닫기</p>
      </div>
    </Modal>
  );
}
