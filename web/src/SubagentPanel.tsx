// The subagent pane: in the place of the pinned posts and the code view, beside the thread. A strip
// of every subagent and background command of the task, and a column for each one switched on
// (running ones switch on by themselves) with what it was told, said and did, like a thread.

import { Bot, PanelLeftClose, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ENGINE_LABEL, engineOf } from '../../shared/compose.ts';
import { elapsed, isActive, statusText, subagentKey, subagentKind, subagentMeta, subagentTitle, subagentTone, useSubagentEvents, type Subagent } from './subagents.tsx';
import { buildPosts } from './posts.ts';
import { PostView } from './PostView.tsx';
import { Markdown } from './Markdown.tsx';
import { useNow } from './clock.ts';
import type { Post, TaskView } from './types.ts';

/** Finished ones shown in the strip before "끝난 항목 N개 더". */
const DONE_SHOWN = 6;
const COLUMN_MIN = 300;
const WIDTH_STEP = 40;

/**
 * What the deck's keys (deckKeys.ts) do in the pane: `h` from the thread enters its last column;
 * there h / l move between columns (l past the last one goes back to the thread), j / k / G / gg
 * between posts, o or Space opens a post's tool calls, < / > change the column's width.
 */
export interface SubagentPaneKeys { focused(): boolean; enter(): boolean; key(k: string): boolean }

interface ColumnHandle { step(dir: 1 | -1): void; edge(dir: 1 | -1): void; toggle(): void }

