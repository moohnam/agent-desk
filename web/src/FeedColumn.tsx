import { ArrowDown, Ellipsis } from 'lucide-react';
import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { PostView } from './PostView.tsx';
import { projectColor } from './projects.ts';
import type { Approval, ColumnDef, PlacedPost, Post, Project, Question, TaskView } from './types.ts';
import { taskHue, groupsOf, filterLabel } from './layout.ts';
import { StatusBadge, TerminalBadge } from './badges.tsx';
import { ResizeHandle } from './handles.tsx';

/** A deck column as drawn: its definition (none for the thread), its posts, and how they are placed. */
export interface DeckColumn { id: string; def?: ColumnDef; placed: PlacedPost[]; posts: Post[] }
export const EXTERNAL_NOTE = '터미널 세션입니다. 에이전트가 질문하면 여기서 답할 수 있습니다.';

/** Posts a feed column draws at first, and adds at a time near its bottom. */
export const DRAWN = 40, DRAW_STEP = 60;
/** Drawn in a column off screen until it first comes into view: a view switch mounts far fewer posts. */
const DRAWN_HIDDEN = 8;
/** How near the bottom (px) a feed draws or loads more. */
export const EXTEND_PX = 600;
/** How long a feed stays at its top before it draws only its newest posts again. */
export const SHRINK_MS = 20_000;
/** What a feed column shows besides its posts: only the tasks, models and the rest its posts refer to. */
export interface ColumnCtx {
  tasks: Map<string, TaskView>; models: Map<string, string>; approvals: Map<string, Approval>; questions: Map<string, Question>;
  working: Set<number>; drafts: Set<number>;
}
export const sameMap = <K, V>(a: Map<K, V>, b: Map<K, V>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
export const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));
export function sameCtx(a: ColumnCtx, b: ColumnCtx): boolean {
  return sameMap(a.tasks, b.tasks) && sameMap(a.models, b.models) && sameMap(a.approvals, b.approvals)
    && sameMap(a.questions, b.questions) && sameSet(a.working, b.working) && sameSet(a.drafts, b.drafts);
}
export interface ColumnActions {
  press(colId: string): void;
  select(colId: string, postId: number): void;
  toggle(postId: number): void;
  allow(p: Post): void;
  deny(p: Post): void;
  openThread(taskId: string, from: string, post?: number): void;
  renaming(colId: string, on: boolean): void;
  rename(colId: string, title: string): void;
  menu(colId: string, r: DOMRect): void;
  scroll(colId: string, feed: HTMLElement): void;
  showNewest(colId: string): void;
  older(colId: string): void;
  resize(colId: string, px: number | null): void;
}

/**
 * A feed column. Memoized: it draws again only when its own posts, selection or context change, not
 * on every hub update or move to another column. `selected`: the selected post, given only while
 * the column is active. `head`: a header in place of the column's own (the search column's).
 */
