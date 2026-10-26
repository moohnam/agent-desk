import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, resolve } from 'node:path';
import { HttpError } from './hub.ts';

/** URL schemes handed to the app registered for them (AKB documents open in Lectern). */
const APP_SCHEMES = /^(akb|lectern):/i;
/** Opening these would run them; they are revealed in Finder instead. */
const RUNNABLE = new Set(['.app', '.command', '.tool', '.terminal', '.sh', '.zsh', '.bash', '.pkg', '.mpkg', '.dmg',
  '.workflow', '.scpt', '.scptd', '.applescript', '.jar', '.webloc', '.inetloc', '.fileloc']);

export type LinkTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string; reveal: boolean };

/**
 * What a link in an agent's reply points at: an app URL, or a local file. File links may be
 * `file://` URLs, absolute, `~/`, or relative to the task's working directory, and may carry a
 * line suffix (`:12`, `:12:3`, `#L12`), which is dropped since the default app is used.
 */
export function linkTarget(href: string, cwd: string | undefined): LinkTarget {
  if (APP_SCHEMES.test(href)) return { kind: 'url', url: href };
  let path: string;
  try { path = /^file:/i.test(href) ? new URL(href).pathname : href; path = decodeURIComponent(path); }
  catch { throw new HttpError(400, `열 수 없는 링크입니다: ${href}`); }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new HttpError(400, `열 수 없는 링크입니다: ${href}`);
  path = path.replace(/#L\d+(-L?\d+)?$/, '').replace(/:\d+(:\d+)?(-\d+)?$/, '');
  path = path.replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(path)) {
    if (!cwd) throw new HttpError(400, `상대 경로의 기준 폴더를 알 수 없습니다: ${href}`);
    path = resolve(cwd, path);
  }
  let st;
  try { st = statSync(path); } catch { throw new HttpError(404, `파일이 없습니다: ${path}`); }
  const runnable = RUNNABLE.has(extname(path).toLowerCase()) || (st.isFile() && (st.mode & 0o111) !== 0);
  return { kind: 'file', path, reveal: runnable };
}

/** Opens the target with macOS `open`: the default app, or Finder for runnable files. */
export function openTarget(t: LinkTarget): Promise<void> {
  const args = t.kind === 'url' ? [t.url] : t.reveal ? ['-R', t.path] : [t.path];
  return new Promise((ok, fail) => execFile('open', args, (err, _out, stderr) =>
    err ? fail(new HttpError(500, `열지 못했습니다: ${stderr.trim() || err.message}`)) : ok()));
}

/** Only the desk's own pages may open things: no Origin (curl), or one on this machine. */
export function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); }
  catch { return false; }
}
