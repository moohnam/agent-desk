import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { ChannelEntryInput, HubMessage } from '../../shared/api.ts';
import { Channels, feedUrl, isPublicAddress, MAX_ENTRY_BYTES, MAX_FEED_BYTES, parseFeed, type ChannelOptions, type FeedResponse } from '../../hub/src/channels.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import type { Access } from '../../hub/src/access.ts';
import { SkillStore } from '../../hub/src/skills.ts';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><guid>two</guid><title>Second</title><link>https://example.com/two</link><description><![CDATA[<p>Hello &amp; world</p><script>bad()</script>]]></description><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item>
<item><guid>one</guid><title>First</title><description>&lt;p&gt;Older&lt;/p&gt;</description></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>urn:entry:1</id><title>한글</title>
<link rel="self" href="/raw"/><link rel="alternate" href="/post"/><author><name>Ada</name></author>
<published>2026-11-01T12:00:00Z</published><content type="html">&lt;p&gt;Hello &amp;amp; thanks&lt;/p&gt;</content></entry></feed>`;
const entry = (id: string, body = `body ${id}`): ChannelEntryInput => ({ external_id: id, body });
const response = (body = RSS): FeedResponse => ({ status: 200, headers: { etag: '"v1"', 'last-modified': 'Tue, 03 Nov 2026 10:00:00 GMT' }, body });
function setup(options: ChannelOptions = {}, store = new Store(':memory:')) {
  const events: HubMessage[] = [];
  const channels = new Channels(store, (e) => events.push(e), options);
  return { store, events, channels };
}

test('channel tokens are scoped, hashed, rotated and never projected into normal state', () => {
  const { channels, store } = setup();
  const a = channels.create({ name: 'Bot A', source: 'push' });
  const b = channels.create({ name: 'Bot B', source: 'push' });
  assert.equal(channels.acceptsToken(a.channel.id, a.token!), true);
  assert.equal(channels.acceptsToken(b.channel.id, a.token!), false);
  assert.notEqual(store.channelRecord(a.channel.id)!.token_hash, a.token);
  assert.doesNotMatch(JSON.stringify(channels.list()), /token|hash/);
  const next = channels.rotateToken(a.channel.id);
  assert.equal(channels.acceptsToken(a.channel.id, a.token!), false);
  assert.equal(channels.acceptsToken(a.channel.id, next.token!), true);
  channels.update(a.channel.id, { enabled: false });
  assert.equal(channels.acceptsToken(a.channel.id, next.token!), false);
  assert.deepEqual(store.listTasks(), []);
  assert.deepEqual(store.listProjects(), []);
  assert.deepEqual(store.listFeed(), []);
});

test('ingestion is idempotent, edits keep receipt order and shared read state never moves backward', () => {
  const { channels, store, events } = setup();
  const { channel } = channels.create({ name: 'Bot', source: 'push' });
  assert.deepEqual(channels.ingest(channel.id, [entry('one'), entry('two')]), { created: 2, updated: 0, unchanged: 0 });
  const [two, one] = channels.entries(channel.id).entries;
  assert.equal(channels.read(channel.id, two.id).unread_count, 0);
  const otherClient = new Channels(store, (e) => events.push(e));
  assert.equal(otherClient.list()[0].read_through_id, two.id);
  assert.equal(otherClient.read(channel.id, one.id).read_through_id, two.id);
  const count = events.length;
  assert.deepEqual(channels.ingest(channel.id, entry('one')), { created: 0, updated: 0, unchanged: 1 });
  assert.equal(events.length, count);
  assert.deepEqual(channels.ingest(channel.id, entry('one', 'edited')), { created: 0, updated: 1, unchanged: 0 });
  const edited = channels.entries(channel.id).entries[1];
  assert.equal(edited.id, one.id);
  assert.equal(edited.received_at, one.received_at);
  assert.equal(channels.list()[0].unread_count, 0);
  channels.ingest(channel.id, { ...entry('late'), published_at: '2000-01-01T00:00:00Z' });
  assert.equal(channels.entries(channel.id).entries[0].external_id, 'late');
  assert.equal(channels.list()[0].unread_count, 1);
  assert.ok(events.some((e) => e.type === 'channel_entry'));
});

test('pagination and literal search cover old entries; large histories are not pruned', () => {
  const { channels, store } = setup();
  const { channel } = channels.create({ name: 'History', source: 'push' });
  store.ingestChannelEntries(channel.id, Array.from({ length: 2005 }, (_, i) => entry(String(i), i === 0 ? 'literal 100%_\\' : `body ${i}`)));
  const first = channels.entries(channel.id, 2);
  assert.equal(first.total, 2005);
  assert.equal(first.more, true);
  assert.deepEqual(first.entries.map((x) => x.external_id), ['2004', '2003']);
  const next = channels.entries(channel.id, 2, first.entries[1].id);
  assert.deepEqual(next.entries.map((x) => x.external_id), ['2002', '2001']);
  const found = channels.entries(channel.id, 10, undefined, '100%_\\');
  assert.equal(found.total, 1);
  assert.equal(found.entries[0].external_id, '0');
});

test('read markers and channel history survive reopening the hub database', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'desk-channel-db-')), 'hub.sqlite');
  const first = setup({}, new Store(path));
  const { channel } = first.channels.create({ name: 'Shared', source: 'push' });
  first.channels.ingest(channel.id, [entry('one'), entry('two')]);
  const newest = first.channels.entries(channel.id).entries[0].id;
  first.channels.read(channel.id, newest);
  const second = setup({}, new Store(path));
  assert.equal(second.channels.list()[0].read_through_id, newest);
  assert.equal(second.channels.list()[0].unread_count, 0);
  assert.equal(second.channels.entries(channel.id).total, 2);
});

test('invalid batches are rejected before writing, oversized bodies and unsafe links are rejected', () => {
  const { channels } = setup();
  const { channel } = channels.create({ name: 'Bot', source: 'push' });
  assert.throws(() => channels.ingest(channel.id, [entry('good'), { external_id: '', body: 'bad' }]));
  assert.equal(channels.entries(channel.id).total, 0);
  assert.throws(() => channels.ingest(channel.id, entry('huge', 'x'.repeat(MAX_ENTRY_BYTES + 1))));
  assert.throws(() => channels.ingest(channel.id, { ...entry('link'), url: 'file:///etc/passwd' }));
  assert.throws(() => channels.read(channel.id, -1));
  assert.throws(() => channels.read(channel.id, '1'));
});

test('RSS and Atom normalize CDATA/HTML, identity, dates, authors and safe relative links', () => {
  const rss = parseFeed(RSS, 'https://example.com/feed');
  assert.deepEqual(rss.map((x) => x.external_id), ['one', 'two']);
  assert.equal(rss[0].body, 'Older');
  assert.equal(rss[1].body, 'Hello & world');
  assert.equal(rss[1].published_at, '2026-11-03T10:00:00.000Z');
  const atom = parseFeed(ATOM, 'https://example.com/feed')[0];
  assert.equal(atom.external_id, 'urn:entry:1');
  assert.equal(atom.url, 'https://example.com/post');
  assert.equal(atom.author, 'Ada');
  assert.equal(atom.body, 'Hello & thanks');
  const literal = RSS.replace('Hello &amp; world', '2 &lt; 3 and 4 &gt; 1');
  assert.equal(parseFeed(literal, 'https://example.com/feed')[1].body, '2 < 3 and 4 > 1');
  const xhtmlTitle = ATOM.replace('<title>한글</title>', '<title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hi <b>there</b></div></title>');
  assert.equal(parseFeed(xhtmlTitle, 'https://example.com/feed')[0].title, 'Hi there');
  const textAtom = ATOM.replace('<title>한글</title>', '<title type="text">Use &lt;T&gt; generic</title>')
    .replace(/<content[^>]*>[\s\S]*?<\/content>/, '<content type="text">Use &lt;T&gt; and &lt;script&gt; as literal text</content>');
  const textEntry = parseFeed(textAtom, 'https://example.com/feed')[0];
  assert.equal(textEntry.title, 'Use <T> generic');
  assert.equal(textEntry.body, 'Use <T> and <script> as literal text');
  assert.equal(parseFeed(RSS.replace('<title>Second</title>', '<title>Use &lt;T&gt; generic</title>'), 'https://example.com/feed')[1].title, 'Use <T> generic');
  assert.equal(parseFeed(ATOM.replace('/post', 'javascript:alert(1)'), 'https://example.com/feed')[0].url, null);
  assert.throws(() => parseFeed('<rss><channel>', 'https://example.com/feed'));
  assert.throws(() => parseFeed('<!DOCTYPE x><rss><channel/></rss>', 'https://example.com/feed'));
  assert.throws(() => parseFeed('x'.repeat(MAX_FEED_BYTES + 1), 'https://example.com/feed'));
  const big = RSS.replace('Hello &amp; world', '한'.repeat(MAX_ENTRY_BYTES));
  assert.ok(Buffer.byteLength(parseFeed(big, 'https://example.com/feed')[1].body) <= MAX_ENTRY_BYTES);
});

test('feed collection uses validators, treats 304 as success, backs off failures and recovers', async () => {
  let current = Date.parse('2026-11-03T12:00:00Z'), call = 0;
  const { channels } = setup({ clock: () => current, pollMs: 1000, fetchFeed: async (_u, headers) => {
    call++;
    if (call === 1) return response();
    assert.equal(headers['if-none-match'], '"v1"');
    assert.equal(headers['if-modified-since'], 'Tue, 03 Nov 2026 10:00:00 GMT');
    if (call === 2) return { status: 304, headers: {}, body: '' };
    if (call === 3) throw new Error('network down');
    return response(ATOM);
  } });
  const { channel } = channels.create({ name: 'Feed', source: 'feed', feed_url: 'https://example.com/rss' });
  const first = await channels.refresh(channel.id);
  assert.equal(first.unread_count, 2);
  assert.equal(first.last_error, null);
  current += 1000;
  const second = await channels.refresh(channel.id);
  assert.equal(second.unread_count, 2);
  assert.equal(second.last_success_at, new Date(current).toISOString());
  current += 1000;
  const failed = await channels.refresh(channel.id);
  assert.equal(failed.last_error, 'network down');
  assert.equal(failed.last_success_at, second.last_success_at);
  assert.equal(failed.next_poll_at, new Date(current + 2000).toISOString());
  current += 2000;
  const recovered = await channels.refresh(channel.id);
  assert.equal(recovered.last_error, null);
  assert.equal(recovered.unread_count, 3);
});

test('collection failures preserve cached content and cap concurrency; pausing aborts without new entries', async () => {
  const pending: (() => void)[] = [];
  const { channels } = setup({ fetchFeed: (_u, _h, signal) => new Promise((resolve, reject) => {
    pending.push(() => resolve(response()));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const feeds = [0, 1, 2].map((i) => channels.create({ name: `Feed${i}`, source: 'feed', feed_url: `https://example.com/${i}` }).channel);
  const a = channels.refresh(feeds[0].id), b = channels.refresh(feeds[1].id);
  assert.equal(channels.refresh(feeds[0].id), a);
  assert.throws(() => channels.refresh(feeds[2].id));
  channels.update(feeds[0].id, { enabled: false });
  pending[1]();
  await Promise.all([a, b]);
  assert.equal(channels.entries(feeds[0].id).total, 0);
  assert.equal(channels.list().find((c) => c.id === feeds[0].id)!.last_error, null);
  assert.equal(channels.entries(feeds[1].id).total, 2);
});

