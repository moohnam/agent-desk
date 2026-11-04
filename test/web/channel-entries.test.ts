import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChannelUpdates, botIngestExample, CHANNEL_ENTRY_CAP, mergeChannelEntries, safeChannelUrl } from '../../web/src/channelEntries.ts';
import type { ChannelEntry } from '../../web/src/types.ts';

const entry = (id: number) => ({ id, channel_id: 'channel', external_id: String(id), title: `entry-${id}`, body: '<T> 2 < 3' } as ChannelEntry);
test('bot examples use the actual hub/channel endpoint and a secret-free environment placeholder', () => {
  const example = botIngestExample('https://desk.example.com', 'channel-123');
  assert.match(example, /https:\/\/desk.example.com\/api\/channels\/channel-123\/entries/);
  assert.ok(example.includes('Authorization: Bearer $CHANNEL_TOKEN'));
  assert.ok(example.includes('\\\n'));
  assert.match(example, /external_id/);
  assert.doesNotMatch(example, /127\.0\.0\.1/);
});
test('channel windows are bounded, deduplicate updates, and can page arbitrarily far back', () => {
  const current = Array.from({ length: CHANNEL_ENTRY_CAP }, (_, index) => entry(1000 - index));
  const live = mergeChannelEntries(current, [entry(1001), { ...entry(999), body: 'updated' }]);
  assert.equal(live.length, CHANNEL_ENTRY_CAP);
  assert.equal(live[0].id, 1001);
  assert.equal(live.find((item) => item.id === 999)?.body, 'updated');
  const older = mergeChannelEntries(current, Array.from({ length: 100 }, (_, index) => entry(600 - index)), true);
  assert.equal(older.length, CHANNEL_ENTRY_CAP);
  assert.equal(older.at(-1)?.id, 501);
  assert.equal(older[0].id, 900);
});
test('source links only open absolute HTTP or HTTPS URLs', () => {
  assert.equal(safeChannelUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeChannelUrl('http://example.com'), 'http://example.com/');
  for (const value of [null, '', '/local', 'file:///tmp/secret', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'akb:secret']) assert.equal(safeChannelUrl(value), undefined);
});
test('pending page responses retain later SSE inserts, edits and search removals without older cached entries', () => {
  const updates = [entry(1001), { ...entry(999), body: 'latest body' }];
  const page = applyChannelUpdates([entry(1000), entry(999)], updates, '');
  assert.deepEqual(page.map((item) => item.id), [1001, 1000, 999]);
  assert.equal(page.at(-1)?.body, 'latest body');
  assert.equal(page.some((item) => item.id === 500), false);
  assert.deepEqual(applyChannelUpdates([{ ...entry(999), body: 'needle' }], [{ ...entry(999), body: 'removed' }], 'needle'), []);
  assert.deepEqual(applyChannelUpdates([entry(500)], updates, '', false).map((item) => item.id), [500]);
});
