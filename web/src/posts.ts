import type { ColumnFilter, HubEvent, PlacedPost, Post, PostKind, TaskView } from './types.ts';

/** Merges two id-ordered event lists, dropping duplicates and keeping at most `cap` newest. */
export function mergeEvents(a: HubEvent[], b: HubEvent[], cap = Infinity): HubEvent[] {
  if (!b.length) return a;
  const last = a[a.length - 1];
  let out: HubEvent[];
  if ((!last || last.id < b[0].id) && b.every((e, i) => i === 0 || b[i - 1].id < e.id)) {
    // All newer and in order (a live batch): append without a Map and a sort.
    out = a.concat(b);
  } else {
    const byId = new Map<number, HubEvent>();
    for (const e of a) byId.set(e.id, e);
    for (const e of b) byId.set(e.id, e);
    out = [...byId.values()].sort((x, y) => x.id - y.id);
  }
  return out.length > cap ? out.slice(-cap) : out;
}

function postKind(e: HubEvent): PostKind | null {
  switch (e.kind) {
    case 'user': return 'user';
    case 'assistant': case 'update': return 'assistant';
    case 'approval': return e.payload.decision === 'pending' ? 'approval' : null;
    case 'question': return e.payload.decision === 'pending' ? 'question' : null;
    case 'status': return ['error', 'interrupted', 'queue_dropped'].includes(e.payload.state) ? 'alert' : null;
    default: return null;
  }
}

/**
 * Status events with nothing to say: empty turns from background task notices and repeated
 * session starts, which older hubs recorded on every turn.
 */
function isNoise(e: HubEvent, prev: Post | undefined): boolean {
  if (e.kind !== 'status') return false;
  if (e.payload.state === 'turn_done' && e.payload.detail?.num_turns === 0) return true;
  if (e.payload.state === 'started' && prev) {
    const last = prev.activity[prev.activity.length - 1];
    return last?.kind === 'status' && last.payload.state === 'started';
  }
  return false;
}

/**
 * Turns an id-ordered event stream into chronological posts. Tool calls, results and
 * routine status changes attach to the preceding post of the same task; an approval
 * decision attaches to its request, and a question's cancellation or answer to the question.
 * An answer (`user` event with `answers`) still gets its own post as well.
 */
export function buildPosts(events: HubEvent[]): Post[] {
  const posts: Post[] = [];
  const lastByTask = new Map<string, Post>();
  const requests = new Map<string, Post>();
  const questions = new Map<string, Post>();
  /** A Codex async question (assistant post with `questions`) per task, answered by the next user message. */
  const asyncAsks = new Map<string, Post>();
  for (const e of events) {
    if (e.kind === 'user') {
      const q = asyncAsks.get(e.task_id);
      if (q) { q.resolution ??= e; asyncAsks.delete(e.task_id); }
    }
    if (e.kind === 'approval' && e.payload.decision !== 'pending') {
      const req = requests.get(e.payload.approvalId);
      if (req) { req.resolution = e; continue; }
    }
    if (e.kind === 'question' && e.payload.decision !== 'pending') {
      const q = questions.get(e.payload.questionId);
      if (q) { q.resolution ??= e; continue; }
    }
    if (e.kind === 'user' && e.payload.answers) {
      const q = questions.get(e.payload.answers);
      if (q && !q.resolution) q.resolution = e;
    }
    if (isNoise(e, lastByTask.get(e.task_id))) continue;
    const kind = postKind(e);
    if (!kind) {
      lastByTask.get(e.task_id)?.activity.push(e);
      continue;
    }
    const post: Post = { id: e.id, taskId: e.task_id, kind, event: e, activity: [], parent: lastByTask.get(e.task_id) };
    posts.push(post);
    lastByTask.set(e.task_id, post);
    if (kind === 'approval') requests.set(e.payload.approvalId, post);
    if (kind === 'question') questions.set(e.payload.questionId, post);
    if (kind === 'assistant' && e.payload.questions?.length) asyncAsks.set(e.task_id, post);
  }
  return posts;
}

export function postText(p: Post): string {
  const pl = p.event.payload;
  return String(pl.text ?? pl.toolName ?? pl.detail?.message ?? '');
}

export function matches(f: ColumnFilter, p: Post, task: TaskView | undefined): boolean {
  if (f.taskIds?.length && !f.taskIds.includes(p.taskId)) return false;
  if (f.kinds?.length && !f.kinds.includes(p.kind)) return false;
  if (f.projectIds?.length && (!task || !f.projectIds.includes(task.project_id))) return false;
  if (f.statuses?.length && (!task || !f.statuses.includes(task.status))) return false;
  if (f.query?.trim()) {
    const q = f.query.trim().toLowerCase();
    if (!postText(p).toLowerCase().includes(q) && !task?.title.toLowerCase().includes(q)) return false;
  }
  return true;
}

const CHAIN_MAX = 3;

/**
 * Lays out a feed column like a timeline of conversations: runs of consecutive posts from the
 * same task are connected, at most CHAIN_MAX per run. Like the rest of the feed, a run reads
 * newest first, so a reply sits above the post it answers. Threads keep chat order (placeThread).
 *
 * Runs are cut from the oldest post up, so a new post only joins or starts the top run: the runs
 * below keep their posts (and their oldest post, the group's key) instead of all shifting by one.
 */
export function placeFeed(newestFirst: Post[]): PlacedPost[] {
  const runs: Post[][] = [];
  for (let j = newestFirst.length; j > 0;) {
    let i = j - 1;
    while (i > 0 && j - i < CHAIN_MAX && newestFirst[i - 1].taskId === newestFirst[j - 1].taskId
      && newestFirst[i - 1].parent === newestFirst[i]) i--;
    runs.push(newestFirst.slice(i, j));
    j = i;
  }
  return runs.reverse().flatMap((run) => run.map((post, k) => ({ post, up: k > 0, down: k < run.length - 1 })));
}

/** A thread is one continuous conversation, oldest first. */
export function placeThread(posts: Post[]): PlacedPost[] {
  return posts.map((post, k) => ({ post, up: k > 0, down: k < posts.length - 1 }));
}
