// Read-only sources share ingestion and storage, never the agent task/session lifecycle.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Channel, ChannelEntryInput, ChannelInput, ChannelTokenReceipt, HubMessage } from '../../shared/api.ts';
import { Store, now } from './db.ts';
import { HttpError } from './errors.ts';

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 64 * 1024;
/** Entries a feed channel keeps, newest first; older ones are deleted as new ones arrive. */
export const MAX_FEED_KEPT = 1000;
export const MAX_FEED_ENTRIES = 2000;
const POLL_MS = 5 * 60_000, FETCH_MS = 15_000, MAX_CHANNELS = 100;
const CANCELLED = Symbol('channel collection cancelled');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Bounds the DNS lookup as well as request/body time, including injected fetchers in tests. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    work.then((value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); });
    if (signal.aborted) aborted();
  });
}

export interface FeedResponse { status: number; headers: Record<string, string | undefined>; body: string }
export type FeedFetcher = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<FeedResponse>;
export interface ChannelOptions {
  fetchFeed?: FeedFetcher;
  clock?: () => number;
  pollMs?: number;
  tickMs?: number;
  maxConcurrent?: number;
}

/** Public destinations only. Addresses are pinned below, including after every redirect. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Only global unicast; exclude documentation and address-transition ranges as well.
  const first = parseInt(address.split(':')[0], 16);
  return first >= 0x2000 && first < 0x4000 && !/^2001:(?:0*:|db8:)/.test(address) && !address.startsWith('2002:');
}

export function feedUrl(raw: unknown): URL {
  let u: URL;
  try { u = new URL(typeof raw === 'string' ? raw : ''); } catch { throw new HttpError(400, '올바른 피드 URL이 필요합니다'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.href.length > 4096)
    throw new HttpError(400, '인증정보 없는 공개 http(s) 피드 URL만 지원합니다');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host)))
    throw new HttpError(400, '내부망 피드 URL은 지원하지 않습니다');
  u.hash = '';
  return u;
}

/** Native HTTP avoids a second DNS lookup after validation (DNS rebinding). No cookies/credentials. */
export const fetchPublicFeed: FeedFetcher = async (raw, headers, signal) => {
  let url = feedUrl(raw);
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(lookup(hostname, { all: true }), signal);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new Error('공개 인터넷 주소의 피드만 수집할 수 있습니다');
    const pinned = addresses[0];
    const response = await new Promise<FeedResponse & { location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal, headers: { ...headers, 'user-agent': 'AgentDesk/1.0 (feed reader)', 'accept-encoding': 'identity' },
        lookup: (_name, opts, cb) => {
          if (typeof opts === 'object' && opts.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        },
      }, (res) => {
        const status = res.statusCode ?? 502;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume(); resolve({ status, headers: {}, body: '', location: res.headers.location }); return;
        }
        if (Number(res.headers['content-length']) > MAX_FEED_BYTES) { res.destroy(); reject(new Error('피드가 2 MiB를 넘습니다')); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('압축되지 않은 피드 응답이 필요합니다')); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_FEED_BYTES) { res.destroy(new Error('피드가 2 MiB를 넘습니다')); return; }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), headers: {
          etag: res.headers.etag, 'last-modified': res.headers['last-modified'],
        } }));
      });
      request.on('error', reject); request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (!response.location || redirect === 4) throw new Error('피드 리다이렉트가 올바르지 않거나 너무 많습니다');
    const next = feedUrl(new URL(response.location, url).href);
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS 피드를 HTTP로 리다이렉트할 수 없습니다');
    url = next;
  }
  throw new Error('피드를 가져오지 못했습니다');
};

function stringValue(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (v && typeof v === 'object') return stringValue((v as Record<string, unknown>)['#text']);
  return '';
}
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, entity: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? m;
      const n = parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
}
/**
 * Text read from one feed field at most: an entry keeps MAX_ENTRY_BYTES, and markup rarely more
 * than triples text, so the rest of a larger field could not reach the entry anyway.
 */
const MAX_FIELD_CHARS = 4 * MAX_ENTRY_BYTES;

// The helpers below scan forward once. Lazy regexes (`<!--[\s\S]*?-->` and the like) restart at every
// unclosed opener and read to the end of the text each time, which a hostile feed turns into minutes
// of blocked hub on a 2 MiB document.