export function SubagentPanel({ task, subagents, reveal, keys, onClose, onError }: {
  task: TaskView; subagents: Subagent[];
  /** A subagent to show and focus (a chip was pressed); `n` tells a repeated press apart. */
  reveal?: { key: string; n: number };
  keys: RefObject<SubagentPaneKeys | null>;
  onClose: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const byKey = useMemo(() => new Map(subagents.map(s => [subagentKey(s), s])), [subagents]);
  // Shown columns, in order. Running ones come on by themselves unless switched off here; with none
  // running, the newest one shows first.
  const [on, setOn] = useState<string[]>([]);
  const switchedOff = useRef(new Set<string>());
  const seeded = useRef(false);
  const [allDone, setAllDone] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const handles = useRef(new Map<string, ColumnHandle>());
  const colsRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setOn(prev => {
      const known = prev.filter(k => byKey.has(k));
      const started = subagents.filter(s => isActive(s) && !known.includes(subagentKey(s)) && !switchedOff.current.has(subagentKey(s))).map(subagentKey);
      const next = [...known, ...started];
      if (!seeded.current && subagents.length) {
        seeded.current = true;
        if (!next.length && !reveal) next.push(subagentKey(subagents[subagents.length - 1]));
      }
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
    });
  }, [byKey]);

  const scrollTo = (index: number) => requestAnimationFrame(() =>
    (colsRef.current?.children[index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  const moveFocus = (index: number | null) => { setFocus(index); if (index != null) scrollTo(index); };
  const toggle = (key: string) => {
    const index = on.indexOf(key);
    if (index < 0) {
      switchedOff.current.delete(key);
      setOn([...on, key]);
      scrollTo(on.length);
      return;
    }
    switchedOff.current.add(key);
    setOn(on.filter(k => k !== key));
    setFocus(f => f == null || on.length <= 1 ? null : Math.min(f > index ? f - 1 : f, on.length - 2));
  };

  const revealed = !!reveal && byKey.has(reveal.key);
  useEffect(() => {
    if (!reveal || !revealed) return;
    switchedOff.current.delete(reveal.key);
    const at = on.indexOf(reveal.key);
    if (at < 0) setOn([...on, reveal.key]);
    moveFocus(at < 0 ? on.length : at);
  }, [reveal?.n, revealed]);

  keys.current = {
    focused: () => focus != null,
    enter: () => { if (!on.length) return false; moveFocus(on.length - 1); return true; },
    key: (k) => {
      if (focus == null) return false;
      const handle = handles.current.get(on[focus]);
      switch (k) {
        case 'h': case 'ArrowLeft': if (focus > 0) moveFocus(focus - 1); return true;
        case 'l': case 'ArrowRight': moveFocus(focus < on.length - 1 ? focus + 1 : null); return true;
        case 'j': case 'ArrowDown': handle?.step(1); return true;
        case 'k': case 'ArrowUp': handle?.step(-1); return true;
        case 'G': handle?.edge(1); return true;
        case 'gg': handle?.edge(-1); return true;
        case 'o': case ' ': handle?.toggle(); return true;
        case '<': case '>': {
          const width = widths[on[focus]] ?? (colsRef.current?.children[focus] as HTMLElement | undefined)?.offsetWidth ?? COLUMN_MIN;
          setWidths({ ...widths, [on[focus]]: Math.max(COLUMN_MIN, width + (k === '>' ? WIDTH_STEP : -WIDTH_STEP)) });
          return true;
        }
        default: return false;
      }
    },
  };
  useEffect(() => () => { keys.current = null; }, []);
  // A click outside the pane hands the keys back to the thread.
  useEffect(() => {
    if (focus == null) return;
    const away = (e: PointerEvent) => { if (!paneRef.current?.contains(e.target as Node)) setFocus(null); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [focus]);
  useEffect(() => { if (focus != null && focus >= on.length) setFocus(on.length ? on.length - 1 : null); }, [focus, on.length]);

  const shown = on.map(k => byKey.get(k)).filter((s): s is Subagent => !!s);
  const rest = subagents.filter(s => !on.includes(subagentKey(s)));
  const restDone = rest.filter(s => !isActive(s)).reverse();
  const strip = [...shown, ...rest.filter(isActive), ...(allDone ? restDone : restDone.slice(0, DONE_SHOWN))];
  const running = subagents.filter(isActive).length;
  const engine = ENGINE_LABEL[engineOf(task.engine ?? 'claude')] ?? task.engine;

  return (
    <aside className="thread-references subagent-panel" aria-label="서브 에이전트·백그라운드" ref={paneRef}>
      <header className="reference-head">
        <div><h2><Bot /> 서브 에이전트·백그라운드 <span>{running ? `실행 중 ${running} · ` : ''}{subagents.length}</span></h2><p>{task.project_name}#{task.seq}</p></div>
        <button className="icon-btn" title="서브 에이전트 창 닫기 (b)" aria-label="서브 에이전트 창 닫기" onClick={onClose}><PanelLeftClose /></button>
      </header>
      {subagents.length > 0 && (
        <div className="sa-strip" role="group" aria-label="서브 에이전트 목록">
          {strip.map((s, i) => {
            const key = subagentKey(s);
            const isOn = on.includes(key);
            return [
              i === shown.length && shown.length > 0 && <span key="sep" className="sa-sep" />,
              <button key={key} type="button" className={`sa-tab ${subagentTone(s)}${isOn ? ' on' : ''}`} aria-pressed={isOn}
                title={`${subagentMeta(s, now)} · 누르면 컬럼을 ${isOn ? '닫습니다' : '엽니다'}`} onClick={() => toggle(key)}>
                <span className="sa-dot" />{s.parentId ? '↳ ' : ''}{subagentTitle(s)}
                <span className="sa-tabmeta">{isActive(s) ? elapsed(s, now) : statusText(s)}</span>
              </button>,
            ];
          })}
          {!allDone && restDone.length > DONE_SHOWN && (
            <button type="button" className="sa-tab more" onClick={() => setAllDone(true)}>끝난 항목 {restDone.length - DONE_SHOWN}개 더</button>
          )}
        </div>
      )}
      <div className="sa-cols" ref={colsRef}>
        {!subagents.length && <p className="empty">이 작업에서 실행한 서브 에이전트나 백그라운드 명령이 아직 없습니다.</p>}
        {subagents.length > 0 && !shown.length && <p className="empty">위 목록에서 볼 항목을 누르세요.</p>}
        {shown.map((s, i) => (
          <SubagentColumn key={subagentKey(s)} s={s} task={task} engine={engine} focused={focus === i} width={widths[subagentKey(s)]}
            handle={h => { if (h) handles.current.set(subagentKey(s), h); else handles.current.delete(subagentKey(s)); }}
            onFocus={() => setFocus(i)} onHide={() => toggle(subagentKey(s))} onError={onError} />
        ))}
      </div>
    </aside>
  );
}

function SubagentColumn({ s, task, engine, focused, width, handle, onFocus, onHide, onError }: {
  s: Subagent; task: TaskView; engine: string; focused: boolean; width?: number;
  handle: (h: ColumnHandle | null) => void; onFocus: () => void; onHide: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const { events, more, loading, error, older, whole } = useSubagentEvents(s.detailed ? s : undefined);
  const posts = useMemo(() => buildPosts(events), [events]);
  const [sel, setSel] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const feed = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const toggle = (post: Post) => {
    // Live steps come cut; opening them loads them whole.
    if (!expanded.has(post.id) && post.activity.some(e => e.payload?.clipped)) void whole();
    setExpanded(prev => { const next = new Set(prev); if (!next.delete(post.id)) next.add(post.id); return next; });
  };
  const select = (index: number) => {
    const post = posts[Math.max(0, Math.min(index, posts.length - 1))];
    if (!post) return;
    setSel(post.id);
    feed.current?.querySelector(`[data-post="${post.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const current = posts.findIndex(p => p.id === sel);
  handle({
    step: dir => select(current < 0 ? (dir > 0 ? 0 : posts.length - 1) : current + dir),
    edge: dir => select(dir > 0 ? posts.length - 1 : 0),
    toggle: () => { const post = posts[current]; if (post) toggle(post); },
  });
  useEffect(() => () => handle(null), []);
  // Follow its newest step while reading at the bottom, as the thread does.
  useLayoutEffect(() => {
    const f = feed.current;
    if (f && atBottom.current) f.scrollTop = f.scrollHeight;
  }, [events.length, s.status]);

  const firstPrompt = posts.find(p => p.kind === 'user')?.id;
  const speaker = (p: Post) => p.kind === 'user'
    ? { name: `${engine} → ${subagentKind(s) === '명령' ? '명령' : '서브 에이전트'}`, avatar: '↳', tag: p.id === firstPrompt ? '지시문' : '추가 지시' }
    : { name: subagentKind(s), avatar: 'SA' };

  return (
    <section className={`column sa-col ${subagentTone(s)}${focused ? ' focused' : ''}${width ? ' sized' : ''}`}
      style={width ? { '--sa-w': `${width}px` } as CSSProperties : undefined} aria-label={subagentTitle(s)} onMouseDown={onFocus}>
      <header className="col-head sa-colhead">
        <span className="sa-dot" />
        <div className="sa-titles">
          <h2 title={subagentTitle(s)}>{s.parentId ? '↳ ' : ''}{subagentTitle(s)}</h2>
          <div className="sa-meta">{subagentMeta(s, now)}</div>
        </div>
        <button className="icon-btn" aria-label="컬럼 닫기" title="컬럼 닫기" onClick={onHide}><X size={14} /></button>
      </header>
      <div className="feed sa-feed" ref={feed} onScroll={e => {
        const f = e.currentTarget;
        atBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
        if (f.scrollTop < 80) void older();
      }}>
        {!s.detailed && <p className="sa-note">이 엔진은 서브 에이전트·백그라운드 작업의 시작과 종료만 알려 줍니다.</p>}
        {more && <button className="link sa-older" disabled={loading} onClick={() => void older()}>이전 기록 더 보기</button>}
        {error && <p role="alert" className="sa-note">기록을 불러오지 못했습니다: {error}</p>}
        {s.detailed && loading && !events.length && <p className="sa-note">불러오는 중…</p>}
        {posts.map(p => (
          <PostView key={p.id} post={p} task={task} model={undefined} approval={undefined} colId={`subagent:${subagentKey(s)}`}
            selected={sel === p.id} expanded={expanded.has(p.id)} working={false} flash={false} inThread speaker={speaker(p)}
            onSelect={() => setSel(p.id)} onToggle={() => toggle(p)} onAllow={() => {}} onDeny={() => {}} onError={onError} />
        ))}
        {isActive(s) ? (
          <div className="sa-working"><span className="sa-dot" />작업 중{s.lastTool ? ` · 마지막 도구 ${s.lastTool}` : ''}{s.summary ? ` · ${s.summary}` : ''}</div>
        ) : s.summary ? (
          <div className={`sa-result${s.status === 'failed' ? ' error' : ''}`}>
            <b>결과 · {statusText(s)}</b>
            <Markdown text={s.summary} taskId={task.id} onNotice={onError} />
          </div>
        ) : <p className="sa-note">{statusText(s)} · {elapsed(s, now)}</p>}
      </div>
    </section>
  );
}
