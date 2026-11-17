import { memo, type RefObject } from 'react';
import { pickable } from './Handoff.tsx';
import { PostView } from './PostView.tsx';
import type { ColumnCtx, DeckColumn } from './FeedColumn.tsx';
import type { Post } from './types.ts';

export interface ThreadPostActions {
  select(post: Post): void;
  toggle(post: Post): void;
  allow(post: Post): void;
  deny(post: Post): void;
  reference(post: Post): void;
  pick(post: Post): void;
}

/** Keep the existing DOM and scroll geometry; unrelated columns don't rebuild this list. */
export const ThreadPosts = memo(function ThreadPosts({ col, ctx, selected, flash, expanded, picked, referenced, taskId, actions, onError }: {
  col: DeckColumn; ctx: ColumnCtx; selected?: number; flash: number | null; expanded: Set<number>;
  picked?: number[]; referenced?: Set<number>; taskId: string | null;
  actions: RefObject<ThreadPostActions>; onError: (message: string) => void;
}) {
  return col.placed.map(({ post: p, up, down }) => (
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
});
