import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './hub.ts';

/** Largest file a device may upload; it streams to disk, so this bounds the disk, not memory. */
export const MAX_UPLOAD = 200 * 1024 * 1024;
const TOO_BIG = `파일이 너무 큽니다 (최대 ${MAX_UPLOAD / 1024 / 1024} MiB)`;
/** How long a download from the web may take. */
const FETCH_TIMEOUT = 60_000;
const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'image/avif': '.avif', 'image/heic': '.heic', 'image/bmp': '.bmp', 'application/pdf': '.pdf',
};

/** A file name safe on disk: no directories, control or path characters, at most 120 characters. */
function safeName(raw: string): string {
  const name = basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f/:]/g, '_').replace(/^\.+/, '').trim();
  return (name || 'file').slice(-120);
}

/** Writes `source` to `dir/YYYY-MM-DD/<random>-<name>`, at most MAX_UPLOAD bytes; returns the path. */
async function store(source: AsyncIterable<Uint8Array>, dir: string, rawName: string, onTooBig?: () => void): Promise<string> {
  const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
  const folder = join(dir, day);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${randomBytes(4).toString('hex')}-${safeName(rawName)}`);
  let size = 0;
  try {
    await pipeline(source, async function* (chunks) {
      for await (const c of chunks) {
        size += (c as Uint8Array).length;
        if (size > MAX_UPLOAD) throw new HttpError(413, TOO_BIG);
        yield c;
      }
    }, createWriteStream(path, { flags: 'wx' }));
  } catch (err) {
    await unlink(path).catch(() => {});
    if (size > MAX_UPLOAD) onTooBig?.();
    throw err;
  }
  if (size === 0) {
    await unlink(path).catch(() => {});
    throw new HttpError(400, '빈 파일입니다');
  }
  return path;
}

/**
 * Saves a request body (the file's raw bytes) under the uploads dir and returns its path, for a
 * message to the agents. For devices without the files (a phone): files on the hub's machine are
 * passed by path as they are.
 */
export async function saveUpload(req: IncomingMessage, dir: string, rawName: string): Promise<string> {
  if (Number(req.headers['content-length']) > MAX_UPLOAD) throw new HttpError(413, TOO_BIG);
  try {
    return await store(req, dir, rawName, () => req.destroy());
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, '업로드가 중간에 끊겼습니다');
  }
}

/** Downloads a web file (an image dragged in from a web page) into the uploads dir; returns its path. */
export async function saveFromUrl(raw: unknown, dir: string): Promise<string> {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new HttpError(400, '올바른 URL이 아닙니다'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'http(s) 주소만 받을 수 있습니다');
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AgentDesk' } });
  } catch (err) {
    throw new HttpError(502, `내려받지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || !res.body) throw new HttpError(502, `내려받지 못했습니다: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_UPLOAD) throw new HttpError(413, TOO_BIG);
  // The name from the address, with an extension from the content type when it has none.
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let name = basename(url.pathname);
  try { name = decodeURIComponent(name); } catch { /* keep it encoded */ }
  name ||= 'download';
  if (!extname(name) && IMAGE_EXT[type]) name += IMAGE_EXT[type];
  try {
    return await store(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), dir, name);
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(502, '내려받는 중에 끊겼습니다');
  }
}