/** CDATA sections unwrapped; an unclosed marker stays as text. */
function unwrapCdata(s: string): string {
  let out = '', i = 0;
  for (;;) {
    const open = s.indexOf('<![CDATA[', i);
    const close = open < 0 ? -1 : s.indexOf(']]>', open + 9);
    if (close < 0) return out + s.slice(i);
    out += s.slice(i, open) + s.slice(open + 9, close);
    i = close + 3;
  }
}

/** Tags that end a line of text. */
const LINE_END = new Set(['br', '/p', '/div', '/li', '/h1', '/h2', '/h3', '/h4', '/h5', '/h6']);

/**
 * HTML as text: script and style elements and comments dropped, line-ending tags as newlines, other
 * tags removed. Text that only looks like a tag (`a < b`, an unclosed `<!--`) stays.
 */
export function stripHtml(s: string): string {
  const lower = s.toLowerCase();
  let out = '', i = 0;
  // Once a search finds nothing, a later one from further on cannot either.
  let noGt = false, noCommentEnd = false;
  const noCloser = new Set<string>();
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    out += s.slice(i, lt);
    if (s.startsWith('<!--', lt)) {
      const end = noCommentEnd ? -1 : s.indexOf('-->', lt + 4);
      if (end >= 0) { i = end + 3; continue; }
      noCommentEnd = true;
      out += '<'; i = lt + 1; continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/i.exec(s.slice(lt, lt + 40));
    if (!m) { out += '<'; i = lt + 1; continue; }
    const gt = noGt ? -1 : s.indexOf('>', lt + m[0].length);
    // No `>` left: nothing further on can be a tag.
    if (gt < 0) { noGt = true; out += s.slice(lt); i = s.length; break; }
    const name = m[2].toLowerCase();
    if (!m[1] && (name === 'script' || name === 'style') && !noCloser.has(name)) {
      const closer = lower.indexOf(`</${name}`, gt + 1);
      const end = closer < 0 ? -1 : s.indexOf('>', closer);
      if (end >= 0) { i = end + 1; continue; }
      noCloser.add(name);
    }
    if (LINE_END.has(m[1] + name)) out += '\n';
    i = gt + 1;
  }
  return out + s.slice(i);
}

/** Trailing spaces off each line, at most one blank line in a row. */
function tidyLines(s: string): string {
  return s.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlText(v: unknown): string {
  const raw = stringValue(v).slice(0, MAX_FIELD_CHARS);
  // CDATA already contains HTML; encoded Atom/RSS content first needs its XML layer decoded.
  // Decode HTML entities only after removing tags, preserving literal comparisons such as &lt; 3.
  const text = raw.includes('<![CDATA[') ? unwrapCdata(raw) : decodeEntities(raw);
  return tidyLines(decodeEntities(stripHtml(text)));
}
function plainXmlText(v: unknown): string {
  const raw = stringValue(v).slice(0, MAX_FIELD_CHARS);
  return (raw.includes('<![CDATA[') ? unwrapCdata(raw) : decodeEntities(raw)).trim();
}
function atomText(v: unknown): string {
  const type = v && typeof v === 'object' ? (v as Record<string, unknown>)['@_type'] : undefined;
  return type === 'html' || type === 'xhtml' ? htmlText(v) : plainXmlText(v);
}
function externalLink(raw: unknown, base?: string): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'url은 문자열이어야 합니다');
  try {
    const u = new URL(raw, base);
    if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.href.length <= 4096) return u.href;
  } catch { /* rejected below */ }
  throw new HttpError(400, '원문 링크는 http(s) URL이어야 합니다');
}
const array = <T>(x: T | T[] | undefined): T[] => x == null ? [] : Array.isArray(x) ? x : [x];

