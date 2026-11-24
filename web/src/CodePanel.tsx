import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { api } from './api.ts';
import { diffLines, type CodeViewResult } from '../../shared/code-view.ts';
import './code-panel.css';
const language = (path: string) => ({ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',rb:'ruby',rs:'rust',go:'go',sh:'bash',yml:'yaml',yaml:'yaml',json:'json',css:'css',html:'xml',md:'markdown',sql:'sql',c:'c',h:'c',cpp:'cpp',java:'java'} as Record<string,string>)[path.split('.').at(-1)??''];
export const CodePanel = memo(function CodePanel({taskId,title,onClose}:{taskId:string;title:string;onClose:()=>void}) {
  const [snapshot,setSnapshot]=useState<CodeViewResult>();
  const [path,setPath]=useState<string>();
  const [content,setContent]=useState<CodeViewResult>();
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [revision,setRevision]=useState(0);
  const [limit,setLimit]=useState(200);
  const attempt=useRef(0);
  const scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const controller=new AbortController(),token=++attempt.current;
    setLoading(true);setError('');
    void api.codeView(taskId,undefined,controller.signal).then(async list=>{
      if(token!==attempt.current)return;
      setSnapshot(list);
      const selected=path&&list.files.some(file=>file.path===path)?path:list.files[0]?.path;
      if(selected!==path){setContent(undefined);setPath(selected);return;}
      const result=selected?await api.codeView(taskId,selected,controller.signal):undefined;
      if(token===attempt.current){setContent(result);if(result)setSnapshot(result);}
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(token===attempt.current)setLoading(false);});
    return()=>controller.abort();
  },[taskId,path,revision]);
  useEffect(()=>{setLimit(200);if(scroll.current)scroll.current.scrollTop=0;},[path]);
  const rows=useMemo(()=>diffLines(content?.diff??''),[content]);
  const lang=path&&language(path);
  return <aside className="code-panel" aria-label="코드 변경 보기" onKeyDown={e=>e.stopPropagation()}>
    <header><strong title={title}>코드 변경 · {title}</strong><button aria-label="코드 새로고침" title="현재 변경 다시 읽기" disabled={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={16}/></button><button aria-label="코드 창 닫기" onClick={onClose}><X size={16}/></button></header>
    <div className="code-scope">작업 폴더 전체 · HEAD 대비 미커밋 변경<br/><span title={snapshot?.root}>{snapshot?.root??'작업 폴더 확인 중…'}</span><small>기준 {snapshot?.head?.slice(0,12)??'첫 커밋 전'} · 읽기 전용</small></div>
    {error&&<p role="alert">{error}</p>}
    <select aria-label="변경 파일" value={path??''} onChange={e=>{setContent(undefined);setPath(e.target.value);}} disabled={!snapshot?.files.length}>
      {!snapshot?.files.length&&<option value="">변경 파일 없음</option>}
      {snapshot?.files.map(file=><option key={file.path} value={file.path}>{({untracked:'[새 파일] ',added:'[추가] ',deleted:'[삭제] ',modified:'[수정] '})[file.status]}{file.path}</option>)}
    </select>
    {loading&&<p role="status">변경을 불러오는 중…</p>}
    <div className="code-diff" ref={scroll} tabIndex={0} aria-label="파일 diff">
      {!loading&&!error&&!snapshot?.files.length&&<p>미커밋 변경이 없습니다.</p>}
      {content?.binary?<p>바이너리 파일은 코드 diff를 표시하지 않습니다.</p>:rows.slice(0,limit).map((row,index)=>{
        const html=row.kind!=='header'&&lang&&hljs.getLanguage(lang)&&row.text.length<8000
          ?hljs.highlight(row.text,{language:lang,ignoreIllegals:true}).value:undefined;
        return <div key={index} className={`code-line ${row.kind}`}><span className="code-number">{row.old??''}</span><span className="code-number">{row.next??''}</span><span className="code-sign">{row.kind==='add'?'+':row.kind==='delete'?'-':''}</span>{html===undefined?<code>{row.text||' '}</code>:<code dangerouslySetInnerHTML={{__html:html||' '}}/>}</div>;
      })}
      {rows.length>limit&&<button className="code-more" onClick={()=>setLimit(n=>n+200)}>다음 200줄 표시 ({rows.length-limit}줄 남음)</button>}
    </div>
  </aside>;
});
