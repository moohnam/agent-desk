import { registeredWorktrees, storedCodeContext, taskCodeRoot } from './code-context.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { Hub } from './hub.ts';
import { HttpError } from './errors.ts';
import type { CodeViewResult } from '../../shared/code-view.ts';
const exec = promisify(execFile);
const MAX = 512 * 1024;
export async function readCodeView(cwd: string, path?: string, kind?: 'tracked' | 'untracked', commit?: string, options: {base?:string;target?:string;worktree?:string} = {}): Promise<CodeViewResult> {
  let root = await realpath(cwd);
  let target=resolve(root,path??'.'),rel=relative(root,target);
  if(path!==undefined&&(!rel||rel==='..'||rel.startsWith(`..${sep}`)||path.includes('\0')))
    throw new HttpError(400,'작업 폴더 밖의 파일은 볼 수 없습니다');
  const overrides = ['-c','core.fsmonitor=false'];
  const git = async (args: string[]) => {
    const running=exec('git', ['--no-optional-locks', ...overrides, '-C', root, ...args],
      {timeout:5000,maxBuffer:2*1024*1024,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1'}});
    running.child.stdin?.end();
    return (await running).stdout;
  };
  try { await git(['rev-parse','--show-toplevel']); } catch { throw new HttpError(409,'이 작업 폴더는 Git 저장소가 아닙니다'); }
  const worktrees=await registeredWorktrees(root);
  if(options.worktree!==undefined){
    if(typeof options.worktree!=='string'||!worktrees.some(item=>item.path===options.worktree))throw new HttpError(403,'이 저장소에 등록된 worktree만 선택할 수 있습니다');
    root=await realpath(options.worktree);target=resolve(root,path??'.');rel=relative(root,target);
    if(path!==undefined&&(!rel||rel==='..'||rel.startsWith(`..${sep}`)))throw new HttpError(400,'작업 폴더 밖의 파일은 볼 수 없습니다');
  }
  // Repository-configured clean/process filters can execute even during git diff.
  const filters=await git(['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$']).catch(error=>{
    if(error.code===1)return '';throw error;
  });
  for(const key of filters.split('\0').filter(Boolean))overrides.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
  const head = await git(['rev-parse','--verify','HEAD']).then(s=>s.trim()).catch(()=>null);
  // The Desk checkout can lag behind its deployed upstream. Use locally known refs only.
  const upstream=(commit || path===undefined) && head
    ? await git(['rev-parse','--verify','@{upstream}^{commit}']).then(value=>value.trim(),()=>null) : null;
  const tips=[...new Set([head,upstream].filter((id): id is string=>!!id))];
  const emptyTree = async () => (await git(['hash-object','-t','tree','--stdin'])).trim();
  let comparison: string[];
  const refs=await git(['for-each-ref','--format=%(refname)%09%(objectname)','refs/heads/','refs/remotes/']);
  const branches=refs.trimEnd().split('\n').filter(Boolean).map(line=>{const [ref,id]=line.split('\t');return {ref,id};});
  let baseId:string|undefined,targetId:string|undefined;
  if(options.base!==undefined||options.target!==undefined){
    if(commit!==undefined||typeof options.base!=='string'||typeof options.target!=='string')throw new HttpError(400,'비교할 기준과 대상 브랜치가 필요합니다');
    const base=branches.find(item=>item.ref===options.base),targetBranch=branches.find(item=>item.ref===options.target);
    if(!base||!targetBranch)throw new HttpError(404,'로컬에서 찾을 수 없는 브랜치입니다. 브랜치 목록을 새로고침하세요');
    baseId=base.id;targetId=targetBranch.id;
    comparison=[baseId,targetId];
  } else if (commit !== undefined) {
    if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      throw new HttpError(400,'올바른 커밋 ID가 필요합니다');
    let reachable=false;
    for(const tip of tips) {
      reachable=await git(['merge-base','--is-ancestor',commit,tip]).then(()=>true,()=>false);
      if(reachable)break;
    }
    if(!reachable)throw new HttpError(404,'현재 브랜치와 추적 브랜치에서 커밋을 찾을 수 없습니다');
    const parents = (await git(['show','--no-patch','--no-show-signature','--format=%P',commit])).trim();
    comparison = [parents.split(' ')[0] || await emptyTree(), commit];
  } else comparison = [head ?? await emptyTree()];
  const status = (await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-status','-z','--relative',...comparison,'--',path??'.'])).split('\0').filter(Boolean);
  const changed: CodeViewResult['files'] = [];
  for(let i=0;i<status.length;i+=2)changed.push({path:status[i+1],status:status[i]==='A'?'added':status[i]==='D'?'deleted':'modified'});
  const untracked = commit || baseId ? [] : (await git(['ls-files','--others','--exclude-standard','-z','--',path??'.'])).split('\0').filter(Boolean);
  if(changed.length+untracked.length>1000) throw new HttpError(413,'변경 파일이 1,000개를 넘습니다. 작업 범위를 줄여 주세요');
  const files: CodeViewResult['files'] = [...changed,...untracked.map(path=>({path,status:'untracked' as const}))];
  const result: CodeViewResult = {root,head,files,...(baseId?{base:options.base,target:options.target,baseId,targetId}:{})};
  if(commit)result.commit=commit;
  if(path===undefined) {
    result.branches=branches;result.worktrees=worktrees;
    const starts=commit?[commit]:tips;
    const log=starts.length?await git(['log','--full-history','--no-show-signature','--format=%H%x09%s','-50',...starts,'--','.']):'';
    result.commits=log.trimEnd().split('\n').filter(Boolean).map(line=>{
      const [id,...subject]=line.split('\t');
      return {id,subject:subject.join(' ')};
    });
    return result;
  }
  const selected=files.find(file=>file.path===path && (kind===undefined || (file.status==='untracked')===(kind==='untracked')));
  if(!selected)throw new HttpError(404,'변경 파일 목록에 없는 경로입니다');
  let diff: string;
  if(selected.status==='untracked') {
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
  }else diff=await git(['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--relative','--unified=3',...comparison,'--',path]);
  if(Buffer.byteLength(diff)>MAX)throw new HttpError(413,'diff가 너무 큽니다 (최대 512 KiB)');
  return {...result,path,diff,binary:/^Binary files .* differ$/m.test(diff)};
}
export async function taskCodeView(hub: Hub, input: Record<string,unknown>, shared = false) {
  if(!input||typeof input!=='object'||typeof input.task_id!=='string'||!input.task_id||input.path!==undefined&&(typeof input.path!=='string'||input.path.length>4096))
    throw new HttpError(400,'작업 ID와 올바른 파일 경로가 필요합니다');
  if(input.kind!==undefined&&input.kind!=='tracked'&&input.kind!=='untracked')throw new HttpError(400,'잘못된 변경 종류입니다');
  const cwd=taskCodeRoot(hub,input.task_id,shared);
  const context=storedCodeContext(hub,input.task_id);
  const chosen=input.worktree===undefined?context.worktree:input.worktree;
  const result=await readCodeView(cwd,input.path as string|undefined,input.kind as 'tracked'|'untracked'|undefined,input.commit as string|undefined,{base:input.base as string|undefined,target:input.target as string|undefined,worktree:chosen===null||chosen===''?undefined:chosen as string});
  return {...result,registeredWorktree:context.worktree};
}
