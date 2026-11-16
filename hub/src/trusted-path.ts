import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

/** Resolve missing leaves, but never mistake a broken symlink or an I/O error for absence. */
export function destinationPath(path: string): string {
  path = resolve(path);
  let parent = path;
  for (;;) {
    try { return resolve(realpathSync(parent), relative(parent, path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (lstatSync(parent, {throwIfNoEntry: false})?.isSymbolicLink()) throw new Error('저장 경로의 심볼릭 링크 대상이 없습니다');
      const next = dirname(parent); if (next === parent) throw error; parent = next;
    }
  }
}

/** A trusted ancestor cannot be replaced by another UID. Sticky system temp roots are safe. */
export function assertTrustedPath(path: string, options: {kind?: 'file' | 'directory' | 'socket'; private?: boolean; allowMissing?: boolean} = {}): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('경로 소유 UID를 확인할 수 없습니다');
  const check = (target: string, leaf: boolean): void => {
    const absolute = resolve(target), root = parse(absolute).root;
    const parts = relative(root, absolute).split('/').filter(Boolean);
    let current = root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]);
      const final = leaf && index === parts.length - 1;
      const stat = lstatSync(current, {throwIfNoEntry: false});
      if (!stat) {
        if (options.allowMissing) return;
        throw new Error(`검증할 경로가 없습니다: ${current}`);
      }
      if (stat.uid !== uid && (final || stat.uid !== 0)) throw new Error(`경로 소유 UID가 신뢰되지 않습니다: ${current}`);
      if (stat.isSymbolicLink()) {
        if (final) throw new Error(`보호 경로는 심볼릭 링크일 수 없습니다: ${current}`);
        check(realpathSync(current), false);
        continue;
      }
      const stickyAncestor = !final && stat.isDirectory() && !!(stat.mode & 0o1000);
      if ((stat.mode & 0o022) && !stickyAncestor) throw new Error(`경로에 비신뢰 쓰기 권한이 있습니다: ${current}`);
      if (!final && !stat.isDirectory()) throw new Error(`상위 경로가 디렉터리가 아닙니다: ${current}`);
      if (final && ((options.private && (stat.mode & 0o077))
        || (options.kind === 'file' && !stat.isFile()) || (options.kind === 'directory' && !stat.isDirectory())
        || (options.kind === 'socket' && !stat.isSocket()))) throw new Error(`보호 경로의 형식 또는 소유자 전용 권한이 잘못되었습니다: ${current}`);
    }
  };
  check(path, true);
}

/** Code and Git metadata include transitive imports/configuration, not just the entry point. */
export function assertTrustedTree(path: string): void {
  assertTrustedPath(path, {kind: 'directory'});
  const root = realpathSync(path), uid = process.getuid!();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const entry = join(directory, name), stat = lstatSync(entry);
      if (stat.uid !== uid) throw new Error(`경로 소유 UID가 신뢰되지 않습니다: ${entry}`);
      if (stat.isSymbolicLink()) {
        const declared = resolve(dirname(entry), readlinkSync(entry));
        const outside = (target: string) => { const rel = relative(root, target); return rel === '..' || rel.startsWith('../') || isAbsolute(rel); };
        if (outside(realpathSync(entry)))
          throw new Error(`실행 코드의 심볼릭 링크가 검증 경로 밖을 가리킵니다: ${entry}`);
        // macOS /var -> /private/var aliases may still identify this tree. Verify the
        // lexical route as well so an untrusted external alias cannot be swapped later.
        if (outside(declared)) assertTrustedPath(declared);
      } else {
        if (stat.mode & 0o022) throw new Error(`경로에 비신뢰 쓰기 권한이 있습니다: ${entry}`);
        if (stat.isDirectory()) visit(entry);
        else if (!stat.isFile()) throw new Error(`실행 코드 경로가 일반 파일이 아닙니다: ${entry}`);
      }
    }
  };
  visit(root);
}
