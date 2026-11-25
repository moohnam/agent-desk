export interface CodeViewFile { path: string; status: 'modified' | 'added' | 'deleted' | 'untracked'; additions?: number; deletions?: number; binary?: boolean }
export const REGISTERED_WORKTREE_UNAVAILABLE = '등록된 작업 폴더를 사용할 수 없습니다. 작업 폴더 등록을 확인해 주세요';
export interface CodeViewResult {
  root: string; head: string | null; files: CodeViewFile[];
  commit?: string; commits?: { id: string; subject: string }[];
  registeredWorktree?:string|null;
  branches?: {ref:string;id:string}[]; worktrees?: {path:string;branch?:string}[];
  base?: string; target?: string; baseId?: string; targetId?: string;
  path?: string; diff?: string; binary?: boolean;
}
export interface DiffLine { kind: 'add' | 'delete' | 'context' | 'header'; text: string; old?: number; next?: number }
export function diffLines(diff: string): DiffLine[] {
  let old = 0, next = 0, hunk = false;
  return diff.split('\n').filter((line, index, all) => index < all.length - 1 || line !== '').map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) { old = Number(match[1]); next = Number(match[2]); hunk = true; return { kind:'header', text:line }; }
    if (hunk && line.startsWith('+')) return {kind:'add',text:line.slice(1),next:next++};
    if (hunk && line.startsWith('-')) return {kind:'delete',text:line.slice(1),old:old++};
    if (hunk && line.startsWith(' ')) return {kind:'context',text:line.slice(1),old:old++,next:next++};
    return {kind:'header',text:line};
  });
}
