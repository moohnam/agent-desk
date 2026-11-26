// The subagent pane: in the place of the pinned posts and the code view, beside the thread. A column
// for each of the task's subagents with what it was told, said and did, like a thread, and one column
// of every background command, the subagents' too, in the order they started. All show; the strip
// takes columns out and puts them back.

import { Bot, PanelLeftClose, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ENGINE_LABEL, engineOf } from '../../shared/compose.ts';
import { elapsed, isActive, isCommand, isCurrentCommand, statusText, subagentKey, subagentKind, subagentMeta, subagentTitle, subagentTone, useSubagentEvents, type Subagent } from './subagents.tsx';
import { buildPosts } from './posts.ts';
import { PostView } from './PostView.tsx';
import { Markdown } from './Markdown.tsx';
import { useNow } from './clock.ts';
import type { HubEvent, Post, TaskView } from './types.ts';

const COLUMN_MIN = 300;
const WIDTH_STEP = 40;
/** The tool a background subagent hands its answer back to its parent with. */
const HANDBACK = 'SubagentHandback';
/** A handed-back answer reads as what the subagent said; the tool's own receipt is left out. */
function withAnswers(events: HubEvent[]): HubEvent[] {
  const calls = new Set<string>();
  return events.flatMap(e => {
    if (e.kind === 'tool' && e.payload.name === HANDBACK && typeof e.payload.input?.message === 'string') {
      calls.add(e.payload.toolUseId);
      return [{ ...e, kind: 'assistant', payload: { text: e.payload.input.message, handback: true, clipped: e.payload.clipped } }];
    }
    return e.kind === 'tool_result' && calls.has(e.payload.toolUseId) ? [] : [e];
  });
}

/** What Codex calls a background command it cannot name. */
const CODEX_UNNAMED = '백그라운드 명령';
/** The CLI's note to the parent agent that a handed-back report came as a message: nothing for a person to read. */
const isHandoffNotice = (summary: string) => summary.startsWith("This agent's report was delivered");

/** The key of the background commands' column. */
const COMMANDS = 'commands';

/**
 * What the deck's keys (deckKeys.ts) do in the pane: `h` from the thread enters its last column;
 * there h / l move between columns (l past the last one goes back to the thread), j / k / G / gg
 * between posts, o or Space opens a post's tool calls, < / > change the column's width.
 */
export interface SubagentPaneKeys { focused(): boolean; enter(): boolean; key(k: string): boolean }

interface ColumnHandle { step(dir: 1 | -1): void; edge(dir: 1 | -1): void; toggle(): void }

