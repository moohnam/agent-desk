import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import QRCode from 'qrcode';
import type { AccessDevice, AccessRequest, AccessView } from '../../shared/api.ts';

const COOKIE = 'desk_token';
const DEVICE_COOKIE = 'desk_device';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const YEAR_S = 31536000;
/** A request not answered within this long is dropped; the device asks again. */
const REQUEST_TTL_MS = 10 * 60_000;
/** At most this many requests wait at once, and this many from one address. */
const MAX_REQUESTS = 10, MAX_REQUESTS_PER_IP = 2;
/** How often a device's last-seen time is written down. */
const SEEN_EVERY_MS = 60_000;

interface Device { id: string; name: string; hash: string; created_at: string; last_seen_at: string | null; last_ip: string | null }
interface Pending extends AccessRequest { secret: string; at: number; status: 'pending' | 'allowed' | 'denied'; token?: string; deviceId?: string }
interface Connection { ip: string; since: string; close: () => void }

/** Who a request comes from: this Mac, a device given its own token, or the shared token. */
export type Client = { kind: 'local' } | { kind: 'device'; device: Device } | { kind: 'shared'; via: 'cookie' | 'bearer' };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
export const ipOf = (req: IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/** "Windows Chrome", "iPhone Safari": a first name for a device, from its browser. */
export function deviceName(ua = ''): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기기';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} ${browser}` : os;
}

