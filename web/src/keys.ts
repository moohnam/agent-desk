import type { Post } from './types.ts';

/** Some WebKit IME confirmation events are marked only by the legacy key code. */
export function imeKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process';
}

export type ImeEscapeStroke = true | number | undefined;
export function holdsImeEscape(stroke: ImeEscapeStroke, event: KeyboardEvent) {
  return stroke === true || (stroke !== undefined && event.timeStamp < stroke);
}

/** An IME-marked keyup can precede the plain Escape event of the same physical key press. */
export function releaseImeEscape(stroke: ImeEscapeStroke, event: KeyboardEvent): ImeEscapeStroke {
  if (stroke === undefined || (event.key !== 'Escape' && event.code !== 'Escape')) return stroke;
  if (event.key === 'Escape' && !imeKey(event)) return undefined;
  return stroke === true ? event.timeStamp + 40 : stroke;
}

/** Without a selected post, reply to the column's task or its newest post (feed order). */
export function replyTaskId(selected: Post | undefined, threadTask: string | null, columnTaskIds?: string[], newest?: Post): string | null {
  return selected?.taskId ?? threadTask ?? (columnTaskIds?.length === 1 ? columnTaskIds[0] : null) ?? newest?.taskId ?? null;
}

/**
 * Normalize a shortcut key by position for non-Latin input sources, such as ㅏ → k.
 */
export function latinKey(e: KeyboardEvent): string {
  const m = /^Key([A-Z])$/.exec(e.code);
  if (!m || /^[a-zA-Z]$/.test(e.key)) return e.key;
  return e.shiftKey ? m[1] : m[1].toLowerCase();
}

// Where J / K and Ctrl+Shift J / K land in a column's posts (newest first in a feed, oldest first in a
// thread): an index into `posts`, from the selected one at `cur` (-1: none), going `dir`.

/** J / K: the first post of the next / previous run of another task's posts; the ends when there is none. */
export function nextTaskIndex(posts: Post[], cur: number, dir: 1 | -1): number {
  if (cur < 0) return 0;
  const taskOf = (i: number) => posts[i].taskId;
  let i = cur;
  while (i + dir >= 0 && i + dir < posts.length && taskOf(i + dir) === taskOf(cur)) i += dir;
  i += dir;
  if (i < 0 || i >= posts.length) return dir > 0 ? posts.length - 1 : 0;
  if (dir < 0) while (i > 0 && taskOf(i - 1) === taskOf(i)) i--;
  return i;
}

/** J / K in a thread, where every post is one task's: the next / previous post the user wrote, or null. */
export function nextUserIndex(posts: Post[], cur: number, dir: 1 | -1): number | null {
  let i = cur < 0 ? (dir > 0 ? 0 : posts.length - 1) : cur + dir;
  while (i >= 0 && i < posts.length && posts[i].kind !== 'user') i += dir;
  return i >= 0 && i < posts.length ? i : null;
}

/**
 * Ctrl+Shift+J / K: the next / previous task run's topmost post the user wrote, or null; a run's later
 * instructions and runs without one are passed over.
 */
export function nextMineIndex(posts: Post[], cur: number, dir: 1 | -1): number | null {
  const landing = (i: number) => {
    if (posts[i].kind !== 'user') return false;
    for (let j = i - 1; j >= 0 && posts[j].taskId === posts[i].taskId; j--) if (posts[j].kind === 'user') return false;
    return true;
  };
  let i = cur < 0 ? (dir > 0 ? 0 : posts.length - 1) : cur + dir;
  while (i >= 0 && i < posts.length && !landing(i)) i += dir;
  return i >= 0 && i < posts.length ? i : null;
}