test('a stalled fetch times out, records a failure and releases its collection slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { channels } = setup({ maxConcurrent: 1, fetchFeed: () => {
    calls++;
    return calls === 1 ? new Promise<FeedResponse>(() => {}) : Promise.resolve(response());
  } });
  const { channel } = channels.create({ name: 'Slow', source: 'feed', feed_url: 'https://example.com/feed' });
  const pending = channels.refresh(channel.id);
  t.mock.timers.tick(15_000);
  const failed = await pending;
  assert.match(failed.last_error!, /15초/);
  const recovered = await channels.refresh(channel.id);
  assert.equal(recovered.last_error, null);
  assert.equal(recovered.unread_count, 2);
});

test('only public HTTP(S) URLs and global IP addresses are accepted', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['file:///etc/passwd', 'http://localhost/feed', 'http://127.1/feed', 'https://192.168.1.1/feed', 'https://u:p@example.com/feed', 'http://[::1]/feed']) assert.throws(() => feedUrl(url), url);
});

test('HTTP producer route is isolated from management, including rotation and local ingress', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'desk-channel-http-'));
  const hub = new Hub(new Store(':memory:'), {
    skills: new SkillStore(join(directory, 'skills')),
    runner: () => ({ connected: false, id: null, engines: new Set(), has: () => false, handle: () => {} }),
  });
  let local = false;
  const access = { matches: () => false, isLocal: () => local,
    allowed: (req: { headers: Record<string, string> }) => local || req.headers.authorization === 'Bearer test-admin' } as unknown as Access;
  const server = createHttpServer(hub, access, directory);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); hub.channels.stop(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async (path: string, method = 'GET', token?: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const a = await request('/channels', 'POST', 'test-admin', { name: 'A', source: 'push' });
  const b = await request('/channels', 'POST', 'test-admin', { name: 'B', source: 'push' });
  assert.equal(a.status, 201);
  const id = a.body.channel.id, token = a.body.token;
  assert.equal((await request(`/channels/${id}/entries`, 'POST', token, entry('one'))).status, 200);
  assert.equal((await request(`/channels/${b.body.channel.id}/entries`, 'POST', token, entry('no'))).status, 401);
  for (const path of ['/state', '/channels', `/channels/${id}/entries`]) assert.equal((await request(path, 'GET', token)).status, 401, path);
  assert.equal((await request(`/channels/${id}/read`, 'POST', token, { through_id: 1 })).status, 401);
  assert.equal((await request(`/channels/${id}`, 'PATCH', token, { name: 'Hacked' })).status, 401);
  const page = await request(`/channels/${id}/entries?limit=1`, 'GET', 'test-admin');
  assert.equal(page.body.total, 1);
  assert.equal((await request(`/channels/${id}/read`, 'POST', 'test-admin', { through_id: page.body.entries[0].id })).body.unread_count, 0);
  const state = await request('/state', 'GET', 'test-admin');
  assert.equal(state.body.tasks.length, 0);
  assert.equal(state.body.channels[0].read_through_id, page.body.entries[0].id);
  assert.doesNotMatch(JSON.stringify(state.body), new RegExp(token));
  const rotated = await request(`/channels/${id}/token`, 'POST', 'test-admin', {});
  assert.equal((await request(`/channels/${id}/entries`, 'POST', token, entry('old-token'))).status, 401);
  local = true;
  assert.equal((await request('/channels')).status, 200); // Existing local management trust stays.
  assert.equal((await request(`/channels/${id}/entries`, 'POST', undefined, entry('local'))).status, 401);
  assert.equal((await request(`/channels/${id}/entries`, 'POST', rotated.body.token, entry('new-token'))).status, 200);
  assert.equal((await request(`/channels/${id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/channels/${id}/entries`, 'POST', rotated.body.token, entry('deleted'))).status, 401);
});
