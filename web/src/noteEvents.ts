import type { HubEvent, HubMessage } from './types.ts';

type NoteChange = Extract<HubMessage, { type: 'event_updated' | 'event_removed' }>;
// Protect overlapping HTTP reads and SSE updates, independently of the feed and thread sizes.
// Older changes are reconciled with the source when either view reloads its history.
const RECENT_CHANGES = 4096;
const REMOVED = -1;
const revisions = new Map<number, number>();
const listeners = new Set<(change: NoteChange) => void>();

export function noteRevision(event: HubEvent): number | undefined {
  return event.kind === 'user' && typeof event.payload?.revision === 'number' ? event.payload.revision : undefined;
}

export function reportNoteChange(change: NoteChange) {
  const id = change.type === 'event_removed' ? change.event_id : change.event.id;
  const revision = change.type === 'event_removed' ? REMOVED : noteRevision(change.event);
  const known = revisions.get(id);
  if (revision === undefined || known === REMOVED || (revision !== REMOVED && revision < (known ?? 0))) return;
  revisions.delete(id);
  revisions.set(id, revision);
  if (revisions.size > RECENT_CHANGES) revisions.delete(revisions.keys().next().value!);
  listeners.forEach(fn => fn(change));
}

export function onNoteChange(fn: (change: NoteChange) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Exclude versions that a feed or history request captured before an edit or deletion. */
export function visibleNoteEvents(events: HubEvent[]): HubEvent[] {
  if (!revisions.size) return events;
  const current = (event: HubEvent) => {
    const revision = revisions.get(event.id);
    return revision === undefined || (revision !== REMOVED && (noteRevision(event) ?? 0) >= revision);
  };
  return events.every(current) ? events : events.filter(current);
}
