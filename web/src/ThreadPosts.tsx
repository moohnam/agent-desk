import { PureComponent, startTransition, type RefObject } from 'react';
import { pickable } from './Handoff.tsx';
import { firstPostBelow } from './layout.ts';
import { PostView } from './PostView.tsx';
import type { ColumnCtx, DeckColumn } from './FeedColumn.tsx';
import type { PlacedPost, Post } from './types.ts';

export interface ThreadPostActions {
  select(post: Post): void;
  toggle(post: Post): void;
  allow(post: Post): void;
  deny(post: Post): void;
  reference(post: Post): void;
  pick(post: Post): void;
}

interface Props {
  col: DeckColumn; ctx: ColumnCtx; selected?: number; target?: number; flash: number | null; expanded: Set<number>;
  picked?: number[]; referenced?: Set<number>; taskId: string | null;
  actions: RefObject<ThreadPostActions>; onError: (message: string) => void;
  feed: RefObject<HTMLDivElement | null>; atBottom: RefObject<boolean>; onPostsMounted: () => void;
}

interface Range { first: number; last: number }
type ScrollAnchor = { id: string; offset: number } | 'bottom' | null;

const BATCH = 12;

/** The derived range uses event IDs so new history can be inserted on either side. */
function lowerBound(posts: PlacedPost[], id: number) {
  let lo = 0, hi = posts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posts[mid].post.id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function around(posts: PlacedPost[], at: number): Range {
  return { first: posts[Math.max(0, at - BATCH + 1)].post.id, last: posts[Math.min(posts.length - 1, at + BATCH - 1)].post.id };
}

/** Mount the post being opened and its neighbors first, then fill the rest between paints. */
export class ThreadPosts extends PureComponent<Props, Range, ScrollAnchor> {
  state = { first: Infinity, last: -Infinity };
  private frame: number | null = null;

  static getDerivedStateFromProps({ col: { placed }, target }: Props, range: Range): Range | null {
    if (!placed.length) return null;
    const at = target == null ? placed.length - 1 : lowerBound(placed, target);
    const hasTarget = placed[at]?.post.id === target;
    if (range.first > range.last || (hasTarget && (target! < range.first || target! > range.last))) {
      return around(placed, hasTarget ? at : placed.length - 1);
    }
    // Follow a small burst of live posts without waiting for a scheduled expansion.
    const last = lowerBound(placed, range.last + 1);
    if (placed.length > last && placed.length - last <= BATCH) return { ...range, last: placed[placed.length - 1].post.id };
    return null;
  }

  componentDidMount() { this.scheduleExpansion(); }

  getSnapshotBeforeUpdate(previous: Props, old: Range): ScrollAnchor {
    const feed = this.props.feed.current;
    if (!feed || old.first > old.last || (this.state.first === old.first && this.state.last === old.last)) return null;
    // A disjoint range is a keyboard jump or a new opening point. The caller reveals it.
    if (this.state.first > old.last || this.state.last < old.first) return null;
    if (this.props.atBottom.current && previous.col.placed.at(-1)?.post.id === old.last) return 'bottom';
    if (this.state.first >= old.first) return null;
    const top = feed.getBoundingClientRect().top;
    const post = firstPostBelow(feed, top);
    return post?.dataset.post ? { id: post.dataset.post, offset: post.getBoundingClientRect().top - top } : null;
  }

  componentDidUpdate(_previous: Props, old: Range, anchor: ScrollAnchor) {
    const feed = this.props.feed.current;
    if (feed && anchor) {
      if (anchor === 'bottom') feed.scrollTop = feed.scrollHeight;
      else {
        const post = feed.querySelector<HTMLElement>(`[data-post="${anchor.id}"]`);
        if (post) feed.scrollTop += post.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset;
      }
    }
    if (this.state.first !== old.first || this.state.last !== old.last) this.props.onPostsMounted();
    this.scheduleExpansion();
  }

  componentWillUnmount() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private scheduleExpansion() {
    const { placed } = this.props.col;
    if (this.frame != null || !placed.length || (placed[0].post.id >= this.state.first && placed.at(-1)!.post.id <= this.state.last)) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      startTransition(() => this.setState((range, { col: { placed } }) => {
        if (!placed.length) return null;
        const first = lowerBound(placed, range.first);
        const last = lowerBound(placed, range.last + 1);
        // Before an anchored post, leave room to read forward first. At the tail, grow backward.
        const forward = Math.min(placed.length - last, BATCH);
        return { first: placed[Math.max(0, first - (BATCH - forward))].post.id,
          last: placed[Math.min(placed.length - 1, last + forward - 1)].post.id };
      }));
    });
  }

  render() {
    const { col, ctx, selected, flash, expanded, picked, referenced, taskId, actions, onError } = this.props;
    const { first, last } = this.state;
    const visible = col.placed.slice(lowerBound(col.placed, first), lowerBound(col.placed, last + 1));
    return visible.map(({ post: p, up, down }) => (
      <PostView key={p.id} post={p} task={ctx.tasks.get(p.taskId)} model={ctx.models.get(p.taskId)} up={up} down={down}
        approval={p.kind === 'approval' ? ctx.approvals.get(p.event.payload.approvalId) : undefined}
        question={p.kind === 'question' ? ctx.questions.get(p.event.payload.questionId) : undefined} onError={onError}
        colId={col.id} selected={selected === p.id} flash={flash === p.id}
        expanded={expanded.has(p.id)} working={ctx.working.has(p.id)} inThread
        draft={ctx.drafts.has(p.id)}
        picked={picked && pickable(p.event) ? picked.includes(p.event.id) : undefined}
        referenced={referenced && p.taskId === taskId ? referenced.has(p.id) : undefined}
        onReference={() => actions.current.reference(p)} onPick={() => actions.current.pick(p)}
        onSelect={() => actions.current.select(p)} onToggle={() => actions.current.toggle(p)}
        onAllow={() => actions.current.allow(p)} onDeny={() => actions.current.deny(p)} />
    ));
  }
}
