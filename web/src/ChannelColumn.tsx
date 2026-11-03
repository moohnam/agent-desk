import { ArrowDown, CheckCheck, Search, Settings, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from './api.ts';
import { applyChannelUpdates, mergeChannelEntries, safeChannelUrl } from './channelEntries.ts';
import { latinKey } from './keys.ts';
import { ResizeHandle } from './handles.tsx';
import { LongText } from './Markdown.tsx';
import { modalOpen } from './Modal.tsx';
import { SearchHead } from './Search.tsx';
import type { Channel, ChannelEntry, ColumnDef } from './types.ts';
import './channels.css';

/** Independent entry state: channel entry ids never enter the task post selection or actions. */
export function ChannelColumn({ def, channel, active, keyboardEnabled, width, synced, onEntry, onPress, onResize, onManage, onClose, onError, onRead, onEdge, onRecent, onBack }: {
  def: ColumnDef; channel?: Channel; active: boolean; keyboardEnabled: boolean; width: number; synced: number;
  onEntry: (fn: (entry: ChannelEntry) => void) => () => void;
  onPress: () => void; onResize: (width: number | null) => void; onManage: () => void; onClose: () => void;
  onError: (message: string) => void; onRead: (channel: Channel) => void;
  onEdge: (direction: -1 | 1) => void; onRecent: () => void; onBack?: () => void;
}) {
  const id = def.channelId!;
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [expanded, setExpanded] = useState(new Set<number>());
  const [search, setSearch] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [newer, setNewer] = useState(false);
  const [drawn, setDrawn] = useState(40);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const requestUpdates = useRef<Map<number, ChannelEntry> | null>(null);
  const newest = useRef(true);
  const atTop = useRef(true);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const capture = () => {
    const el = feed.current;
    if (!el || el.scrollTop < 40) return;
    const top = el.getBoundingClientRect().top;
    const first = [...el.querySelectorAll<HTMLElement>('[data-entry]')].find((item) => item.getBoundingClientRect().bottom > top);
    if (first) anchor.current = { id: first.dataset.entry!, top: first.getBoundingClientRect().top - top };
  };
  useLayoutEffect(() => {
    const a = anchor.current, el = feed.current;
    anchor.current = null;
    const item = a && el?.querySelector<HTMLElement>(`[data-entry="${a.id}"]`);
    if (el && item) el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top - a!.top;
  }, [entries]);
  const load = async (older = false) => {
    if (pending.current || (older && !more)) return;
    const g = generation.current;
    const updates = new Map<number, ChannelEntry>();
    requestUpdates.current = updates;
    pending.current = true; setLoading(true);
    try {
      const page = await api.channelEntries(id, { q: query, ...(older ? { before: entries.at(-1)?.id } : {}) });
      if (generation.current !== g) return;
      capture();
      setEntries((prev) => older
        ? applyChannelUpdates(mergeChannelEntries(prev, page.entries, true), updates.values(), query, false)
        : mergeChannelEntries([], applyChannelUpdates(page.entries, updates.values(), query)));
      setMore(page.more); setTotal(page.total);
      if (older) { newest.current = false; setNewer(true); setDrawn((count) => Math.min(count + 100, 400)); }
      else { newest.current = true; setDrawn(40); setNewer(false); setSelected(undefined); if (feed.current) feed.current.scrollTop = 0; }
    } catch (error) { if (generation.current === g) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === g) { pending.current = false; requestUpdates.current = null; setLoading(false); } }
  };
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search?.trim() ?? ''), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    generation.current++; pending.current = false; requestUpdates.current = null; anchor.current = null;
    setEntries([]); setMore(false); setSelected(undefined); newest.current = true;
    void load();
    return () => { generation.current++; };
  }, [id, query]);
  const lastSynced = useRef(synced);
  useEffect(() => {
    if (lastSynced.current !== synced) { lastSynced.current = synced; setNewer(true); }
  }, [synced]);
  useEffect(() => onEntry((entry) => {
    if (entry.channel_id !== id) return;
    requestUpdates.current?.set(entry.id, entry);
    const matches = !query || `${entry.title}\n${entry.body}`.toLowerCase().includes(query.toLowerCase());
    setEntries((prev) => {
      const existing = prev.some((item) => item.id === entry.id);
      if (!matches) return existing ? prev.filter((item) => item.id !== entry.id) : prev;
      if (!existing && (!newest.current || !atTop.current)) { setNewer(true); return prev; }
      capture();
      return mergeChannelEntries(prev, [entry]);
    });
  }), [id, query, onEntry]);
  useEffect(() => {
    const ids = new Set(entries.map((entry) => entry.id));
    setExpanded((prev) => [...prev].some((entryId) => !ids.has(entryId)) ? new Set([...prev].filter((entryId) => ids.has(entryId))) : prev);
  }, [entries]);
  const mark = (through: number) => {
    if (!channel || through <= channel.read_through_id) return;
    void api.readChannel(id, through).then(onRead, (error: Error) => onError(error.message));
  };
  const choose = (index: number) => {
    const entry = entries[Math.max(0, Math.min(index, entries.length - 1))];
    if (!entry) return;
    setDrawn((count) => Math.max(count, Math.max(0, index) + 1));
    onPress(); setSelected(entry.id);
    requestAnimationFrame(() => feed.current?.querySelector(`[data-entry="${entry.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  const toggle = (entryId: number) => setExpanded((prev) => { const next = new Set(prev); if (!next.delete(entryId)) next.add(entryId); return next; });
  const startSearch = () => { setSearch((value) => value ?? ''); requestAnimationFrame(() => input.current?.focus()); };
  const firstG = useRef(0);
  useEffect(() => {
    if (!active || !keyboardEnabled) return;
    const key = (event: KeyboardEvent) => {
      if (modalOpen() || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest('input,textarea,select')) return;
      const at = entries.findIndex((entry) => entry.id === selected);
      const pressed = latinKey(event);
      let used = true;
      switch (pressed) {
        case 'j': case 'ArrowDown': choose(at + 1); break;
        case 'k': case 'ArrowUp': choose(at < 0 ? 0 : at - 1); break;
        case 'G': choose(entries.length - 1); break;
        case 'g': if (Date.now() - firstG.current < 600) { choose(0); firstG.current = 0; } else firstG.current = Date.now(); break;
        case 'h': case 'l': if (Date.now() - firstG.current < 600) { firstG.current = 0; onEdge(pressed === 'h' ? -1 : 1); } else used = false; break;
        case 'r': if (Date.now() - firstG.current < 600) { firstG.current = 0; onRecent(); } else used = false; break;
        case 'q': case 'Escape': if (search != null) setSearch(null); else if (onBack) onBack(); else used = false; break;
        case 'o': case ' ': if (selected != null) toggle(selected); break;
        case 'Enter': { const entry = entries.find((item) => item.id === selected); const url = safeChannelUrl(entry?.url ?? null); if (url) window.open(url, '_blank', 'noopener,noreferrer'); break; }
        case '/': startSearch(); break;
        case 'm': { const entry = entries.find((item) => item.id === selected); if (entry) mark(entry.id); break; }
        default: used = false;
      }
      if (used) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  return (
    <section data-col={def.id} className={`column channel-column${active ? ' focused' : ''}`} style={{ '--w': `${width}px` } as CSSProperties} onMouseDown={onPress}>
      {search != null ? <SearchHead plain value={search} onChange={setSearch} inputRef={input} projects={[]} tasks={[]} count={String(total)} unknown={[]}
        onDone={() => { input.current?.blur(); choose(0); }} onClose={() => setSearch(null)} /> : <header className="col-head">
        <h2 title={`${def.title} · 읽기 전용 채널`}>{def.title}</h2><span className="count">{channel?.unread_count ?? 0} 안 읽음</span>
        <span className="spacer" /><button className="icon-btn" aria-label="채널 안에서 검색" title="채널 안에서 검색 (/)" onClick={startSearch}><Search /></button>
        <button className="icon-btn" aria-label="채널 관리" title="채널 관리" onClick={onManage}><Settings /></button>
        <button className="icon-btn" aria-label="채널 컬럼 닫기" title="채널 컬럼 닫기" onClick={onClose}><X /></button>
      </header>}
      <div className="channel-tools">
        {onBack && <button className="link" onClick={onBack}>← 전체 피드</button>}
        <span className="muted small">읽기 전용 · {channel?.source === 'feed' ? 'RSS·Atom' : '봇 알림'}{channel?.enabled === false ? ' · 일시 중지' : ''}</span>
        <button className="link" disabled={!channel?.latest_entry_id} onClick={() => mark(channel!.latest_entry_id)}><CheckCheck /> 모두 읽음</button>
      </div>
      {channel?.last_error && <p className="channel-error" role="status">최근 수집: {channel.last_error}</p>}
      <div className="feed" ref={feed} onScroll={(event) => { atTop.current = event.currentTarget.scrollTop < 40; }}>
        {newer && <button className="channel-new" onClick={() => void load()}>새 글 보기</button>}
        {entries.slice(0, drawn).map((entry) => {
          const url = safeChannelUrl(entry.url), unread = entry.id > (channel?.read_through_id ?? 0);
          return <article key={entry.id} data-entry={entry.id} className={`channel-entry${active && selected === entry.id ? ' selected' : ''}${unread ? ' unread' : ''}`} onClick={() => { onPress(); setSelected(entry.id); }}>
            <div className="channel-entry-meta"><span>{entry.author ?? channel?.name ?? def.title}</span><time dateTime={entry.published_at ?? entry.received_at}>{new Date(entry.published_at ?? entry.received_at).toLocaleString('ko-KR')}</time></div>
            {entry.title && <h3>{entry.title}</h3>}
            <LongText full={expanded.has(entry.id)} className="body channel-body" onToggle={() => toggle(entry.id)}>{entry.body}</LongText>
            <div className="channel-entry-actions">
              {url && <a href={url} target="_blank" rel="noreferrer noopener">원문 보기</a>}
              <button className="link" disabled={!unread} onClick={(event) => { event.stopPropagation(); mark(entry.id); }}>여기까지 읽음</button>
            </div>
          </article>;
        })}
        {!entries.length && <p className="empty">{loading ? '불러오는 중…' : !channel ? '삭제되었거나 없는 채널입니다.' : query ? '조건에 맞는 글이 없습니다.' : '아직 글이 없습니다.'}</p>}
        {(more || drawn < entries.length) && <div className="older-posts"><button disabled={loading} onClick={() => drawn < entries.length ? setDrawn((count) => count + 60) : void load(true)}>{loading ? '불러오는 중…' : <><ArrowDown /> 이전 글 더 보기</>}</button></div>}
      </div>
      <ResizeHandle width={width} onResize={onResize} />
    </section>
  );
}