/** A name as a device gave it: one line, short, without control or direction-changing characters. */
const cleanName = (name: unknown, ua?: string) =>
  (typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').trim().slice(0, 60) : '') || deviceName(ua);

/**
 * Who may use the hub. On the Mac itself (loopback, addressed as localhost) no token is needed.
 * Other devices each hold a token of their own (a cookie), given when the Mac allows the device's
 * request or the device opens the QR link, and taken back one device at a time. The shared token
 * (a file beside the database) is for the QR link and MCP clients; a browser that still carries it
 * as a cookie is moved to a token of its own on its next page load.
 */
export class Access {
  token: string;
  readonly port: number;
  private readonly tokenFile: string;
  private readonly extraHosts: Set<string>;
  /** Called when requests, devices or connections change. */
  onChange: () => void = () => {};
  private readonly devicesFile: string;
  private devices = new Map<string, Device>();
  private requests = new Map<string, Pending>();
  private connections = new Map<string, Set<Connection>>();

  constructor(tokenFile: string, port: number, devicesFile = join(dirname(tokenFile), 'devices.json'), extraHosts: string[] = []) {
    this.port = port;
    this.tokenFile = tokenFile;
    this.extraHosts = new Set(extraHosts);
    let token = '';
    try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { /* first start */ }
    if (!token) {
      token = randomBytes(24).toString('base64url');
      writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    }
    this.token = token;
    this.devicesFile = devicesFile;
    try {
      for (const d of JSON.parse(readFileSync(devicesFile, 'utf8')) as Device[]) this.devices.set(d.id, d);
    } catch { /* none yet */ }
  }

  /**
   * On this machine: a loopback connection addressed by a loopback name. The Host check keeps a
   * web page that rebinds its own domain to 127.0.0.1 from passing as local.
   */
  isLocal(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    return LOOPBACK.has(req.socket.remoteAddress ?? '') && LOCAL_HOSTS.has(host);
  }

  /**
   * A request from another device names this Mac as it knows itself: one of its IPv4 addresses or
   * `<name>.local` (or a configured host), at the hub's port. A page that rebinds its own domain
   * to the hub fails this, so its requests never reach a device's cookie or the request page.
   */
  hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const m = host.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) return false;
    const [, name, port] = m;
    // A configured name may come through a proxy on another port (tailscale serve on 443).
    if (this.extraHosts.has(host) || this.extraHosts.has(name)) return true;
    if (port !== undefined && Number(port) !== this.port) return false;
    if (LOCAL_HOSTS.has(name) || name === `${hostname().replace(/\.local$/, '').toLowerCase()}.local`) return true;
    return Object.values(networkInterfaces()).flat().some((a) => a?.family === 'IPv4' && a.address === name);
  }

  /** A new shared token (the QR link's): devices that knew the old one, cut off or not, can't come back with it. */
  rotateToken() {
    this.token = randomBytes(24).toString('base64url');
    writeFileSync(this.tokenFile, this.token + '\n', { mode: 0o600 });
    this.onChange();
  }

  matches(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The device a `desk_device` cookie (`id.secret`) belongs to. */
  private deviceOf(cookie: string | undefined): Device | undefined {
    const [id, secret] = (cookie ?? '').split('.');
    const d = id && secret ? this.devices.get(id) : undefined;
    if (!d) return undefined;
    const a = Buffer.from(sha(secret)), b = Buffer.from(d.hash);
    return a.length === b.length && timingSafeEqual(a, b) ? d : undefined;
  }

  /** Who sent the request, or null when it may not use the hub. */
  identify(req: IncomingMessage): Client | null {
    if (this.isLocal(req)) return { kind: 'local' };
    const device = this.deviceOf(cookieOf(req, DEVICE_COOKIE));
    if (device) { this.seen(device, ipOf(req)); return { kind: 'device', device }; }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (this.matches(bearer)) return { kind: 'shared', via: 'bearer' };
    if (this.matches(cookieOf(req, COOKIE))) return { kind: 'shared', via: 'cookie' };
    return null;
  }

  allowed(req: IncomingMessage): boolean { return this.identify(req) !== null; }

  private seen(d: Device, ip: string) {
    if (d.last_ip === ip && d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < SEEN_EVERY_MS) return;
    d.last_seen_at = now();
    d.last_ip = ip;
    this.save();
  }

  /** Writes the device list (a whole new file, then a rename); a failed write is logged, not fatal. */
  private save() {
    try {
      const tmp = `${this.devicesFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 1) + '\n', { mode: 0o600 });
      renameSync(tmp, this.devicesFile);
    } catch (e) {
      console.error(`기기 목록을 저장하지 못했습니다 (${this.devicesFile}): ${e instanceof Error ? e.message : e}`);
    }
    this.onChange();
  }

  /** A new device with a token of its own; the cookies that hand it over (and drop the shared one). */
  addDevice(name: string, ip: string): string[] { return this.newDevice(name, ip).cookies; }

  private newDevice(name: string, ip: string): { id: string; cookies: string[] } {
    const id = randomUUID().slice(0, 8), secret = randomBytes(24).toString('base64url');
    this.devices.set(id, { id, name, hash: sha(secret), created_at: now(), last_seen_at: now(), last_ip: ip });
    this.save();
    return { id, cookies: this.deviceCookies(`${id}.${secret}`) };
  }

  private deviceCookies(value: string): string[] {
    return [`${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}`, `${COOKIE}=; Path=/; Max-Age=0`];
  }

  renameDevice(id: string, name: unknown): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    const clean = typeof name === 'string' ? cleanName(name) : '';
    if (clean && typeof name === 'string' && name.trim()) d.name = clean;
    this.save();
    return true;
  }

  /** Takes a device's token back and closes its open connections. */
  removeDevice(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    for (const c of this.connections.get(id) ?? []) c.close();
    this.connections.delete(id);
    this.save();
    return true;
  }

  /** Counts a live connection (the event stream) of a device; returns the call that ends it. */
  connect(deviceId: string, ip: string, close: () => void): () => void {
    const c: Connection = { ip, since: now(), close };
    const set = this.connections.get(deviceId) ?? new Set();
    set.add(c);
    this.connections.set(deviceId, set);
    this.onChange();
    return () => {
      if (!set.delete(c)) return;
      if (!set.size && this.connections.get(deviceId) === set) this.connections.delete(deviceId);
      this.onChange();
    };
  }

  /** Drops requests past their time; a device allowed but never collected is removed with its request. */
  private prune() {
    for (const [id, r] of this.requests) {
      if (Date.now() - r.at <= REQUEST_TTL_MS) continue;
      this.requests.delete(id);
      if (r.deviceId) this.removeDevice(r.deviceId);
    }
  }

  /** A device without a token asks to be let in; null when too many are waiting. */
  request(name: unknown, req: IncomingMessage): { id: string; secret: string; code: string } | null {
    this.prune();
    const ip = ipOf(req);
    const waiting = [...this.requests.values()].filter((r) => r.status === 'pending');
    if (waiting.length >= MAX_REQUESTS || waiting.filter((r) => r.ip === ip).length >= MAX_REQUESTS_PER_IP) return null;
    const r: Pending = {
      id: randomUUID().slice(0, 8), secret: randomBytes(24).toString('base64url'), code: String(randomInt(0, 10000)).padStart(4, '0'),
      name: cleanName(name, req.headers['user-agent']), ip, created_at: now(), at: Date.now(), status: 'pending',
    };
    this.requests.set(r.id, r);
    this.onChange();
    // Its card leaves the Mac's screen when it expires unanswered.
    setTimeout(() => { if (this.requests.get(r.id)?.status === 'pending') { this.prune(); this.onChange(); } }, REQUEST_TTL_MS + 1000).unref();
    return { id: r.id, secret: r.secret, code: r.code };
  }

  /** The Mac's answer to a request. */
  answer(id: string, allow: boolean): boolean {
    this.prune();
    const r = this.requests.get(id);
    if (!r || r.status !== 'pending') return false;
    r.status = allow ? 'allowed' : 'denied';
    // The cookies wait for the device to come for them (its next poll); the device list shows it now.
    if (allow) {
      const made = this.newDevice(r.name, r.ip);
      r.token = made.cookies.join('\n');
      r.deviceId = made.id;
      // The device has its full time from now to come for its token.
      r.at = Date.now();
    } else this.onChange();
    return true;
  }

  /** What became of a request, asked by the device that sent it; an allowed one hands over its cookies once. */
  status(id: unknown, secret: unknown): { status: 'pending' | 'allowed' | 'denied' | 'expired'; cookies?: string[] } {
    this.prune();
    const r = typeof id === 'string' ? this.requests.get(id) : undefined;
    if (!r || typeof secret !== 'string' || sha(secret) !== sha(r.secret)) return { status: 'expired' };
    if (r.status === 'pending') return { status: 'pending' };
    this.requests.delete(r.id);
    return r.status === 'allowed' ? { status: 'allowed', cookies: r.token!.split('\n') } : { status: 'denied' };
  }

  /** Requests waiting for an answer and the devices let in, for the Mac's screen. */
  view(): AccessView {
    this.prune();
    const requests: AccessRequest[] = [...this.requests.values()].filter((r) => r.status === 'pending')
      .map(({ id, name, ip, code, created_at }) => ({ id, name, ip, code, created_at }));
    const devices: AccessDevice[] = [...this.devices.values()].map(({ id, name, created_at, last_seen_at, last_ip }) => ({
      id, name, created_at, last_seen_at, last_ip, connections: this.connections.get(id)?.size ?? 0,
    }));
    return { requests, devices };
  }

  /** Addresses other devices can use: each LAN IPv4 address, then the mDNS name (some Android phones can't resolve it). */
  urls(): string[] {
    const ips = Object.values(networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a!.address);
    const name = hostname().replace(/\.local$/, '');
    return [...ips, `${name}.local`].map((h) => `http://${h}:${this.port}/?token=${this.token}`);
  }

  async qrSvg(url: string): Promise<string> {
    return QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  async qrTerminal(url: string): Promise<string> {
    return QRCode.toString(url, { type: 'terminal', small: true });
  }
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}
