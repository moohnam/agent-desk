import { imeKey } from './keys.ts';
import { setDiffWrap, useDiffWrap } from './diffWrap.ts';
import { writeClipboardText } from './clipboard.ts';
import { CodeActions } from './CodeActions.tsx';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, ChevronUp, ChevronDown, WrapText, GitCompare, Quote } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { api } from './api.ts';
import type { CodeSendResult } from './codeSend.ts';
import { diffLines, REGISTERED_WORKTREE_UNAVAILABLE, type CodeViewResult } from '../../shared/code-view.ts';
const languages: Record<string,string> = {ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',rb:'ruby',rs:'rust',go:'go',sh:'bash',yml:'yaml',yaml:'yaml',json:'json',css:'css',html:'xml',md:'markdown',sql:'sql',c:'c',h:'c',cpp:'cpp',java:'java'};
function language(path: string) {
  const extension = path.split('.').at(-1) ?? '';
  return Object.hasOwn(languages, extension) ? languages[extension] : undefined;
}
const STATUS: Record<CodeViewResult['files'][number]['status'], [string, string]> = { modified: ['M', '수정'], added: ['A', '추가'], deleted: ['D', '삭제'], untracked: ['U', '새 파일'] };
const branchLabel = (ref:string) => ref.startsWith('refs/remotes/')
  ? `${ref.slice('refs/remotes/'.length)} (원격 추적)`
  : `${ref.slice('refs/heads/'.length)} (로컬)`;
export const CodePanel = memo(function CodePanel({taskId,title,onClose,onQuote,onSend}:{taskId:string;title:string;onClose:()=>void;onQuote?:(text:string)=>void;onSend?:(text:string)=>Promise<CodeSendResult|undefined>}) {
  const [snapshot,setSnapshot]=useState<{data:CodeViewResult;revision:number}>();
  const [commit,setCommit]=useState('');
  const [worktree,setWorktree]=useState<string|null>('');
  const [base,setBase]=useState('');
  const [target,setTarget]=useState('');
  const [branches,setBranches]=useState<NonNullable<CodeViewResult['branches']>>([]);
  const [worktrees,setWorktrees]=useState<NonNullable<CodeViewResult['worktrees']>>([]);
  const comparison={...(base&&target?{base,target}:{}),...(worktree===''?{}:{worktree})};
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
    const listing = snapshot.data;
    const selectedWorktree = worktree || (worktree === '' && listing.registeredWorktree ? listing.root : null);
    void api.codeView(taskId,path,controller.signal,kind,commit||undefined,{...comparison,worktree:selectedWorktree}).then(result=>{
      if(controller.signal.aborted)return;
      const uncommitted = !listing.commit && !listing.baseId;
      if(result.root!==listing.root || result.commit!==listing.commit || result.baseId!==listing.baseId || result.targetId!==listing.targetId
        || (uncommitted && result.head!==listing.head))
        throw new Error('코드 비교 기준이 바뀌었습니다. 코드 목록을 새로고침해 주세요');
      setContent(result);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return()=>controller.abort();
  },[taskId,path,kind,snapshot,revision,commit,base,target,worktree]);
  useEffect(()=>{setLimit(200);setContent(undefined);if(scroll.current)scroll.current.scrollTop=0;},[selected]);
  // The git preamble before the first hunk (diff --git, index, ---/+++) repeats what the file head shows.
  const rows=useMemo(()=>{
    const all=diffLines(content?.diff??'');
    const first=all.findIndex(row=>row.kind==='header'&&row.text.startsWith('@@'));
    return first>0?all.slice(first):all;
  },[content]);
  const [range,setRange]=useState<{source:CodeViewResult;anchor:number;end:number}>();
  const active=range && range.source===content && !loading ? range : undefined;
  const start=active?Math.min(active.anchor,active.end):-1;
  const end=active?Math.max(active.anchor,active.end):-1;
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
  const changeWorktree=(path:string|null)=>{setWorktree(path);setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);};
  const stats=snapshot?.data.files.reduce((sum,file)=>({
    added:sum.added+(file.additions??0),deleted:sum.deleted+(file.deletions??0),
    binary:sum.binary+(file.binary?1:0),unknown:sum.unknown+(!file.binary&&(file.additions===undefined||file.deletions===undefined)?1:0),
  }),{added:0,deleted:0,binary:0,unknown:0});
  const sessionWorktree = 'session-worktree';
  // Files grouped by folder in the order they first appear; the tree and [ ] follow this order.
  const [filter,setFilter]=useState('');
  const groups=useMemo(()=>{
    const out=new Map<string,CodeViewResult['files']>();
    for(const item of snapshot?.data.files??[]){const folder=item.path.includes('/')?item.path.slice(0,item.path.lastIndexOf('/')):'';out.set(folder,[...(out.get(folder)??[]),item]);}
    return [...out];
  },[snapshot]);
  const ordered=groups.flatMap(([,items])=>items);
  const position=ordered.findIndex(item=>keyOf(item)===selected);
  const choose=(item:CodeViewResult['files'][number]|undefined)=>{if(item&&keyOf(item)!==selected){setContent(undefined);setSelected(keyOf(item));}};
  const shown=filter.trim()?groups.map(([folder,items])=>[folder,items.filter(item=>item.path.toLowerCase().includes(filter.trim().toLowerCase()))] as const).filter(([,items])=>items.length):groups;
  // Hunks: the @@ rows; the current one follows the scroll position.
  const hunks=useMemo(()=>rows.flatMap((row,index)=>row.kind==='header'&&row.text.startsWith('@@')?[index]:[]),[rows]);
  const [hunk,setHunk]=useState(0);
  useEffect(()=>setHunk(0),[rows]);
  const reveal=(index:number)=>{
    if(index>=limit)setLimit(Math.ceil((index+1)/200)*200);
    requestAnimationFrame(()=>scroll.current?.querySelector(`[data-diff-row="${index}"]`)?.scrollIntoView({block:'start'}));
  };
  const goHunk=(dir:1|-1)=>{const next=Math.max(0,Math.min(hunks.length-1,hunk+dir));if(hunks[next]===undefined)return;setHunk(next);reveal(hunks[next]);};
  const followHunk=()=>{
    const pane=scroll.current;if(!pane||!hunks.length)return;
    const top=pane.getBoundingClientRect().top+4;
    let current=0;
    hunks.forEach((index,i)=>{const row=pane.querySelector(`[data-diff-row="${index}"]`);if(row&&row.getBoundingClientRect().top<=top)current=i;});
    setHunk(current);
  };
  // Lines are picked by dragging over them (a click picks one, Shift+click extends); text selection is off in the diff.
  const dragFrom=useRef<number|null>(null);
  useEffect(()=>{const stop=()=>{dragFrom.current=null;};window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);return()=>{window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);};},[]);
  const rowAt=(target:EventTarget|null)=>{const row=(target as Element|null)?.closest?.<HTMLElement>('[data-diff-row]');return row&&scroll.current?.contains(row)?Number(row.dataset.diffRow):-1;};
  const picked=active?rows.slice(start,end+1).filter(row=>row.kind!=='header'):[];
  const pickedRange=()=>{
    const numbers=picked.flatMap(row=>row.next??row.old??[]);
    return numbers.length?numbers[0]===numbers.at(-1)?String(numbers[0]):`${numbers[0]}–${numbers.at(-1)}`:'';
  };
  const fileName=(item:CodeViewResult['files'][number])=>item.path.slice(item.path.lastIndexOf('/')+1);
  const counts=(item:CodeViewResult['files'][number])=>item.binary?<span className="code-count">바이너리</span>
    :item.additions===undefined||item.deletions===undefined?<span className="code-count">미집계</span>
    :<span className="code-count"><b className="add">+{item.additions}</b><b className="del">−{item.deletions}</b></span>;
  const marks=useMemo(()=>rows.flatMap((row,index)=>row.kind==='add'||row.kind==='delete'?[<i key={index} className={row.kind} style={{top:`${(100*index/rows.length).toFixed(2)}%`}}/>]:[]),[rows]);
  return <aside className="code-panel" aria-label="코드 변경 보기" onKeyDown={e=>{
    // Portalled dialogs retain their own Escape handler on document.
    if(!e.currentTarget.contains(e.target as Node))return;
    const typing=(e.target as Element).closest('input, textarea, select');
    if(!typing&&!imeKey(e.nativeEvent)&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&['[',']','n','p'].includes(e.key)){
      e.preventDefault();e.stopPropagation();
      if(e.key==='['||e.key===']')choose(ordered[position+(e.key===']'?1:-1)]);else goHunk(e.key==='n'?1:-1);
      return;
    }
    if(e.key!=='Escape'||imeKey(e.nativeEvent)){e.stopPropagation();return;}
    if(e.defaultPrevented||e.repeat)return;
    const select=(e.target as Element).closest('select');
    if(select&&CSS.supports('selector(select:open)')&&select.matches(':open')){
      e.stopPropagation();return; // Keep the native default that dismisses its popup.
    }
    const disclosure=(e.target as Element).closest<HTMLDetailsElement>('details[open]')
      ??e.currentTarget.querySelector<HTMLDetailsElement>('details[open]');
    if(disclosure){
      e.preventDefault();e.stopPropagation();disclosure.open=false;
      disclosure.querySelector('summary')?.focus();
      return;
    }
    // Picked lines are let go before the panel closes, like an open disclosure.
    if(active){e.preventDefault();e.stopPropagation();setRange(undefined);return;}
    // Otherwise let the desk close this panel through its existing close action.
  }}>
    <header><strong>코드 변경</strong><span className="code-task" title={title}>{title}</span><button aria-label="코드 새로고침" title="현재 변경 다시 읽기" disabled={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={16}/></button><button aria-label="코드 창 닫기" onClick={onClose}><X size={16}/></button></header>
    <div className="code-scope-bar">
      <select aria-label="변경 기준" value={base&&target?'__branches':commit} onChange={e=>{
        setCommit(e.target.value);setBase('');setTarget('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);
      }}>
        <option value="">미커밋 변경</option>{base&&target&&<option value="__branches">브랜치 비교 중</option>}
        {commit&&!history.some(item=>item.id===commit)&&<option value={commit}>{commit.slice(0,12)}</option>}
        {history.map(item=><option key={item.id} value={item.id}>{item.id.slice(0,8)} · {item.subject}</option>)}
      </select>
      {!!branches.length&&<details className="code-branches"><summary><GitCompare size={14}/>브랜치 비교</summary><div className="code-branch-pick">
        <select aria-label="기준 브랜치" value={base} onChange={e=>{setBase(e.target.value);setCommit('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);}}><option value="">기준 선택</option>{branches.map(item=><option key={item.ref} value={item.ref}>{branchLabel(item.ref)}</option>)}</select>
        <span>→</span>
        <select aria-label="대상 브랜치" value={target} onChange={e=>{setTarget(e.target.value);setCommit('');setSnapshot(undefined);setContent(undefined);setSelected(undefined);setRevision(n=>n+1);}}><option value="">대상 선택</option>{branches.map(item=><option key={item.ref} value={item.ref}>{branchLabel(item.ref)}</option>)}</select>
      </div><small>기준 → 대상의 파일 차이입니다. 원격 브랜치는 마지막으로 받아온 상태이며 자동 fetch하지 않습니다.</small></details>}
      {stats&&<span className="code-stats" aria-label="비교 범위 변경량">{snapshot!.data.files.length}개 파일 <b className="add">+{stats.added}</b> <b className="del">−{stats.deleted}</b>{stats.binary>0&&` · 바이너리 ${stats.binary}개`}{stats.unknown>0&&` · 미집계 ${stats.unknown}개 (합계 제외)`}</span>}
    </div>
    <div className="code-scope"><span className="code-root" title={snapshot?.data.root}>{snapshot?.data.root??'작업 폴더 확인 중…'}</span>
      {!!worktrees.length&&<select aria-label="코드 worktree" value={worktree??sessionWorktree} onChange={e=>changeWorktree(e.target.value===sessionWorktree?null:e.target.value)}><option value="">{snapshot?.data.registeredWorktree?`등록된 작업 폴더 · ${snapshot.data.registeredWorktree}`:'작업 세션 폴더'}</option>{(worktree===null||snapshot?.data.registeredWorktree)&&<option value={sessionWorktree}>세션 작업 폴더</option>}{worktrees.map(item=><option key={item.path} value={item.path}>{item.path} {item.branch?'· '+item.branch.replace('refs/heads/',''):''}</option>)}</select>}
      <small>{base&&target?`${base.replace(/^refs\/(heads|remotes)\//,'')} (${(content?.baseId??snapshot?.data.baseId??'').slice(0,12)}) → ${target.replace(/^refs\/(heads|remotes)\//,'')} (${(content?.targetId??snapshot?.data.targetId??'').slice(0,12)})`:`${commit?'첫 번째 부모 대비':'HEAD 대비 미커밋'} · ${(commit||content?.head||snapshot?.data.head)?.slice(0,12)??'첫 커밋 전'}`} · 읽기 전용</small></div>
    {listError&&<p role="alert">목록 갱신 실패: {listError}{snapshot?' · 마지막으로 읽은 목록입니다.':''}</p>}
    {listError===REGISTERED_WORKTREE_UNAVAILABLE&&<button onClick={()=>changeWorktree(null)}>세션 작업 폴더 보기</button>}
    <div className="code-main">
      <nav className="code-files" aria-label="변경 파일">
        {snapshot&&snapshot.data.files.length>6&&<input className="code-file-filter" aria-label="파일 찾기" placeholder="파일 찾기" value={filter} onChange={e=>setFilter(e.target.value)}/>}
        {!snapshot?.data.files.length&&!listing&&<p>변경 파일 없음</p>}
        {shown.map(([folder,items])=><div key={folder} className="code-dir">
          {folder&&<div className="code-dir-name" title={folder}>{folder}</div>}
          {items.map(item=><button key={keyOf(item)} type="button" className="code-file" aria-pressed={keyOf(item)===selected} data-file-key={keyOf(item)} title={item.path} onClick={()=>choose(item)}>
            <span className={`code-status ${item.status}`} aria-label={STATUS[item.status][1]}>{STATUS[item.status][0]}</span><span className="code-file-name">{fileName(item)}</span>{counts(item)}
          </button>)}
        </div>)}
      </nav>
      <section className="code-view">
        {file&&<div className="code-file-head">
          <button aria-label="이전 파일" title="이전 파일 ([)" disabled={position<=0} onClick={()=>choose(ordered[position-1])}><ChevronUp size={15}/></button>
          <button aria-label="다음 파일" title="다음 파일 (])" disabled={position<0||position>=ordered.length-1} onClick={()=>choose(ordered[position+1])}><ChevronDown size={15}/></button>
          <span className="code-path" title={file.path}>{file.path.includes('/')&&<span>{file.path.slice(0,file.path.lastIndexOf('/')+1)}</span>}<b>{fileName(file)}</b></span>
          <small>{position+1} / {ordered.length}</small>{counts(file)}
          {hunks.length>1&&<span className="code-hunks"><button aria-label="이전 헝크" title="이전 헝크 (p)" disabled={hunk<=0} onClick={()=>goHunk(-1)}><ChevronUp size={15}/></button><small>헝크 {hunk+1} / {hunks.length}</small><button aria-label="다음 헝크" title="다음 헝크 (n)" disabled={hunk>=hunks.length-1} onClick={()=>goHunk(1)}><ChevronDown size={15}/></button></span>}
          <button aria-label="긴 줄 줄바꿈" aria-pressed={wrap} title="긴 줄 줄바꿈" onClick={()=>setDiffWrap(!wrap)}><WrapText size={15}/></button>
        </div>}
        {error&&<p role="alert">{error}</p>}
        {loading&&<p role="status">변경을 불러오는 중…</p>}
        <div className="code-diff-area">
          <div className={`${wrap?'code-diff wrap':'code-diff'}${onQuote?' pickable':''}`} ref={scroll} tabIndex={0} aria-label="파일 diff" onScroll={followHunk}
            onPointerDown={e=>{
              if(!onQuote||e.button!==0||!content)return;
              const index=rowAt(e.target);
              if(index<0||rows[index]?.kind==='header')return;
              e.preventDefault();scroll.current?.focus({preventScroll:true});
              const anchor=e.shiftKey&&active?active.anchor:index;
              dragFrom.current=anchor;setRange({source:content,anchor,end:index});
            }}
            onPointerOver={e=>{
              if(dragFrom.current===null||!(e.buttons&1)||!content)return;
              const index=rowAt(e.target);
              if(index>=0)setRange({source:content,anchor:dragFrom.current,end:index});
            }}>
            {!loading&&!error&&!listError&&!snapshot?.data.files.length&&<p>{base&&target?'두 브랜치 사이에 변경된 파일이 없습니다.':commit?'이 커밋에서 변경된 파일이 없습니다.':'미커밋 변경이 없습니다.'}</p>}
            {content?.binary?<p>바이너리 파일은 코드 diff를 표시하지 않습니다.</p>:rows.slice(0,limit).map((row,index)=>{
              const html=row.kind!=='header'&&lang&&hljs.getLanguage(lang)&&row.text.length<8000
                ?hljs.highlight(row.text,{language:lang,ignoreIllegals:true}).value:undefined;
              return <div key={index} data-diff-row={index} className={`code-line ${row.kind}${index>=start && index<=end?' quoted':''}`}><span className="code-number">{row.old??''}</span><span className="code-number">{row.next??''}</span><span className="code-sign">{row.kind==='add'?'+':row.kind==='delete'?'-':''}</span>{html===undefined?<code>{row.text||' '}</code>:<code dangerouslySetInnerHTML={{__html:html||' '}}/>}</div>;
            })}
            {rows.length>limit&&<button className="code-more" onClick={()=>setLimit(n=>n+200)}>다음 200줄 표시 ({rows.length-limit}줄 남음)</button>}
          </div>
          {marks.length>0&&<div className="code-minimap" aria-hidden onClick={e=>{
            const box=e.currentTarget.getBoundingClientRect();
            reveal(Math.max(0,Math.min(rows.length-1,Math.floor(rows.length*(e.clientY-box.top)/box.height))));
          }}>{marks}</div>}
        </div>
        {onQuote&&onSend&&(active
          ?<CodeActions taskId={taskId} quote={selectedQuote()} count={picked.length} range={`${file?fileName(file):''} ${pickedRange()}`.trim()}
            onQuote={text=>{onQuote(text);setRange(undefined);}} onSend={onSend} onClear={()=>setRange(undefined)}
            onCopy={control=>writeClipboardText(picked.map(row=>row.text).join('\n'),control)}/>
          :!!rows.length&&<p className="code-hint"><Quote size={13}/>줄을 드래그해 고르면 답글에 인용하거나 바로 보낼 수 있습니다</p>)}
      </section>
    </div>
  </aside>;
});
