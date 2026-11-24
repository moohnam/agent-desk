import { useDiffWrap } from './diffWrap.ts';
import { CodeActions } from './CodeActions.tsx';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { api } from './api.ts';
import { diffLines, type CodeViewResult } from '../../shared/code-view.ts';
import './code-panel.css';
const language = (path: string) => ({ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',rb:'ruby',rs:'rust',go:'go',sh:'bash',yml:'yaml',yaml:'yaml',json:'json',css:'css',html:'xml',md:'markdown',sql:'sql',c:'c',h:'c',cpp:'cpp',java:'java'} as Record<string,string>)[path.split('.').at(-1)??''];
export const CodePanel = memo(function CodePanel({taskId,title,onClose,onQuote,onSend}:{taskId:string;title:string;onClose:()=>void;onQuote?:(text:string)=>void;onSend?:(text:string)=>Promise<{task_id?:string;shared_pending?:boolean}|undefined>}) {
  const [snapshot,setSnapshot]=useState<{data:CodeViewResult;revision:number}>();
  const [commit,setCommit]=useState('');
  const [worktree,setWorktree]=useState('');
  const [base,setBase]=useState('');
  const [target,setTarget]=useState('');
  const [branches,setBranches]=useState<NonNullable<CodeViewResult['branches']>>([]);
  const [worktrees,setWorktrees]=useState<NonNullable<CodeViewResult['worktrees']>>([]);
  const comparison={...(base&&target?{base,target}:{}),...(worktree?{worktree}:{})};
  const [history,setHistory]=useState<NonNullable<CodeViewResult['commits']>>([]);
  const [selected,setSelected]=useState<string>();
  const [content,setContent]=useState<CodeViewResult>();
  const [error,setError]=useState('');
  const [listError,setListError]=useState('');
  const [listing,setListing]=useState(false);
  const [reading,setReading]=useState(false);
  const [revision,setRevision]=useState(0);
  const [limit,setLimit]=useState(200);
  const wrap=useDiffWrap();
  const scroll=useRef<HTMLDivElement>(null);
  const keyOf=(file:CodeViewResult['files'][number])=>JSON.stringify([file.status==='untracked'?'untracked':'tracked',file.path]);
  const file=snapshot?.data.files.find(file=>keyOf(file)===selected);
  const path=file?.path;
  const kind=file?.status==='untracked'?'untracked':'tracked';
  const loading=listing||reading;
  useEffect(()=>{
    const controller=new AbortController();
    setListing(true);setReading(false);setError('');setListError('');
    void api.codeView(taskId,undefined,controller.signal,undefined,commit||undefined,comparison).then(data=>{
      if(controller.signal.aborted)return;
      if((base&&target&&(data.base!==base||data.target!==target)) || (worktree&&data.root!==worktree) || (commit && data.commit!==commit))throw new Error('이 러너를 업데이트하면 커밋별 변경을 볼 수 있습니다');
      setBranches(data.branches??[]);setWorktrees(data.worktrees??[]);
      const page=data.commits??[];
      setHistory(previous=>{
        if(!commit)return page;
        const seen=new Set(previous.map(item=>item.id));
        return [...previous,...page.filter(item=>!seen.has(item.id))];
      });
      setReading(data.files.length>0);
      setSnapshot({data,revision});
      setSelected(previous=>data.files.some(file=>keyOf(file)===previous)?previous:data.files[0]?keyOf(data.files[0]):undefined);
    }).catch(e=>{if(!controller.signal.aborted){
      setListError(e.message);
      setReading(!!snapshot?.data.files.length);
      // A failed refresh must not invalidate the last usable file list.
      setSnapshot(previous=>previous?{...previous,revision}:previous);
    }})
      .finally(()=>{if(!controller.signal.aborted)setListing(false);});
    return()=>controller.abort();
  },[taskId,revision,commit,base,target,worktree]);
  useEffect(()=>{
    if(snapshot?.revision!==revision)return;
    const controller=new AbortController();
    if(!path){setContent(undefined);setReading(false);return;}
    setReading(true);setError('');setContent(undefined);
    void api.codeView(taskId,path,controller.signal,kind,commit||undefined,comparison).then(result=>{
      if(!controller.signal.aborted)setContent(result);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return()=>controller.abort();
  },[taskId,path,kind,snapshot,revision,commit,base,target,worktree]);
  useEffect(()=>{setLimit(200);setContent(undefined);if(scroll.current)scroll.current.scrollTop=0;},[selected]);
  const rows=useMemo(()=>diffLines(content?.diff??''),[content]);
  const [range,setRange]=useState<{source:CodeViewResult;anchor:number;end:number}>();
  const active=range && range.source===content && !loading ? range : undefined;
  const start=active?Math.min(active.anchor,active.end):-1;
  const end=active?Math.max(active.anchor,active.end):-1;
  const selectLine=(index:number,extend:boolean)=>{
    if(content)setRange({source:content,anchor:extend && active?active.anchor:index,end:index});
  };
  const captureSelection=()=>{
    const selection=window.getSelection();
    if(!selection || selection.isCollapsed || !content)return;
    const indexOf=(node:Node|null)=>{
      const el=node instanceof Element?node:node?.parentElement;
      const row=el?.closest<HTMLElement>('[data-diff-row]');
      return row && scroll.current?.contains(row)?Number(row.dataset.diffRow):-1;
    };
    const anchor=indexOf(selection.anchorNode),end=indexOf(selection.focusNode);
    if(anchor>=0 && end>=0)setRange({source:content,anchor,end});
  };
  const selectedQuote=()=>{
    if(!active || !path)return;
    const picked=rows.slice(start,end+1);
    const positions=(side:'old'|'next')=>{
      const numbers=picked.flatMap(row=>row[side]===undefined?[]:[row[side]!]);
      return numbers.length ? numbers[0]===numbers.at(-1)?String(numbers[0]):numbers[0]+'–'+numbers.at(-1) : '없음';
    };
    const snippet=picked.map(row=>(row.kind==='add'?'+':row.kind==='delete'?'-':row.kind==='context'?' ':'')+row.text).join('\n');
    const metadata=JSON.stringify(content?.root)+' / '+JSON.stringify(path)+' · '+(content?.baseId?content.base+' ('+content.baseId+') → '+content.target+' ('+content.targetId+')':commit||'미커밋 (HEAD '+(content?.head??'없음')+')')+
      ' · 이전 '+positions('old')+' / 이후 '+positions('next');
    const body=metadata+'\n'+snippet;
    const fence='`'.repeat(Array.from(body.matchAll(/`+/g)).reduce((n,m)=>Math.max(n,m[0].length+1),3));
    return fence+'diff\n'+body+'\n'+fence;
  };
  const lang=path&&language(path);
  return <aside className="code-panel" aria-label="코드 변경 보기" onKeyDown={e=>{if(e.currentTarget.contains(e.target as Node))e.stopPropagation();}}>
    <header><strong title={title}>코드 변경 · {title}</strong><button aria-label="코드 새로고침" title="현재 변경 다시 읽기" disabled={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={16}/></button><button aria-label="코드 창 닫기" onClick={onClose}><X size={16}/></button></header>
    <div className="code-scope">작업 폴더 전체 · {base&&target?'두 브랜치 끝 커밋의 차이':commit?'첫 번째 부모 대비 커밋 변경':'HEAD 대비 미커밋 변경'}<br/><span title={snapshot?.data.root}>{snapshot?.data.root??'작업 폴더 확인 중…'}</span><small>{base&&target?`${base.replace(/^refs\/(heads|remotes)\//,'')} (${(content?.baseId??snapshot?.data.baseId??'').slice(0,12)}) → ${target.replace(/^refs\/(heads|remotes)\//,'')} (${(content?.targetId??snapshot?.data.targetId??'').slice(0,12)})`:`${commit?'선택한 커밋':'기준'} ${(commit||content?.head||snapshot?.data.head)?.slice(0,12)??'첫 커밋 전'}`} · 읽기 전용</small></div>
    {listError&&<p role="alert">목록 갱신 실패: {listError}{snapshot?' · 마지막으로 읽은 목록입니다.':''}</p>}
    {error&&<p role="alert">{error}</p>}
    {!!worktrees.length&&<label className="code-worktree">작업 폴더<select aria-label="코드 worktree" value={worktree} onChange={e=>{setWorktree(e.target.value);setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);}}><option value="">{snapshot?.data.registeredWorktree?`등록된 작업 폴더 · ${snapshot.data.registeredWorktree}`:'작업 세션 폴더'}</option>{worktrees.map(item=><option key={item.path} value={item.path}>{item.path} {item.branch?'· '+item.branch.replace('refs/heads/',''):''}</option>)}</select></label>}
    {!!branches.length&&<details className="code-branches"><summary>브랜치 간 비교</summary><div className="code-selectors">
      <select aria-label="기준 브랜치" value={base} onChange={e=>{setBase(e.target.value);setCommit('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);}}><option value="">기준 선택</option>{branches.map(item=><option key={item.ref} value={item.ref}>{item.ref.replace(/^refs\/(heads|remotes)\//,'')}</option>)}</select>
      <select aria-label="대상 브랜치" value={target} onChange={e=>{setTarget(e.target.value);setCommit('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);}}><option value="">대상 선택</option>{branches.map(item=><option key={item.ref} value={item.ref}>{item.ref.replace(/^refs\/(heads|remotes)\//,'')}</option>)}</select>
    </div><small>기준 → 대상의 파일 차이입니다. 원격 브랜치는 마지막으로 받아온 상태이며 자동 fetch하지 않습니다.</small></details>}
    <div className="code-selectors">
      <select aria-label="변경 기준" value={base&&target?'__branches':commit} onChange={e=>{
        setCommit(e.target.value);setBase('');setTarget('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);
      }}>
        <option value="">미커밋 변경</option>{base&&target&&<option value="__branches">브랜치 비교 중</option>}
        {commit&&!history.some(item=>item.id===commit)&&<option value={commit}>{commit.slice(0,12)}</option>}
        {history.map(item=><option key={item.id} value={item.id}>{item.id.slice(0,8)} · {item.subject}</option>)}
      </select>
      <select aria-label="변경 파일" value={selected??''} onChange={e=>{setContent(undefined);setSelected(e.target.value);}} disabled={!snapshot?.data.files.length}>
        {!snapshot?.data.files.length&&<option value="">변경 파일 없음</option>}
        {snapshot?.data.files.map(file=><option key={keyOf(file)} value={keyOf(file)}>{({untracked:'[새 파일] ',added:'[추가] ',deleted:'[삭제] ',modified:'[수정] '})[file.status]}{file.path}</option>)}
      </select>
    </div>
    {onQuote&&onSend&&<CodeActions taskId={taskId} quote={selectedQuote()} onQuote={text=>{onQuote(text);setRange(undefined);}} onSend={onSend}/> }
    {loading&&<p role="status">변경을 불러오는 중…</p>}
    <div className={wrap?'code-diff wrap':'code-diff'} onPointerUp={captureSelection} onKeyUp={captureSelection} ref={scroll} tabIndex={0} aria-label="파일 diff">
      {!loading&&!error&&!listError&&!snapshot?.data.files.length&&<p>{base&&target?'두 브랜치 사이에 변경된 파일이 없습니다.':commit?'이 커밋에서 변경된 파일이 없습니다.':'미커밋 변경이 없습니다.'}</p>}
      {content?.binary?<p>바이너리 파일은 코드 diff를 표시하지 않습니다.</p>:rows.slice(0,limit).map((row,index)=>{
        const html=row.kind!=='header'&&lang&&hljs.getLanguage(lang)&&row.text.length<8000
          ?hljs.highlight(row.text,{language:lang,ignoreIllegals:true}).value:undefined;
        return <div key={index} data-diff-row={index} className={`code-line ${row.kind}${index>=start && index<=end?' quoted':''}`}><span className="code-number">{row.old??''}</span><span className="code-number">{row.next??''}</span>{onQuote&&row.kind!=='header'?<button type="button" className="code-sign" aria-label={`diff ${index+1}번째 줄 선택`} title="줄 선택 · Shift+클릭으로 범위 선택" onClick={e=>selectLine(index,e.shiftKey)}>{row.kind==='add'?'+':row.kind==='delete'?'-':'·'}</button>:<span className="code-sign">{row.kind==='add'?'+':row.kind==='delete'?'-':''}</span>}{html===undefined?<code>{row.text||' '}</code>:<code dangerouslySetInnerHTML={{__html:html||' '}}/>}</div>;
      })}
      {rows.length>limit&&<button className="code-more" onClick={()=>setLimit(n=>n+200)}>다음 200줄 표시 ({rows.length-limit}줄 남음)</button>}
    </div>
  </aside>;
});