export function SubagentPanel({ task, subagents, reload, reveal, keys, onClose, onError }: {
  task: TaskView; subagents: Subagent[]; reload: number;
  /** A subagent to show and focus (a chip was pressed); `n` tells a repeated press apart. */
  reveal?: { key: string; n: number };
  keys: RefObject<SubagentPaneKeys | null>;
  onClose: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const agents = useMemo(() => subagents.filter(s => !isCommand(s)), [subagents]);
  const commands = useMemo(() => subagents.filter(isCurrentCommand), [subagents]);
  const byKey = useMemo(() => new Map(agents.map(s => [subagentKey(s), s])), [agents]);
  const columnOf = (key: string) => commands.some(s => subagentKey(s) === key) ? COMMANDS : key;
  const [commandFocus, setCommandFocus] = useState<{ key: string; n: number }>();
  // Every column shows (the commands' first, then the subagents as they started) but those taken out here.
  const all = useMemo(() => [...(commands.length ? [COMMANDS] : []), ...agents.map(subagentKey)], [agents, commands]);
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const on = all.filter(k => !off.has(k));
  // The focused column by key, so a column coming in ahead of it does not move the focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focus = focusKey && on.includes(focusKey) ? on.indexOf(focusKey) : null;
  const [widths, setWidths] = useState<Record<string, number>>({});
  const handles = useRef(new Map<string, ColumnHandle>());
  const colsRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);

  const scrollTo = (key: string) => requestAnimationFrame(() =>
    colsRef.current?.querySelector(`[data-column="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  const moveFocus = (key: string | null) => { setFocusKey(key); if (key) scrollTo(key); };
  const toggle = (key: string) => {
    const index = on.indexOf(key);
    const next = new Set(off);
    if (index < 0) {
      next.delete(key);
      setOff(next);
      scrollTo(key);
      return;
    }
    next.add(key);
    setOff(next);
    if (focusKey === key) setFocusKey(on[index + 1] ?? on[index - 1] ?? null);
  };

  const revealed = !!reveal && all.includes(columnOf(reveal.key));
  useEffect(() => {
    if (!reveal || !revealed) return;
    const column = columnOf(reveal.key);
    const next = new Set(off);
    next.delete(column);
    setOff(next);
    moveFocus(column);
    if (column === COMMANDS) setCommandFocus({ key: reveal.key, n: reveal.n });
  }, [reveal?.n, revealed]);

  keys.current = {
    focused: () => focus != null,
    enter: () => { if (!on.length) return false; moveFocus(on[on.length - 1]); return true; },
    key: (k) => {
      if (focus == null) return false;
      const handle = handles.current.get(on[focus]);
      switch (k) {
        case 'h': case 'ArrowLeft': if (focus > 0) moveFocus(on[focus - 1]); return true;
        case 'l': case 'ArrowRight': moveFocus(on[focus + 1] ?? null); return true;
        case 'j': case 'ArrowDown': handle?.step(1); return true;
        case 'k': case 'ArrowUp': handle?.step(-1); return true;
        case 'G': handle?.edge(1); return true;
        case 'gg': handle?.edge(-1); return true;
        case 'o': case ' ': handle?.toggle(); return true;
        case '<': case '>': {
          const width = widths[on[focus]] ?? colsRef.current?.querySelector<HTMLElement>(`[data-column="${CSS.escape(on[focus])}"]`)?.offsetWidth ?? COLUMN_MIN;
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
    const away = (e: PointerEvent) => { if (!paneRef.current?.contains(e.target as Node)) setFocusKey(null); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [focus]);

  const visibleCount = agents.length + commands.length;
  const running = agents.filter(isActive).length + commands.length;
  const commandsRunning = commands.filter(isActive).length;
  const setHandle = (key: string) => (h: ColumnHandle | null) => { if (h) handles.current.set(key, h); else handles.current.delete(key); };
  const engine = ENGINE_LABEL[engineOf(task.engine ?? 'claude')] ?? task.engine;

  return (
    <aside className="thread-references subagent-panel" aria-label="서브 에이전트·백그라운드" ref={paneRef}>
      <header className="reference-head">
        <div><h2><Bot /> 서브 에이전트·백그라운드 <span>{running ? `실행 중 ${running} · ` : ''}{visibleCount}</span></h2><p>{task.project_name}#{task.seq}</p></div>
        <button className="icon-btn" title="서브 에이전트 창 닫기 (b)" aria-label="서브 에이전트 창 닫기" onClick={onClose}><PanelLeftClose /></button>
      </header>
      {visibleCount > 0 && (
        <div className="sa-strip" role="group" aria-label="서브 에이전트 목록">
          {commands.length > 0 && (
            <button type="button" className={`sa-tab ${commandsRunning ? 'running' : 'done'}${on.includes(COMMANDS) ? ' on' : ''}`} aria-pressed={on.includes(COMMANDS)}
              title={`백그라운드 명령을 시간 순으로 한 컬럼에서 봅니다 · 누르면 컬럼을 ${on.includes(COMMANDS) ? '뺍니다' : '넣습니다'}`} onClick={() => toggle(COMMANDS)}>
              <span className="sa-dot" />백그라운드 작업 {commands.length}
              {commandsRunning > 0 && <span className="sa-tabmeta">실행 중 {commandsRunning}</span>}
            </button>
          )}
          {commands.length > 0 && agents.length > 0 && <span className="sa-sep" />}
          {agents.map(s => {
            const key = subagentKey(s);
            const isOn = !off.has(key);
            return (
              <button key={key} type="button" className={`sa-tab ${subagentTone(s)}${isOn ? ' on' : ''}`} aria-pressed={isOn}
                title={`${subagentMeta(s, now)} · 누르면 컬럼을 ${isOn ? '뺍니다' : '넣습니다'}`} onClick={() => toggle(key)}>
                <span className="sa-dot" />{s.parentId ? '↳ ' : ''}{subagentTitle(s)}
                <span className="sa-tabmeta">{isActive(s) ? elapsed(s, now) : statusText(s)}</span>
              </button>
            );
          })}
          <span className="sa-sep" />
          <button type="button" className="link" disabled={!off.size} onClick={() => setOff(new Set())}>초기화</button>
          <button type="button" className="link" disabled={!on.length} onClick={() => { setOff(new Set(all)); setFocusKey(null); }}>모두 빼기</button>
        </div>
      )}
      <div className="sa-cols" ref={colsRef}>
        {!visibleCount && <p className="empty">표시할 서브 에이전트나 현재 실행 중인 백그라운드 명령이 없습니다.</p>}
        {visibleCount > 0 && !on.length && <p className="empty">모든 컬럼을 뺐습니다. 위 목록에서 고르거나 초기화로 다시 넣으세요.</p>}
        {on.map((key, i) => key === COMMANDS ? (
          <CommandsColumn key={key} commands={commands} all={subagents} focused={focus === i} width={widths[key]} reveal={commandFocus}
            handle={setHandle(key)} onFocus={() => setFocusKey(key)} onHide={() => toggle(key)} />
        ) : (
          <SubagentColumn key={key} s={byKey.get(key)!} reload={reload} task={task} engine={engine} focused={focus === i} width={widths[key]}
            handle={setHandle(key)} onFocus={() => setFocusKey(key)} onHide={() => toggle(key)} onError={onError} />
        ))}
      </div>
    </aside>
  );
}

function SubagentColumn({ s, reload, task, engine, focused, width, handle, onFocus, onHide, onError }: {
  s: Subagent; reload: number; task: TaskView; engine: string; focused: boolean; width?: number;
  handle: (h: ColumnHandle | null) => void; onFocus: () => void; onHide: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const { events, more, loading, error, older, whole } = useSubagentEvents(s.detailed ? s : undefined, reload);
  const posts = useMemo(() => buildPosts(withAnswers(events)), [events]);
  // The answer to the latest instruction: a follow-up after it starts a run that answers anew.
  const answer = posts.findLast(p => p.event.payload.handback || p.kind === 'user');
  const handedBack = answer?.event.payload.handback ? answer : undefined;
  // A live answer comes cut like any tool input; it is read whole.
  useEffect(() => { if (handedBack?.event.payload.clipped) void whole(); }, [handedBack?.id, handedBack?.event.payload.clipped]);
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
    : { name: subagentKind(s), avatar: 'SA', ...(p.event.payload.handback && { tag: `${engine}에게 보낸 답` }) };

  return (
    <section className={`column sa-col ${subagentTone(s)}${focused ? ' focused' : ''}${width ? ' sized' : ''}`}
      style={width ? { '--sa-w': `${width}px` } as CSSProperties : undefined} aria-label={subagentTitle(s)} data-column={subagentKey(s)} onMouseDown={onFocus}>
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
        {!s.detailed && <p className="sa-note">상태 목록만 수신한 항목입니다. 해당 실행의 상세 기록이 허브에 전달되지 않아 대화를 복구할 수 없습니다.</p>}
        {s.detailNote && <p className="sa-note">{s.detailNote}</p>}
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
        ) : handedBack && s.status !== 'failed' ? <p className="sa-note">{statusText(s)} · {elapsed(s, now)} · 위 글이 {engine}에게 돌려준 답입니다.</p>
        : s.summary && !isHandoffNotice(s.summary) ? (
          <div className={`sa-result${s.status === 'failed' ? ' error' : ''}`}>
            <b>결과 · {statusText(s)}</b>
            <Markdown text={s.summary} taskId={task.id} onNotice={onError} />
          </div>
        ) : <p className="sa-note">{statusText(s)} · {elapsed(s, now)}</p>}
      </div>
    </section>
  );
}

/** Every background command, the subagents' too, in the order they started: what it does, the command, how it ended and how long it took; o opens its output. */
function CommandsColumn({ commands, all, focused, width, reveal, handle, onFocus, onHide }: {
  commands: Subagent[]; all: Subagent[]; focused: boolean; width?: number; reveal?: { key: string; n: number };
  handle: (h: ColumnHandle | null) => void; onFocus: () => void; onHide: () => void;
}) {
  const now = useNow();
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const feed = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const toggle = (key: string) => setOpen(prev => { const next = new Set(prev); if (!next.delete(key)) next.add(key); return next; });
  const select = (index: number) => {
    const s = commands[Math.max(0, Math.min(index, commands.length - 1))];
    if (!s) return;
    setSel(subagentKey(s));
    feed.current?.querySelector(`[data-command="${CSS.escape(subagentKey(s))}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const current = commands.findIndex(s => subagentKey(s) === sel);
  handle({
    step: dir => select(current < 0 ? (dir > 0 ? 0 : commands.length - 1) : current + dir),
    edge: dir => select(dir > 0 ? commands.length - 1 : 0),
    toggle: () => { if (sel) toggle(sel); },
  });
  useEffect(() => () => handle(null), []);
  useEffect(() => { if (reveal) select(commands.findIndex(s => subagentKey(s) === reveal.key)); }, [reveal?.n]);
  useLayoutEffect(() => {
    const f = feed.current;
    if (f && atBottom.current) f.scrollTop = f.scrollHeight;
  }, [commands.length]);
  const starter = (s: Subagent) => s.parentId ? all.find(x => x.session_id === s.session_id && x.id === s.parentId) : undefined;
  const running = commands.filter(isActive).length;

  return (
    <section className={`column sa-col${running ? ' running' : ' done'}${focused ? ' focused' : ''}${width ? ' sized' : ''}`}
      style={width ? { '--sa-w': `${width}px` } as CSSProperties : undefined} aria-label="백그라운드 작업" data-column={COMMANDS} onMouseDown={onFocus}>
      <header className="col-head sa-colhead">
        <span className="sa-dot" />
        <div className="sa-titles">
          <h2>백그라운드 작업</h2>
          <div className="sa-meta">{[`${commands.length}개`, running && `실행 중 ${running}`].filter(Boolean).join(' · ')}</div>
        </div>
        <button className="icon-btn" aria-label="컬럼 닫기" title="컬럼 닫기" onClick={onHide}><X size={14} /></button>
      </header>
      <div className="feed sa-feed" ref={feed} onScroll={e => {
        const f = e.currentTarget;
        atBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
      }}>
        {commands.map(s => {
          const key = subagentKey(s), from = starter(s), isOpen = open.has(key);
          // Codex names a command by the command itself.
          const command = s.command ?? (s.type === 'shell' && s.description !== CODEX_UNNAMED ? s.description : undefined);
          const title = s.command || s.type !== 'shell' ? s.description : CODEX_UNNAMED;
          const exit = /exit code (\d+)\)?\s*$/.exec(s.summary ?? '')?.[1];
          const result = s.output ?? (s.summary && !isHandoffNotice(s.summary) ? s.summary : undefined);
          return (
            <div key={key} data-command={key} className={`sa-command ${subagentTone(s)}${sel === key ? ' selected' : ''}${isOpen ? ' open' : ''}`}
              onClick={() => { setSel(key); if (!window.getSelection()?.toString()) toggle(key); }}>
              <div className="sa-command-head"><span className="sa-dot" /><b title={title}>{title}</b>
                <time dateTime={s.created_at}>{new Date(s.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></div>
              {command && <code className="sa-command-line" title={command}>$ {command}</code>}
              <div className="sa-meta">{[isActive(s) ? '실행 중' : statusText(s), exit !== undefined && `종료 코드 ${exit}`, elapsed(s, now),
                from && `${subagentTitle(from)}에서`].filter(Boolean).join(' · ')}</div>
              {isOpen ? (result ? <pre className="sa-command-out">{result}</pre> : <div className="sa-meta">{isActive(s) ? '실행 중인 백그라운드 작업입니다. 종료되면 목록에서 사라집니다.' : '기록된 출력이 없습니다.'}</div>)
                : result && <div className="sa-meta">{s.output ? '출력 보기 (o)' : '결과 보기 (o)'}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
