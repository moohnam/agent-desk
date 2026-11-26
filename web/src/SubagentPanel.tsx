import { ColumnHeader } from './ColumnHeader.tsx';
// The subagent pane: in the place of the pinned posts and the code view, beside the thread. A column
// for each of the task's subagents with what it was told, said and did, like a thread, and one column
// of current background commands. Finished agents share a chronological history column.

import { Bot, PanelLeftClose } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ENGINE_LABEL, engineOf } from '../../shared/compose.ts';
import { elapsed, isActive, isCommand, isCurrentCommand, statusText, subagentKey, subagentKind, subagentMeta, subagentTitle, subagentTone, useSubagentEvents, type Subagent } from './subagents.tsx';
import { subagentHistoryPosts, subagentPosts, withSubagentAnswers } from './subagentHistory.ts';
import { api } from './api.ts';
import { buildPosts, mergeTaskEvents } from './posts.ts';
import { PostView } from './PostView.tsx';
import { Markdown } from './Markdown.tsx';
import { useNow } from './clock.ts';
import type { HubEvent, Post, TaskView } from './types.ts';

import { MIN_WIDTH } from './columns.ts';
import { WIDTH_STEP } from './deckKeys.ts';
/** What Codex calls a background command it cannot name. */
const CODEX_UNNAMED = '백그라운드 명령';
/** The CLI's note to the parent agent that a handed-back report came as a message: nothing for a person to read. */
const isHandoffNotice = (summary: string) => summary.startsWith("This agent's report was delivered");

/** The key of the background commands' column. */
const COMMANDS = 'commands';
const HISTORY = 'history';

/**
 * What the deck's keys (deckKeys.ts) do in the pane: `h` from the thread enters its last column;
 * there h / l move between columns (l past the last one goes back to the thread), j / k / G / gg
 * between posts, o or Space opens a post's tool calls, < / > change the column's width.
 */
export interface SubagentPaneKeys { focused(): boolean; enter(): boolean; key(k: string): boolean }

interface ColumnHandle { step(dir: 1 | -1): void; edge(dir: 1 | -1): void; toggle(): void }

