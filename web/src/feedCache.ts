import { compareEvents } from './federation.ts';
import type { HubEvent } from './types.ts';

export const LIVE_FEED_LIMIT = 3000;
export const IDLE_FEED_LIMIT = 1000;
export const IDLE_QUERY_LIMIT = 8;

/** A single newest recovery boundary covers all evicted gaps, even with older pinned records. */
export function feedCursor(entry: { events: HubEvent[]; olderCursor?: HubEvent; gapCursor?: HubEvent }): HubEvent | undefined {
  let cursor = entry.events[0];
  for (const boundary of [entry.olderCursor, entry.gapCursor])
    if (boundary && (!cursor || compareEvents(boundary, cursor) > 0)) cursor = boundary;
  return cursor;
}

/** Keep reading windows intact; discarded older records remain pageable from the hub. */
export function compactFeed<T extends { events: HubEvent[]; more: boolean; gapCursor?: HubEvent }>(entry: T, limit: number, gone: Set<string>, retained?: ReadonlySet<number>): T {
  let events = entry.events;
  if (gone.size && events.some(event => gone.has(event.task_id))) events = events.filter(event => !gone.has(event.task_id));
  const cutoff = events.length - limit;
  const kept = cutoff > 0 ? retained?.size
    ? events.filter((event, index) => index >= cutoff || retained.has(event.id))
    : events.slice(-limit) : events;
  const trimmed = kept.length < events.length;
  let gapCursor = entry.gapCursor;
  if (trimmed) {
    // The first kept event AFTER the newest discarded event is an exclusive API cursor.
    // Its full timestamp/edited_at/id ordering matters; IDs alone are not chronological.
    for (let index = cutoff - 1; index >= 0; index--) if (!retained?.has(events[index].id)) {
      const boundary = events[index + 1];
      if (!gapCursor || compareEvents(boundary, gapCursor) > 0) gapCursor = boundary;
      break;
    }
    events = kept;
  }
  return events === entry.events ? entry : { ...entry, events, gapCursor, more: entry.more || trimmed };
}
