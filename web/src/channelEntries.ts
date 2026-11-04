import type { ChannelEntry } from './types.ts';

export const CHANNEL_ENTRY_CAP = 400;
/** One bounded window. Paging backwards evicts newer entries; the newest button opens that window again. */
export function mergeChannelEntries(current: ChannelEntry[], incoming: ChannelEntry[], older = false): ChannelEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  incoming.forEach((entry) => byId.set(entry.id, entry));
  const sorted = [...byId.values()].sort((a, b) => b.id - a.id);
  return older ? sorted.slice(-CHANNEL_ENTRY_CAP) : sorted.slice(0, CHANNEL_ENTRY_CAP);
}
/** HTTP pages may predate SSE updates received while the request was pending. */
export function applyChannelUpdates(page: ChannelEntry[], updates: Iterable<ChannelEntry>, query: string, includeNew = true): ChannelEntry[] {
  const byId = new Map(page.map((entry) => [entry.id, entry]));
  const q = query.toLowerCase();
  for (const entry of updates) {
    if (!includeNew && !byId.has(entry.id)) continue;
    if (!q || `${entry.title}\n${entry.body}`.toLowerCase().includes(q)) byId.set(entry.id, entry);
    else byId.delete(entry.id);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
export function safeChannelUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

/** A copyable example never contains the once-only producer secret. */
export function botIngestExample(origin: string, channelId: string): string {
  const url = new URL(`/api/channels/${encodeURIComponent(channelId).replace(/'/g, '%27')}/entries`, origin).href;
  return `curl --fail-with-body -X POST '${url}' \\\n  -H "Authorization: Bearer $CHANNEL_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  --data '{"external_id":"build-42","title":"빌드 완료","body":"테스트를 통과했습니다.","url":"https://example.com/build/42"}'`;
}
