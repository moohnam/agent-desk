import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { Hub } from './hub.ts';
import { HttpError } from './errors.ts';
import { expandHome } from './paths.ts';
import { remoteLocation } from '../../shared/remote.ts';
import type { CodeViewResult } from '../../shared/code-view.ts';
const exec = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX = 512 * 1024;
export async function readCodeView(cwd: string, path?: string): Promise<CodeViewResult> {
  const root = await realpath(cwd);
  const overrides = ['-c','core.fsmonitor=false'];
  const git = async (args: string[]) => (await exec('git', ['--no-optional-locks', ...overrides, '-C', root, ...args],
    {timeout:5000,maxBuffer:2*1024*1024,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1'}})).stdout;
  try { await git(['rev-parse','--show-toplevel']); } catch { throw new HttpError(409,'이 작업 폴더는 Git 저장소가 아닙니다'); }
  // Repository-configured clean/process filters can execute even during git diff.
  const filters=await git(['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$']).catch(error=>{
    if(error.code===1)return '';throw error;
  });
  for(const key of filters.split('\0').filter(Boolean))overrides.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
  const head = await git(['rev-parse','--verify','HEAD']).then(s=>s.trim()).catch(()=>null);
  const base = head ?? EMPTY_TREE;
  const status = (await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-status','-z','--relative',base,'--','.'])).split('\0').filter(Boolean);
  const changed: CodeViewResult['files'] = [];
  for(let i=0;i<status.length;i+=2)changed.push({path:status[i+1],status:status[i]==='A'?'added':status[i]==='D'?'deleted':'modified'});
  const untracked = (await git(['ls-files','--others','--exclude-standard','-z','--','.'])).split('\0').filter(Boolean);
  if(changed.length+untracked.length>1000) throw new HttpError(413,'변경 파일이 1,000개를 넘습니다. 작업 범위를 줄여 주세요');
  const files: CodeViewResult['files'] = [...changed,...untracked.map(path=>({path,status:'untracked' as const}))];
  const result: CodeViewResult = {root,head,files};
  if(path===undefined)return result;
  if(!files.some(file=>file.path===path))throw new HttpError(404,'변경 파일 목록에 없는 경로입니다');
  const target=resolve(root,path),rel=relative(root,target);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`))throw new HttpError(400,'작업 폴더 밖의 파일은 볼 수 없습니다');
  let diff: string;
  if(untracked.includes(path)) {
    const canonical=await realpath(target);
    if(canonical!==target)throw new HttpError(409,'심볼릭 링크 파일은 미리 볼 수 없습니다');
    const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=await file.stat();
      if(!stat.isFile()||stat.size>MAX)throw new HttpError(413,'파일이 너무 큽니다 (최대 512 KiB)');
      const current=await lstat(target);
      if(await realpath(target)!==target||current.dev!==stat.dev||current.ino!==stat.ino)
        throw new HttpError(409,'파일 경로가 바뀌었습니다. 다시 읽어 주세요');
      const buffer=Buffer.alloc(MAX+1);
      const {bytesRead}=await file.read(buffer,0,buffer.length,0);
      if(bytesRead>MAX)throw new HttpError(413,'파일이 너무 큽니다 (최대 512 KiB)');
      const bytes=buffer.subarray(0,bytesRead);
      if(bytes.includes(0))return {...result,path,binary:true};
      const lines=bytes.toString('utf8').split('\n');if(lines.at(-1)==='')lines.pop();
      diff=`--- /dev/null\n+++ ${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>'+'+line).join('\n')}\n`;
    }finally{await file.close();}
  }else diff=await git(['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--relative','--unified=3',base,'--',path]);
  if(Buffer.byteLength(diff)>MAX)throw new HttpError(413,'diff가 너무 큽니다 (최대 512 KiB)');
  return {...result,path,diff,binary:/^Binary files .* differ$/m.test(diff)};
}
export async function taskCodeView(hub: Hub, input: Record<string,unknown>, shared = false) {
  if(!input||typeof input!=='object'||typeof input.task_id!=='string'||!input.task_id||input.path!==undefined&&(typeof input.path!=='string'||input.path.length>4096))
    throw new HttpError(400,'작업 ID와 올바른 파일 경로가 필요합니다');
  const task=hub.store.getTask(input.task_id);
  if(!task)throw new HttpError(404,'작업을 찾을 수 없습니다');
  const cwd=hub.cwdOf(input.task_id) ?? hub.store.getProject(task.project_id)?.root_path;
  if(!cwd)throw new HttpError(404,'작업 폴더가 없습니다');
  const remote=remoteLocation(cwd);
  if(remote&&!shared)throw new HttpError(409,'원격 작업공간 연결이 필요합니다');
  return readCodeView(expandHome(remote?.path??cwd),input.path as string|undefined);
}
