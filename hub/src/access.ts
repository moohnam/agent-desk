import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import type { IncomingMessage } from 'node:http';
import QRCode from 'qrcode';

const COOKIE = 'desk_token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Who may use the hub. On the Mac itself (loopback, addressed as localhost) no token is needed;
 * other devices on the network present the access token, once through the QR link (`?token=`),
 * then as a cookie. The token is kept in a file beside the database; delete it to issue a new one.
 */
export class Access {
  readonly token: string;
  readonly port: number;

  constructor(tokenFile: string, port: number) {
    this.port = port;
    let token = '';
    try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { /* first start */ }
    if (!token) {
      token = randomBytes(24).toString('base64url');
      writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    }
    this.token = token;
  }

  /**
   * On this machine: a loopback connection addressed by a loopback name. The Host check keeps a
   * web page that rebinds its own domain to 127.0.0.1 from passing as local.
   */
  isLocal(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    return LOOPBACK.has(req.socket.remoteAddress ?? '') && LOCAL_HOSTS.has(host);
  }

  matches(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Local, or carrying the token as a cookie or a bearer header (MCP clients). */
  allowed(req: IncomingMessage): boolean {
    if (this.isLocal(req)) return true;
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return this.matches(bearer) || this.matches(cookieOf(req, COOKIE));
  }

  /** Remembers the device for a year; Lax so the first visit, a navigation from the camera app, keeps it. */
  cookie(): string {
    return `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
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
