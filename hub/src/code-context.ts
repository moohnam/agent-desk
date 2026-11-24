import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Hub } from './hub.ts';
import { remoteLocation } from '../../shared/remote.ts';
import { expandHome } from './paths.ts';
import { HttpError } from './errors.ts';
const exec=promisify(execFile);

const runGit = (cwd: string, ...args: string[]) => exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',cwd,...args], {
  timeout:5000,maxBuffer:2*1024*1024,
  env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'},
});

async function gitCommonDir(cwd: string) {
  const {stdout} = await runGit(cwd,'rev-parse','--path-format=absolute','--git-common-dir');
  return realpath(stdout.replace(/\n$/,''));
}

async function legacyWorktrees(commonDir: string) {
  const read = (path: string) => readFile(path,'utf8').catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  });
  const entry = async (path: string, gitDir: string) => {
    const head = await read(join(gitDir,'HEAD'));
    const branch = /^ref: (refs\/heads\/[^\n]+)\n?$/.exec(head)?.[1];
    return {path,branch};
  };
  const main = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const result = [await entry(main,commonDir)];
  const registry = join(commonDir,'worktrees');
  const ids = await readdir(registry).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const id of ids) {
    const gitDir = join(registry,id);
    const gitFile = (await read(join(gitDir,'gitdir'))).replace(/\n$/,'');
    if (isAbsolute(gitFile) && basename(gitFile) === '.git') result.push(await entry(dirname(gitFile),gitDir));
  }
  return result;
}

export async function registeredWorktrees(cwd:string) {
  const result = await runGit(cwd,'worktree','list','--porcelain','-z').catch(error => {
    if (error.code === 129 && /unknown switch [`']z'/.test(error.stderr)) return null;
    throw error;
  });
  if (!result) {
    // Older Git prints paths verbatim in line-delimited porcelain, including embedded newlines.
    return legacyWorktrees(await gitCommonDir(cwd));
  }
  return result.stdout.split('\0\0').filter(Boolean).map(entry=>{const fields=entry.split('\0');return {path:fields.find(f=>f.startsWith('worktree '))?.slice(9)??'',branch:fields.find(f=>f.startsWith('branch '))?.slice(7)};}).filter(item=>item.path);
}

export async function resolveRegisteredWorktree(cwd: string, worktree: string) {
  const unavailable = () => new HttpError(403,'등록된 worktree가 사라졌거나 저장소가 변경됐습니다');
  try {
    const root = await realpath(worktree);
    const [commonDir, selectedCommonDir, top] = await Promise.all([
      gitCommonDir(cwd), gitCommonDir(root), runGit(root,'rev-parse','--show-toplevel'),
    ]);
    if (commonDir === selectedCommonDir && root === await realpath(top.stdout.replace(/\n$/,''))) return root;
  } catch {
    throw unavailable();
  }
  throw unavailable();
}
export function taskCodeRoot(hub:Hub,taskId:string,shared=false) {
  const task=hub.store.getTask(taskId);if(!task)throw new HttpError(404,'작업을 찾을 수 없습니다');
  const cwd=hub.cwdOf(taskId)??hub.store.getProject(task.project_id)?.root_path;if(!cwd)throw new HttpError(404,'작업 폴더가 없습니다');
  const remote=remoteLocation(cwd);if(remote&&!shared)throw new HttpError(409,'원격 작업공간 연결이 필요합니다');
  return expandHome(remote?.path??cwd);
}
export function storedCodeContext(hub:Hub,taskId:string):{revision:string;worktree:string|null} {
  const raw=hub.store.setting('code_context:'+taskId);return raw?JSON.parse(raw):{revision:'initial',worktree:null};
}
export async function codeContext(hub:Hub,taskId:string,update?:{revision:unknown;worktree:unknown},authorize?:()=>void) {
  const cwd=taskCodeRoot(hub,taskId,true);
  // Clearing a stale registration must also work after its directory disappears.
  let available:Awaited<ReturnType<typeof registeredWorktrees>>=[];
  if(!update||update.worktree!==null)available=await registeredWorktrees(cwd);
  let current=storedCodeContext(hub,taskId);
  if(update){
    if(typeof update.revision!=='string'||update.worktree!==null&&typeof update.worktree!=='string')throw new HttpError(400,'revision과 worktree 경로 또는 null이 필요합니다');
    let path=update.worktree as string|null;
    if(path!==null){
      if(!available.some(item=>item.path===path))throw new HttpError(403,'같은 저장소에 등록된 worktree만 연결할 수 있습니다');
      path=await resolveRegisteredWorktree(cwd,path);
    }
    authorize?.();current=storedCodeContext(hub,taskId);
    if(current.revision!==update.revision)throw new HttpError(409,'worktree 연결이 변경됐습니다. 다시 조회한 뒤 변경하세요');
    current={revision:randomUUID(),worktree:path};hub.store.setSetting('code_context:'+taskId,JSON.stringify(current));
  }
  authorize?.();return {task_id:taskId,...current,available};
}