/** RSS and Atom become the same entry input. Original HTML and XML are not retained. */
export function parseFeed(xml: string, base: string): ChannelEntryInput[] {
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error('피드가 2 MiB를 넘습니다');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('DTD 또는 사용자 정의 entity가 있는 피드는 지원하지 않습니다');
  if (XMLValidator.validate(xml) !== true) throw new Error('올바른 XML 피드가 아닙니다');
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false,
    parseAttributeValue: false, trimValues: true, htmlEntities: true,
    maxNestedTags: 64, stopNodes: ['*.title', '*.description', '*.encoded', '*.content', '*.summary'] });
  const document = parser.parse(xml);
  const atom = document.feed;
  const rss = document.rss?.channel ?? document.RDF;
  if (!atom && !rss) throw new Error('RSS 또는 Atom 피드가 아닙니다');
  const items: Record<string, any>[] = atom ? array(atom.entry) : array(rss.item);
  if (items.length > MAX_FEED_ENTRIES) items.length = MAX_FEED_ENTRIES;
  return items.map((item): ChannelEntryInput | null => {
    const atomLink = atom && array<Record<string, any>>(item.link).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate');
    let url: string | null = null;
    try { url = externalLink(atom ? atomLink?.['@_href'] : stringValue(item.link), base); } catch { /* unsafe link is omitted */ }
    const title = (atom ? atomText(item.title) : plainXmlText(item.title)).slice(0, 1000);
    const body = atom ? atomText(item.content ?? item.summary) : htmlText(item.encoded ?? item.description);
    const date = stringValue(item.pubDate ?? item.published ?? item.updated);
    const identity = stringValue(atom ? item.id : item.guid).trim() || url || hash(`${title}\n${date}\n${!title && !date ? body : ''}`);
    const rawDate = stringValue(item.published ?? item.pubDate ?? item.updated ?? item.date);
    const published = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
    const author = htmlText(atom ? item.author?.name ?? atom.author?.name : item.creator ?? item.author) || null;
    // An item with only a link (or an image) shows its link; one with nothing to show is skipped,
    // not left to fail the whole feed.
    const shown = title || (body ? '' : url ?? '');
    if (!shown && !body) return null;
    return { external_id: Buffer.byteLength(identity) > 2048 ? `sha256:${hash(identity)}` : identity, title: shown, body: truncateBytes(body || shown, MAX_ENTRY_BYTES), url,
      author: author?.slice(0, 500), published_at: published };
  }).filter((x): x is ChannelEntryInput => x !== null).reverse(); // Feed documents are usually newest first; receipt sequence stays oldest -> newest.
}

function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text).subarray(0, max - 3).toString('utf8').replace(/\uFFFD$/, '') + '…';
}
function boundedString(v: unknown, name: string, max: number, optional = false): string {
  if (v == null && optional) return '';
  if (typeof v !== 'string' || Buffer.byteLength(v) > max || (!optional && !v.trim())) throw new HttpError(400, `${name} 값이 없거나 너무 깁니다 (최대 ${max} 바이트)`);
  return v.trim();
}

export class Channels {
  private store: Store;
  private publish: (message: HubMessage) => void;
  private options: ChannelOptions;
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, { promise: Promise<Channel>; controller: AbortController }>();

