import { constants } from 'node:fs';
import { lstat, mkdtemp, open, opendir, realpath, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import type { Hub } from './hub.ts';
import { remoteLocation } from '../../shared/remote.ts';
import { expandHome } from './paths.ts';
import { HttpError } from './errors.ts';
import { linkTarget, type LinkTarget } from './open.ts';

export const SHARED_FILE_LIMIT = 50 * 1024 * 1024;
const CACHE_LIMIT = 250 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); };

/** Only task files and temporary artifacts, never arbitrary paths outside those roots. */
export async function workspaceFile(hub: Hub, taskId: string, href: string, base?: string) {
  const cwd = hub.cwdOf(taskId);
  if (!cwd) throw new HttpError(404, '파일의 작업을 찾을 수 없습니다');
  const root = await realpath(expandHome(remoteLocation(cwd)?.path ?? cwd));
  const target = linkTarget(href, root);
  if (target.kind !== 'file') throw new HttpError(400, '파일 링크가 필요합니다');
  const path = await realpath(target.path), temp = await realpath(tmpdir());
  if (!inside(root, path) && !inside(temp, path)) throw new HttpError(403, '프로젝트 또는 임시 폴더에 있는 파일만 가져올 수 있습니다');
  if (base) {
    const document = linkTarget(base, root);
    if (document.kind !== 'file') throw new HttpError(400, '문서 경로가 필요합니다');
    const directory = dirname(await realpath(document.path));
    if (!inside(directory, path)) throw new HttpError(403, '문서 폴더 안의 부속 파일만 볼 수 있습니다');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HttpError(400, '일반 파일만 가져올 수 있습니다');
    if (stat.size > SHARED_FILE_LIMIT) throw new HttpError(413, '파일은 50 MB까지 가져올 수 있습니다');
    return { file, stat, target };
  } catch (error) { await file.close(); throw error; }
}

export async function sendWorkspaceFile(hub: Hub, taskId: string, href: string, res: ServerResponse, base?: string) {
  const { file, stat, target } = await workspaceFile(hub, taskId, href, base);
  try {
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'content-length': stat.size,
      'x-desk-filename': encodeURIComponent(basename(target.path)),
      'x-desk-reveal': target.reveal || (stat.mode & 0o111) !== 0 ? '1' : '0',
    });
    if (stat.size === 0) res.end();
    else await pipeline(file.createReadStream({ autoClose: true, end: stat.size - 1 }), res);
  } finally { await file.close().catch(() => {}); }
}

/** Private, bounded temporary copies. No shell interpolation and no persistent project artifacts. */
export class TemporaryFiles {
  private entries: { dir: string; path: string; size: number; at: number }[] = [];
  private active = false;
  private stopped = false;
  private current?: Promise<LinkTarget>;
  private expiring: Promise<void> = Promise.resolve();
  private readonly baseDir: string;
  private readonly options: { managed?: boolean; maxBytes?: number; maxFiles?: number };
  private timer = setInterval(() => { if (!this.active) void this.expire().catch(() => {}); }, 60_000);
  constructor(baseDir = tmpdir(), options: { managed?: boolean; maxBytes?: number; maxFiles?: number } = {}) {
    this.baseDir = baseDir; this.options = options; this.timer.unref();
  }
  private get prefix() { return this.options.managed ? 'agent-desk-preview-' : 'agent-desk-file-'; }
  canReceive(size: number) {
    return this.entries.length < (this.options.maxFiles ?? 100)
      && this.entries.reduce((sum, e) => sum + e.size, size) <= (this.options.maxBytes ?? CACHE_LIMIT);
  }
  private expire(all = false) {
    const run = this.expiring.then(async () => {
      for (const entry of [...this.entries]) {
        if (all || (!this.options.managed && Date.now() - entry.at >= TTL)) {
          await rm(entry.dir, { recursive: true, force: true });
          this.entries = this.entries.filter(e => e !== entry);
        } else if (this.options.managed) {
          // The document owner decides expiry. Keep live copies distinct from crash leftovers.
          const now = new Date();
          try { await utimes(entry.dir, now, now); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.entries = this.entries.filter(e => e !== entry);
          }
        }
      }
      // Recover old copies after a crash without touching another hub's fresh files.
      const directory = await opendir(this.baseDir);
      for await (const item of directory) {
        if (!item.name.startsWith(this.prefix) || !/^[A-Za-z0-9]{6}$/.test(item.name.slice(this.prefix.length))) continue;
        const path = join(this.baseDir, item.name);
        if (this.entries.some(e => e.dir === path)) continue;
        try {
          const stat = await lstat(path);
          if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
            && Date.now() - stat.mtimeMs >= TTL) await rm(path, { recursive: true, force: true });
        } catch { /* Another process may have removed or changed the entry. */ }
      }
    });
    this.expiring = run.catch(() => {});
    return run;
  }
  async receive(response: Response): Promise<LinkTarget> {
    if (this.active) throw new HttpError(429, '다른 파일을 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요');
    const pending = this.receiveNow(response);
    this.current = pending;
    try { return await pending; }
    finally { if (this.current === pending) this.current = undefined; }
  }
  private async receiveNow(response: Response): Promise<LinkTarget> {
    if (this.stopped) throw new HttpError(503, '허브가 종료 중입니다');
    if (this.active) throw new HttpError(429, '다른 파일을 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요');
    this.active = true;
    let dir: string | undefined;
    try {
      await this.expire();
      let name: string;
      try { name = decodeURIComponent(response.headers.get('x-desk-filename') ?? ''); }
      catch { throw new HttpError(502, '러너가 잘못된 파일 이름을 보냈습니다'); }
      if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name) || name.length > 240) throw new HttpError(502, '러너가 잘못된 파일 이름을 보냈습니다');
      const raw = response.headers.get('content-length'), size = Number(raw);
      if (raw === null || !Number.isSafeInteger(size) || size < 0 || size > SHARED_FILE_LIMIT) throw new HttpError(413, '파일은 50 MB까지 가져올 수 있습니다');
      if (!this.canReceive(size)) throw new HttpError(413, '임시 파일 보관 한도에 도달했습니다');
      if (!response.body) throw new HttpError(502, '파일 본문이 없습니다');
      dir = await mkdtemp(join(this.baseDir, this.prefix));
      const path = join(dir, name), file = await open(path, 'wx', 0o600);
      let received = 0;
      try {
        await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, done) {
          received += chunk.length;
          done(received > size ? new HttpError(502, '파일 크기가 달라졌습니다') : null, chunk);
        } }), file.createWriteStream({ autoClose: true }));
      } finally { await file.close().catch(() => {}); }
      if (received !== size) throw new HttpError(502, '파일을 끝까지 받지 못했습니다');
      if (this.stopped) throw new HttpError(503, '허브가 종료 중입니다');
      const target = linkTarget(path, undefined);
      if (target.kind === 'file' && response.headers.get('x-desk-reveal') === '1') target.reveal = true;
      this.entries.push({ dir, path, size, at: Date.now() }); dir = undefined;
      return target;
    } finally {
      try { if (dir) await rm(dir, { recursive: true, force: true }); }
      finally { this.active = false; }
    }
  }
  async discard(path: string) {
    const run = this.expiring.then(async () => {
      const entry = this.entries.find(e => e.path === path);
      if (!entry) return;
      await rm(entry.dir, { recursive: true, force: true });
      this.entries = this.entries.filter(e => e !== entry);
    });
    this.expiring = run.catch(() => {});
    await run;
  }
  async close() { this.stopped = true; clearInterval(this.timer); await this.current?.catch(() => {}); await this.expire(true); }
}
