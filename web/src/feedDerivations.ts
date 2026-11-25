import { latestModels, newestPerTask, type ModelObservation } from './layout.ts';
import { matches, placeFeed } from './posts.ts';
import type { ColumnDef, HubEvent, PlacedPost, Post, TaskView } from './types.ts';

/** Event arrays are immutable. Unchanged feeds need only their small per-task model map. */
export function createModelLookup() {
  const cache = new WeakMap<HubEvent[], Map<string, ModelObservation>>();
  let previous = new Map<string, string>();
  return (...lists: HubEvent[][]) => {
    const latest = new Map<string, ModelObservation>();
    for (const list of lists) {
      let models = cache.get(list);
      if (!models) { models = latestModels(list); cache.set(list, models); }
      for (const [task, observation] of models) {
        if (!latest.has(task) || observation.id > latest.get(task)!.id) latest.set(task, observation);
      }
    }
    const next = new Map([...latest].map(([task, observation]) => [task, observation.model]));
    if (next.size === previous.size && [...next].every(([id, model]) => previous.get(id) === model)) return previous;
    previous = next;
    return next;
  };
}

type Entry = { key: string; tasks: Map<string, TaskView | undefined>; placed: PlacedPost[] };
/** Only fields consulted by matches can invalidate a column with unchanged posts. */
function sameFilterTask(a: TaskView | undefined, b: TaskView | undefined, filter: ColumnDef['filter']) {
  return (!filter.projectIds?.length || a?.project_id === b?.project_id)
    && (!filter.statuses?.length || a?.status === b?.status)
    && (!filter.query?.trim() || a?.title === b?.title);
}

/** One slot per grouping mode: shared feeds don't evict each other, and filters cannot accumulate. */
export function createFeedLayout() {
  const cache = new WeakMap<Post[], [Entry?, Entry?]>();
  return (posts: Post[], def: ColumnDef, tasks: Map<string, TaskView>): PlacedPost[] => {
    const key = JSON.stringify(def.filter), slot = def.byTask ? 1 : 0;
    const entries = cache.get(posts) ?? [];
    const old = entries[slot];
    if (old?.key === key && [...old.tasks].every(([id, task]) => sameFilterTask(task, tasks.get(id), def.filter))) {
      return old.placed;
    }
    const relevant = new Map<string, TaskView | undefined>();
    if (def.filter.projectIds?.length || def.filter.statuses?.length || def.filter.query?.trim()) {
      for (const post of posts) relevant.set(post.taskId, tasks.get(post.taskId));
    }
    const filtered = posts.filter(post => matches(def.filter, post, tasks.get(post.taskId)));
    const placed = def.byTask ? newestPerTask(filtered) : placeFeed(filtered);
    entries[slot] = { key, tasks: relevant, placed };
    cache.set(posts, entries);
    return placed;
  };
}