  constructor(store: Store, publish: (message: HubMessage) => void, options: ChannelOptions = {}) {
    this.store = store; this.publish = publish; this.options = options;
  }
  private clock() { return (this.options.clock ?? Date.now)(); }
  private record(id: string) {
    const c = this.store.channelRecord(id);
    if (!c) throw new HttpError(404, '채널을 찾을 수 없습니다');
    return c;
  }
  private emit(id: string) {
    const channel = this.store.getChannel(id)!;
    this.publish({ type: 'channel', channel });
    return channel;
  }
  list() { return this.store.listChannels(); }
  create(input: ChannelInput): ChannelTokenReceipt {
    if (this.list().length >= MAX_CHANNELS) throw new HttpError(400, '채널은 최대 100개까지 만들 수 있습니다');
    const name = boundedString(input.name, 'name', 300);
    if (input.source !== 'push' && input.source !== 'feed') throw new HttpError(400, 'source는 push 또는 feed여야 합니다');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled는 boolean이어야 합니다');
    const url = input.source === 'feed' ? feedUrl(input.feed_url).href : null;
    const ts = now(), id = randomUUID(), token = input.source === 'push' ? randomBytes(32).toString('base64url') : null;
    this.store.createChannel({ id, name, source: input.source, feed_url: url, enabled: input.enabled === false ? 0 : 1,
      token_hash: token && hash(token), created_at: ts, updated_at: ts, last_checked_at: null,
      last_success_at: null, last_error: null, next_poll_at: url ? ts : null,
      etag: null, last_modified: null, failure_count: 0, read_through_id: 0 });
    const channel = this.emit(id);
    // Collected right away when a slot is free; else the next tick does it (next_poll_at is now).
    // refresh() throws synchronously when busy, which must not fail a channel already created.
    if (this.timer && channel.source === 'feed' && channel.enabled && this.active.size < (this.options.maxConcurrent ?? 2)) {
      try { void this.refresh(id).catch(() => {}); } catch { /* the tick retries */ }
    }
    return { channel, token };
  }
  update(id: string, input: { name?: string; enabled?: boolean; feed_url?: string }): Channel {
    const c = this.record(id), patch: Parameters<Store['updateChannel']>[1] = { updated_at: now() };
    if (input.name !== undefined) patch.name = boundedString(input.name, 'name', 300);
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled는 boolean이어야 합니다');
      patch.enabled = +input.enabled;
      if (input.enabled && !c.enabled && c.source === 'feed') patch.next_poll_at = now();
    }
    if (input.feed_url !== undefined) {
      if (c.source !== 'feed') throw new HttpError(400, 'push 채널은 피드 URL을 갖지 않습니다');
      patch.feed_url = feedUrl(input.feed_url).href;
      if (patch.feed_url !== c.feed_url) Object.assign(patch, { etag: null, last_modified: null, failure_count: 0,
        last_error: null, last_checked_at: null, last_success_at: null, next_poll_at: now() });
    }
    // Do not let a response for a replaced URL or paused subscription write later.
    if (patch.enabled === 0 || patch.feed_url !== undefined) this.active.get(id)?.controller.abort(CANCELLED);
    this.store.updateChannel(id, patch);
    return this.emit(id);
  }
  remove(id: string) {
    this.record(id); this.active.get(id)?.controller.abort(CANCELLED);
    this.store.deleteChannel(id); this.publish({ type: 'channel_removed', channel_id: id });
  }
  rotateToken(id: string): ChannelTokenReceipt {
    if (this.record(id).source !== 'push') throw new HttpError(400, 'push 채널만 입력 토큰을 발급할 수 있습니다');
    const token = randomBytes(32).toString('base64url');
    this.store.updateChannel(id, { token_hash: hash(token), updated_at: now() });
    return { channel: this.emit(id), token };
  }
  acceptsToken(id: string, token: string | undefined): boolean {
    const c = this.store.channelRecord(id);
    if (!c || c.source !== 'push' || !c.enabled || !c.token_hash || !token || token.length > 256) return false;
    const a = Buffer.from(c.token_hash), b = Buffer.from(hash(token));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  entries(id: string, limit = 60, before = Number.MAX_SAFE_INTEGER, q = '') {
    this.record(id);
    return this.store.channelEntries(id, limit, before, boundedString(q, 'q', 1000, true));
  }
  read(id: string, throughId: unknown) {
    const current = this.record(id);
    if (typeof throughId !== 'number' || !Number.isSafeInteger(throughId) || throughId < 0) throw new HttpError(400, 'through_id는 0 이상의 정수여야 합니다');
    this.store.readChannel(id, throughId);
    const channel = this.store.getChannel(id)!;
    if (channel.read_through_id === current.read_through_id) return channel;
    return this.emit(id);
  }
  ingest(id: string, raw: unknown, internal = false) {
    const c = this.record(id);
    if (!c.enabled) throw new HttpError(409, '일시 중지한 채널입니다');
    if (!internal && c.source !== 'push') throw new HttpError(400, '피드 채널에는 직접 입력할 수 없습니다');
    const batch = Array.isArray(raw) ? raw : [raw];
    if (!batch.length || batch.length > (internal ? MAX_FEED_ENTRIES : 100)) throw new HttpError(400, '한 번에 1~100개 항목을 입력할 수 있습니다');
    const inputs: ChannelEntryInput[] = batch.map((v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '항목은 JSON 객체여야 합니다');
      const external_id = boundedString(v.external_id, 'external_id', 2048), title = boundedString(v.title, 'title', 4000, true);
      const body = boundedString(v.body, 'body', MAX_ENTRY_BYTES, true);
      if (!title && !body) throw new HttpError(400, 'title 또는 body가 필요합니다');
      let published_at: string | null = null;
      if (v.published_at != null) {
        if (typeof v.published_at !== 'string' || !Number.isFinite(Date.parse(v.published_at))) throw new HttpError(400, 'published_at이 올바른 시각이 아닙니다');
        published_at = new Date(v.published_at).toISOString();
      }
      return { external_id, title, body, url: externalLink(v.url), author: boundedString(v.author, 'author', 2000, true) || null, published_at };
    });
    const { receipt, changed } = this.store.ingestChannelEntries(id, inputs);
    for (const entry of changed) this.publish({ type: 'channel_entry', entry });
    if (changed.length) this.emit(id);
    return receipt;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 30_000); this.timer.unref(); this.tick();
  }
  stop() {
    clearInterval(this.timer); this.timer = undefined;
    for (const { controller } of this.active.values()) controller.abort(CANCELLED);
  }
  private tick() {
    for (const channel of this.list()) {
      if (this.active.size >= (this.options.maxConcurrent ?? 2)) break;
      if (channel.source === 'feed' && channel.enabled && (!channel.next_poll_at || Date.parse(channel.next_poll_at) <= this.clock()))
        try { void this.refresh(channel.id).catch(() => {}); } catch { /* retried on a later tick */ }
    }
  }
  refresh(id: string): Promise<Channel> {
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    const c = this.record(id);
    if (c.source !== 'feed' || !c.feed_url) throw new HttpError(400, '피드 채널만 새로고침할 수 있습니다');
    if (!c.enabled) throw new HttpError(409, '일시 중지한 채널입니다');
    if (this.active.size >= (this.options.maxConcurrent ?? 2)) throw new HttpError(409, '다른 피드를 수집 중입니다. 잠시 후 다시 시도하세요');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('피드 수집 시간(15초)을 초과했습니다')), FETCH_MS); timer.unref();
    const promise = this.collect(id, controller.signal).finally(() => { clearTimeout(timer); this.active.delete(id); });
    this.active.set(id, { promise, controller });
    return promise;
  }
  private async collect(id: string, signal: AbortSignal): Promise<Channel> {
    const c = this.record(id), headers: Record<string, string> = { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' };
    if (c.etag) headers['if-none-match'] = c.etag;
    if (c.last_modified) headers['if-modified-since'] = c.last_modified;
    const ts = new Date(this.clock()).toISOString();
    try {
      const response = await abortable((this.options.fetchFeed ?? fetchPublicFeed)(c.feed_url!, headers, signal), signal);
      signal.throwIfAborted();
      const latest = this.record(id);
      if (latest.feed_url !== c.feed_url || !latest.enabled) return this.store.getChannel(id)!;
      if (response.status !== 304) {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        // Only the newest MAX_FEED_KEPT: older items of a long feed would come back as new after being
        // deleted, every poll.
        const inputs = parseFeed(response.body, c.feed_url!).slice(-MAX_FEED_KEPT);
        if (inputs.length) {
          this.ingest(id, inputs, true);
          if (this.store.pruneChannelEntries(id, MAX_FEED_KEPT)) this.emit(id);
        }
      }
      this.store.updateChannel(id, { last_checked_at: ts, last_success_at: ts, last_error: null, failure_count: 0,
        next_poll_at: new Date(this.clock() + (this.options.pollMs ?? POLL_MS)).toISOString(),
        etag: response.headers.etag?.slice(0, 1000) ?? (response.status === 304 ? c.etag : null),
        last_modified: response.headers['last-modified']?.slice(0, 1000) ?? (response.status === 304 ? c.last_modified : null) });
    } catch (error) {
      const latest = this.store.channelRecord(id);
      if (!latest) throw new HttpError(404, '채널이 삭제되었습니다');
      if (signal.reason === CANCELLED || latest.feed_url !== c.feed_url || !latest.enabled) return this.store.getChannel(id)!;
      const failures = Math.min(c.failure_count + 1, 16);
      const failure = signal.aborted ? signal.reason : error;
      this.store.updateChannel(id, { last_checked_at: ts, last_error: truncateBytes(failure instanceof Error ? failure.message : '피드를 수집하지 못했습니다', 1000),
        failure_count: failures, next_poll_at: new Date(this.clock() + Math.min((this.options.pollMs ?? POLL_MS) * 2 ** failures, 6 * 60 * 60_000)).toISOString() });
    }
    return this.emit(id);
  }
}
