import type { HubEvent } from './types.ts';

export const LIVE_FEED_LIMIT = 3000;
export const IDLE_FEED_LIMIT = 1000;
export const IDLE_QUERY_LIMIT = 8;

/** Keep reading windows intact; discarded older records remain pageable from the hub. */
export function compactFeed<T extends { events: HubEvent[]; more: boolean }>(entry: T, limit: number, gone: Set<string>): T {
  let events = entry.events;
  if (gone.size && events.some(event => gone.has(event.task_id))) events = events.filter(event => !gone.has(event.task_id));
  const trimmed = events.length > limit;
  if (trimmed) events = events.slice(-limit);
  return events === entry.events ? entry : { ...entry, events, more: entry.more || trimmed };
}
