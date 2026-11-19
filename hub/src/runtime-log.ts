import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, renameSync } from 'node:fs';

const ROTATE_BYTES = 8 * 1024 * 1024;
const HISTORY = 3;

function logStat(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())) throw new Error('운영 로그 경로의 소유권이나 형식을 확인하세요');
  return stat;
}

/** Rotate before opening a new writer; an existing process keeps writing to its original inode. */
export function openRuntimeLog(path: string): number {
  if ((logStat(path)?.size ?? 0) >= ROTATE_BYTES) {
    for (let n = HISTORY; n > 0; n--) {
      const previous = n === 1 ? path : `${path}.${n - 1}`;
      logStat(`${path}.${n}`);
      if (logStat(previous)) {
        const old = openSync(previous, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { fchmodSync(old, 0o600); } finally { closeSync(old); }
        renameSync(previous, `${path}.${n}`);
      }
    }
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('운영 로그를 안전하게 열 수 없습니다');
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('운영 로그 경로가 필요합니다');
  closeSync(openRuntimeLog(process.argv[2]));
}