export const FeedColumn = memo(function FeedColumn({ col, active, selected, width, ctx, projects, flash, expanded, tick, unseen, more,
  loading, total, renaming, empty, head, onError, act }: {
  col: DeckColumn; active: boolean; selected?: number; width: number; ctx: ColumnCtx; projects: Map<string, Project>;
  flash: number | null; expanded: Set<number>; tick: number; unseen: number; more: boolean; loading: boolean; total?: number;
  renaming: boolean; empty: string; head?: ReactNode; onError: (msg: string) => void; act: RefObject<ColumnActions>;
}) {
  const now = Date.now();
  const id = col.id;
  const placed = col.placed;
  // Only the newest posts are drawn: those down to `floor` (a post id), or the first DRAWN while it
  // is unset. Posts arriving above do not push drawn ones out. The rest stay loaded, drawn as the
  // feed nears its bottom or the selection goes there.
  const [floor, setFloor] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !sectionRef.current) return;
    // A floor set while hidden (a selection restored below the first posts) would hold the column short.
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); setFloor(null); } });
    io.observe(sectionRef.current);
    return () => io.disconnect();
  }, [seen]);
  const base = floor == null ? Math.min(seen ? DRAWN : DRAWN_HIDDEN, placed.length) : (() => {
    const k = placed.findIndex((x) => x.post.id === floor);
    return k < 0 ? placed.length : k + 1;
  })();
  const selectedAt = selected == null ? -1 : placed.findIndex((x) => x.post.id === selected);
  const count = Math.max(base, selectedAt + 1);
  const drawn = count < placed.length ? placed.slice(0, count) : placed;
  // The selection moved past the drawn posts (j, G): they stay drawn when it comes back up.
  useEffect(() => { if (count > base) setFloor(placed[count - 1].post.id); }, [count > base]);
  const feedRef = useRef<HTMLDivElement>(null);
  /** Near the bottom: draw more of the loaded posts, and load the next page before they run out. */
  const extend = (feed: HTMLElement) => {
    if (!seen) return;
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight >= EXTEND_PX) return;
    if (count < placed.length) setFloor(placed[Math.min(count + DRAW_STEP, placed.length) - 1].post.id);
    if (more && !loading && placed.length - count <= 2 * DRAW_STEP) act.current.older(id);
  };
  // Also after a render: a short column, or a page arriving while the feed sits at its bottom.
  useEffect(() => { if (feedRef.current) extend(feedRef.current); }, [placed, count, more, loading, width, expanded, seen]);
  // Back at the top for a while: draw only the newest posts again (the rest stay loaded).
  const shrink = useRef(0);
  useEffect(() => () => clearTimeout(shrink.current), []);
  const onScroll = (feed: HTMLElement) => {
    act.current.scroll(id, feed);
    extend(feed);
    clearTimeout(shrink.current);
    if (feed.scrollTop >= 40) { if (floor == null && count) setFloor(placed[count - 1].post.id); return; }
    if (floor != null) shrink.current = window.setTimeout(() => setFloor(null), SHRINK_MS);
  };
  return (
    <section ref={sectionRef} data-col={id} className={`column${active ? ' focused' : ''}`} style={{ '--w': `${width}px` } as CSSProperties}
      onMouseDown={() => act.current.press(id)}>
      {head ?? (
        <ColumnHead def={col.def!} loaded={col.posts.length} total={total} projects={projects} tasks={ctx.tasks}
          renaming={renaming} onRenaming={(on) => act.current.renaming(id, on)}
          onRename={(title) => act.current.rename(id, title)} onMenu={(r) => act.current.menu(id, r)} />
      )}
      <div className="feed" ref={feedRef} onScroll={(e) => onScroll(e.currentTarget)}>
        {unseen ? (
          <div className="new-posts">
            <button onClick={() => act.current.showNewest(id)}>↑ 새 글 {unseen}개</button>
          </div>
        ) : null}
        {groupsOf(drawn).map((group) => {
          const task = ctx.tasks.get(group[0].post.taskId);
          const pending = group.some(({ post }) => !post.resolution
            && (post.kind === 'approval' ? ctx.approvals.has(post.event.payload.approvalId)
              : post.kind === 'question' && ctx.questions.has(post.event.payload.questionId)));
          return (
            <div key={group[group.length - 1].post.id} className={`group${pending ? ' has-approval' : ''}`}
              style={task ? { '--pc': projectColor(task.project_id), '--th': taskHue(task.seq) } as CSSProperties : undefined}>
              {task && <GroupContext task={task} now={now} onOpen={() => act.current.openThread(task.id, id)} />}
              {group.map(({ post: p, up, down }) => (
                <PostView key={p.id} post={p} task={ctx.tasks.get(p.taskId)} model={ctx.models.get(p.taskId)} up={up} down={down}
                  approval={p.kind === 'approval' ? ctx.approvals.get(p.event.payload.approvalId) : undefined}
                  question={p.kind === 'question' ? ctx.questions.get(p.event.payload.questionId) : undefined} onError={onError}
                  colId={id} selected={selected === p.id} flash={flash === p.id} expanded={expanded.has(p.id)}
                  working={ctx.working.has(p.id)} inThread={false} draft={ctx.drafts.has(p.id)}
                  onSelect={() => act.current.select(id, p.id)} onToggle={() => act.current.toggle(p.id)}
                  onAllow={() => act.current.allow(p)} onDeny={() => act.current.deny(p)}
                  onOpenThread={() => act.current.openThread(p.taskId, id, p.id)} />
              ))}
            </div>
          );
        })}
        {empty && <p className="empty">{empty}</p>}
        {(more || count < placed.length) && (
          <div className="older-posts">
            <button disabled={loading} onClick={() => (count < placed.length
              ? setFloor(placed[Math.min(count + DRAW_STEP, placed.length) - 1].post.id) : act.current.older(id))}>
              {loading ? '불러오는 중…' : <><ArrowDown /> 이전 글 더 보기</>}
            </button>
          </div>
        )}
      </div>
      <ResizeHandle width={width} onResize={(px) => act.current.resize(id, px)} />
    </section>
  );
});

export function GroupContext({ task, now, onOpen }: { task: TaskView; now: number; onOpen: () => void }) {
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
export function ExternalNote({ pending, onAnswer }: { pending: boolean; onAnswer: () => void }) {
  return (
    <div className="reply-box external-note">
      <span>{EXTERNAL_NOTE}</span>
      {pending && <button className="link" title="질문에 답하기 (r)" onClick={onAnswer}>대기 중인 질문에 답하기 <kbd>r</kbd></button>}
    </div>
  );
}

/** `loaded`: the posts the column has loaded; `total`: all it has in the hub, when counted. */
export function ColumnHead({ def, loaded, total, projects, tasks, renaming, onRenaming, onRename, onMenu }: {
  def: ColumnDef; loaded: number; total?: number; projects: Map<string, Project>; tasks: Map<string, TaskView>;
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
      {total == null ? <span className="count" title="불러온 글">{loaded}</span> : (
        <span className="count" title={`불러온 글 ${loaded}개 / 전체 ${Math.max(total, loaded)}개`}>
          {loaded}<span className="of"> / {Math.max(total, loaded).toLocaleString()}</span>
        </span>
      )}
      <span className="filter" title={label}>{label}</span>
      <button className="icon-btn" title="컬럼 메뉴" aria-label="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}><Ellipsis /></button>
    </header>
  );
}