export function SubagentPanel({ task, subagents, reload, reveal, keys, threadFeed, projectColor, onClose, onError }: {
  task: TaskView; subagents: Subagent[]; reload: number;
  /** A subagent to show and focus (a chip was pressed); `n` tells a repeated press apart. */
  reveal?: { key: string; n: number };
  threadFeed: RefObject<HTMLDivElement | null>; projectColor: string;
  keys: RefObject<SubagentPaneKeys | null>;
  onClose: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const agents = useMemo(() => subagents.filter(s => !isCommand(s) && isActive(s)), [subagents]);
  const history = useMemo(() => subagents.filter(s => !isCommand(s) && !isActive(s)), [subagents]);
  const commands = useMemo(() => subagents.filter(isCurrentCommand), [subagents]);
  const byKey = useMemo(() => new Map(agents.map(s => [subagentKey(s), s])), [agents]);
  const columnOf = (key: string) => commands.some(s => subagentKey(s) === key) ? COMMANDS : history.some(s=>subagentKey(s)===key) ? HISTORY : key;
  const [historyFocus,setHistoryFocus]=useState<{key:string;n:number}>();
  const [commandFocus, setCommandFocus] = useState<{ key: string; n: number }>();
  // Active columns are automatic; finished records share one persistent history column.
  const all = useMemo(() => [HISTORY, ...(commands.length ? [COMMANDS] : []), ...agents.map(subagentKey)], [agents, commands]);
  const on = all;
  // The focused column by key, so a column coming in ahead of it does not move the focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focus = focusKey && on.includes(focusKey) ? on.indexOf(focusKey) : null;
  const [widths, setWidths] = useState<Record<string, number>>({});
  const handles = useRef(new Map<string, ColumnHandle>());
  const colsRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const thread = threadFeed.current?.closest<HTMLElement>('[data-col="thread"]');
    const pane = paneRef.current;
    if (!thread || !pane) return;
    const sync = () => pane.style.setProperty('--w', `${thread.getBoundingClientRect().width}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(thread);
    return () => observer.disconnect();
  }, [threadFeed]);

  const scrollTo = (key: string) => requestAnimationFrame(() =>
    colsRef.current?.querySelector(`[data-column="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  const moveFocus = (key: string | null) => { setFocusKey(key); if (key) scrollTo(key); };
  const revealed = !!reveal && all.includes(columnOf(reveal.key));
  useEffect(() => {
    if (!reveal || !revealed) return;
    const column = columnOf(reveal.key);
    moveFocus(column);
    if (column === HISTORY) setHistoryFocus({key:reveal.key,n:reveal.n});
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
          const width = widths[on[focus]] ?? colsRef.current?.querySelector<HTMLElement>(`[data-column="${CSS.escape(on[focus])}"]`)?.offsetWidth ?? MIN_WIDTH;
          setWidths({ ...widths, [on[focus]]: Math.max(MIN_WIDTH, width + (k === '>' ? WIDTH_STEP : -WIDTH_STEP)) });
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

  const visibleCount = subagents.filter(s=>!isCommand(s)).length + commands.length;
  const running = agents.filter(isActive).length + commands.length;
  const setHandle = (key: string) => (h: ColumnHandle | null) => { if (h) handles.current.set(key, h); else handles.current.delete(key); };
  const engine = ENGINE_LABEL[engineOf(task.engine ?? 'claude')] ?? task.engine;

  return (
    <aside className="thread-references subagent-panel" aria-label="서브 에이전트·백그라운드" ref={paneRef} style={{'--pc':projectColor} as CSSProperties}>
      <header className="reference-head">
        <div><h2><Bot /> 서브 에이전트·백그라운드 <span>{running ? `실행 중 ${running} · ` : ''}{visibleCount}</span></h2><p>{task.project_name}#{task.seq}</p></div>
        <button className="icon-btn" title="서브 에이전트 창 닫기 (b)" aria-label="서브 에이전트 창 닫기" onClick={onClose}><PanelLeftClose /></button>
      </header>
      <div className="sa-cols" ref={colsRef}>
        {on.map((key, i) => key === HISTORY ? (
          <HistoryColumn key={key} reveal={historyFocus} task={task} agents={history} reload={reload} focused={focus===i} width={widths[key]}
            handle={setHandle(key)} onFocus={()=>setFocusKey(key)} onError={onError} />
        ) : key === COMMANDS ? (
          <CommandsColumn key={key} task={task} onError={onError} commands={commands} all={subagents} focused={focus === i} width={widths[key]} reveal={commandFocus}
            handle={setHandle(key)} onFocus={() => setFocusKey(key)} />
        ) : (
          <SubagentColumn key={key} s={byKey.get(key)!} reload={reload} task={task} engine={engine} focused={focus === i} width={widths[key]}
            handle={setHandle(key)} onFocus={() => setFocusKey(key)} onError={onError} />
        ))}
      </div>
    </aside>
  );
}

function HistoryColumn({task, agents, reveal, reload, focused, width, handle, onFocus, onError}: {
  task:TaskView; agents:Subagent[]; reveal?:{key:string;n:number}; reload:number; focused:boolean; width?:number;
  handle:(h:ColumnHandle|null)=>void; onFocus:()=>void; onError:(message:string)=>void;
}) {
  const {events,more,loading,error,older,whole}=useSubagentEvents(undefined,reload,{taskId:task.id,members:agents});
  const [extra,setExtra]=useState<{key:string;events:HubEvent[]}>();
  const complete = !loading && !error && !more || (extra?.events.length === 0 && extra.key);
  const rows=useMemo(()=>subagentHistoryPosts(agents,mergeTaskEvents(events,extra?.events??[]),complete),[agents,events,extra,complete]);
  const [selected,setSelected]=useState<string|null>(null);
  const [expanded,setExpanded]=useState<ReadonlySet<string>>(()=>new Set());
  const feed=useRef<HTMLDivElement>(null);
  const anchor=useRef<{key:string;offset:number;top:number}|undefined>(undefined);
  const rememberPosition=()=>{
    const f=feed.current;if(!f)return;
    if(f.scrollTop<1){anchor.current=undefined;return;}
    const edge=f.getBoundingClientRect().top;
    const row=[...f.querySelectorAll<HTMLElement>('[data-history-key]')].find(e=>e.getBoundingClientRect().bottom>edge+1);
    if(row)anchor.current={key:row.dataset.historyKey!,offset:row.getBoundingClientRect().top-edge,top:f.scrollTop};
  };
  useLayoutEffect(()=>{
    const f=feed.current,a=anchor.current;
    if(f&&a){const row=f.querySelector<HTMLElement>(`[data-history-key="${CSS.escape(a.key)}"]`);f.scrollTop=row?f.scrollTop+row.getBoundingClientRect().top-f.getBoundingClientRect().top-a.offset:a.top;}
    rememberPosition();
  },[rows]);
  const toggle=(key:string)=>{setExpanded(prev=>{const next=new Set(prev);if(!next.delete(key))next.add(key);return next;});void whole();};
  const select=(index:number)=>{const row=rows[Math.max(0,Math.min(index,rows.length-1))];if(!row)return;setSelected(row.key);feed.current?.querySelector(`[data-history-key="${CSS.escape(row.key)}"]`)?.scrollIntoView({block:'nearest'});};
  const target = reveal && agents.find(a=>subagentKey(a)===reveal.key);
  useEffect(()=>{
    setExtra(undefined);
    if(!target || !reveal)return;
    let live=true;
    setSelected(`${reveal.key}/status`);
    if(target.detailed)void api.subagentEvents(target).then(page=>{if(live)setExtra({key:reveal.key,events:page.events});},e=>{if(live)onError(String(e));});
    return ()=>{live=false;};
  },[reveal?.n,task.id,!!target]);
  useLayoutEffect(()=>{
    if(!reveal||!target)return;
    const row=rows.find(r=>subagentKey(r.agent)===reveal.key&&!r.summary)??rows.find(r=>r.key===`${reveal.key}/status`);
    if(row){setSelected(row.key);feed.current?.querySelector(`[data-history-key="${CSS.escape(row.key)}"]`)?.scrollIntoView({block:'nearest'});}
  },[reveal?.n,extra]);
  const current=rows.findIndex(r=>r.key===selected);
  handle({step:dir=>select(current<0?0:current+dir),edge:dir=>select(dir>0?rows.length-1:0),toggle:()=>{if(selected)toggle(selected);}});
  useEffect(()=>()=>handle(null),[]);
  return <section className={`column sa-col${focused?' focused':''}`} data-column={HISTORY} aria-label="서브 에이전트 히스토리"
    style={width?{'--w':`${width}px`} as CSSProperties:undefined} onMouseDown={onFocus}>
    <ColumnHeader><h2>서브 에이전트 히스토리</h2><span className="count">{agents.length}</span><span className="filter">최근 기록부터</span></ColumnHeader>
    <div className="feed sa-feed" ref={feed} onScroll={e=>{rememberPosition();const f=e.currentTarget;if(f.scrollHeight-f.scrollTop-f.clientHeight<80)void older();}}>
      {!loading && !more && !rows.length && !error && <p className="empty">표시할 서브 에이전트 기록이 없습니다.</p>}
      {rows.map(({key,agent,post,showStatus})=><div key={key} data-history-key={key} data-subagent={subagentKey(agent)}>
        <PostView post={post} task={task} model={undefined} approval={undefined} colId="subagent-history"
          selected={selected===key} expanded={expanded.has(key)} working={false} flash={false}
          speaker={{name:subagentTitle(agent),avatar:'SA',tag:showStatus?statusText(agent):post.kind==='user'?'지시':'기록'}}
          onSelect={()=>setSelected(key)} onToggle={()=>toggle(key)} onAllow={()=>{}} onDeny={()=>{}} onError={onError}/>
      </div>)}
      {error && <p role="alert" className="sa-note">기록을 불러오지 못했습니다: {error}<button className="link" onClick={()=>void whole()}>다시 시도</button></p>}
      {loading && <p className="sa-note">불러오는 중…</p>}
      {more && <button className="link sa-older" disabled={loading} onClick={()=>void older()}>이전 기록 더 보기</button>}
    </div>
  </section>;
}

function SubagentColumn({ s, reload, task, engine, focused, width, handle, onFocus, onError }: {
  s: Subagent; reload: number; task: TaskView; engine: string; focused: boolean; width?: number;
  handle: (h: ColumnHandle | null) => void; onFocus: () => void; onError: (message: string) => void;
}) {
  const now = useNow();
  const column = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !s.detailed || !column.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(column.current);
    return () => observer.disconnect();
  }, [seen, s.detailed]);
  const { events, more, loading, error, older, whole } = useSubagentEvents(seen && s.detailed ? s : undefined, reload);
  const posts = useMemo(() => subagentPosts(withSubagentAnswers(events), s), [events, s]);
  // The answer to the latest instruction: a follow-up after it starts a run that answers anew.
  const answer = posts.findLast(p => p.event.payload.handback || p.kind === 'user');
  const handedBack = answer?.event.payload.handback ? answer : undefined;
  // A live answer comes cut like any tool input; it is read whole.
  useEffect(() => { if (handedBack?.event.payload.clipped) void whole(); }, [handedBack?.id, handedBack?.event.payload.clipped]);
  const [sel, setSel] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const feed = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const olderAnchor = useRef<{id:string; offset:number} | null>(null);
  const loadOlder = () => {
    const f = feed.current;
    if (!f || loading || !more) return;
    const edge = f.getBoundingClientRect().top;
    const row = [...f.querySelectorAll<HTMLElement>('[data-post]')].find(el => Number(el.dataset.post)>0 && el.getBoundingClientRect().bottom>edge);
    if (row) olderAnchor.current = {id:row.dataset.post!,offset:row.getBoundingClientRect().top-edge};
    void older();
  };
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
    if (!f) return;
    const anchor = olderAnchor.current;
    if (anchor) {
      if (loading) return;
      olderAnchor.current = null;
      const row = f.querySelector(`[data-post="${anchor.id}"]`);
      if (row) { f.scrollTop += row.getBoundingClientRect().top - f.getBoundingClientRect().top - anchor.offset; return; }
    }
    if (atBottom.current) f.scrollTop = f.scrollHeight;
  }, [events.length, s.status, loading]);

  const firstPrompt = posts.find(p => p.kind === 'user')?.id;
  const speaker = (p: Post) => p.kind === 'user'
    ? { name: `${engine} → ${subagentKind(s) === '명령' ? '명령' : '서브 에이전트'}`, avatar: '↳', tag: p.id === firstPrompt ? '지시문' : '추가 지시' }
    : { name: subagentKind(s), avatar: 'SA', ...(p.event.payload.handback && { tag: `${engine}에게 보낸 답` }) };

  return (
    <section ref={column} className={`column sa-col thread-surface ${subagentTone(s)}${focused ? ' focused' : ''}`}
      style={width ? { '--w': `${width}px` } as CSSProperties : undefined} aria-label={subagentTitle(s)} data-column={subagentKey(s)} onMouseDown={onFocus}>
      <header className="thread-head"><div className="row1"><h2 title={subagentTitle(s)}>{subagentTitle(s)}</h2></div>
        <div className="meta"><span>{subagentMeta(s,now)}</span><span>글 {posts.length}개</span></div></header>
      <div className="feed sa-feed thread-feed" ref={feed} onScroll={e => {
        const f = e.currentTarget;
        atBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
        if (f.scrollTop < 80) loadOlder();
      }}>
        {!s.detailed && <p className="sa-note">상태 목록만 수신한 항목입니다. 해당 실행의 상세 기록이 허브에 전달되지 않아 대화를 복구할 수 없습니다.</p>}
        {s.detailNote && <p className="sa-note">{s.detailNote}</p>}
        {more && <button className="link sa-older" disabled={loading} onClick={loadOlder}>이전 기록 더 보기</button>}
        {error && <p role="alert" className="sa-note">기록을 불러오지 못했습니다: {error}</p>}
        {s.detailed && loading && !events.length && <p className="sa-note">불러오는 중…</p>}
        {posts.map(p => (
          <PostView key={p.id} post={p} task={task} model={undefined} approval={undefined} colId={`subagent:${subagentKey(s)}`}
            selected={sel === p.id} expanded={expanded.has(p.id)} working={false} flash={false} speaker={speaker(p)}
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
function CommandsColumn({ task, onError, commands, all, focused, width, reveal, handle, onFocus }: {
  task:TaskView; onError:(message:string)=>void; commands: Subagent[]; all: Subagent[]; focused: boolean; width?: number; reveal?: { key: string; n: number };
  handle: (h: ColumnHandle | null) => void; onFocus: () => void;
}) {
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
    <section className={`column sa-col${running ? ' running' : ' done'}${focused ? ' focused' : ''}`}
      style={width ? { '--w': `${width}px` } as CSSProperties : undefined} aria-label="백그라운드 작업" data-column={COMMANDS} onMouseDown={onFocus}>
      <ColumnHeader><h2>백그라운드 작업</h2><span className="count">{commands.length}</span><span className="filter">실행 중 {running}</span></ColumnHeader>
      <div className="feed sa-feed" ref={feed} onScroll={e => {
        const f = e.currentTarget;
        atBottom.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
      }}>
        {commands.map((s,i) => {
          const key=subagentKey(s),command=s.command ?? (s.type==='shell' && s.description!==CODEX_UNNAMED?s.description:undefined);
          const output=s.output??s.summary;
          const fence='`'.repeat(Math.max(3,...[...(output??'').matchAll(/`+/g)].map(m=>m[0].length+1)));
          const text=s.description+(output?`\n\n현재 출력:\n\n${fence}\n${output}\n${fence}`:'');
          const event:HubEvent={id:-(i+1),task_id:task.id,session_id:s.session_id,ts:s.created_at,kind:'assistant',payload:{text}};
          const post=buildPosts([event])[0];
          if(command)post.activity.push({...event,kind:'tool',payload:{toolUseId:key,name:'Bash',input:{command}}});
          const from=starter(s);
          return <div key={key} data-command={key} className="sa-command">
            <PostView post={post} task={task} model={undefined} approval={undefined} colId="subagent-commands"
              selected={sel===key} expanded={open.has(key)} working={true} flash={false}
              speaker={{name:'백그라운드 작업',avatar:'BG',tag:from?`${subagentTitle(from)} · 실행 중`:'실행 중'}}
              onSelect={()=>setSel(key)} onToggle={()=>toggle(key)} onAllow={()=>{}} onDeny={()=>{}} onError={onError}/>
          </div>;
        })}
      </div>
    </section>
  );
}
