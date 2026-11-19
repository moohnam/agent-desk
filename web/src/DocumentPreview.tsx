import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, RotateCw, Shield, ShieldCheck, X } from 'lucide-react';
import { api } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { previewLink } from './documentLinks.ts';
import { DocumentLink } from './DocumentLink.tsx';
import { splitId } from './federation.ts';
import { ReferenceMoveButtons } from './ReferenceMoveButtons.tsx';
import { CopyButton } from './CopyButton.tsx';
import { InteractiveDocument } from './InteractiveDocument.tsx';

const releasePreview=(url:string)=>fetch('/api/preview',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:url.split('/')[2]}),keepalive:true}).catch(()=>{});
class PermissionRequired extends Error { constructor(readonly path:string) { super('문서 접근 확인이 필요합니다'); } }
type Preview = {name:string;url:string;kind:'html'|'markdown';text?:string;identity?:string;scriptVersion?:string};
const scriptKey = (scope:string) => 'agent-desk.document-script.v1:' + scope;
function savedScript(scope:string) {
  try { return localStorage.getItem(scriptKey(scope)); } catch { return null; }
}
function saveScript(scope:string,version?:string) {
  try { if (version) localStorage.setItem(scriptKey(scope), version); else localStorage.removeItem(scriptKey(scope)); } catch { /* Private storage is optional. */ }
}
type PreviewRequest = {revision:number;refresh:boolean};
export const DocumentPreview = memo(function DocumentPreview({taskId,href,visible,focusRevision=0,first,last,onMove,onResolve,onRemove,onError}: {
  taskId:string; href:string; visible:boolean; focusRevision?:number; first:boolean; last:boolean;
  onMove:(href:string,direction:-1|1)=>void; onResolve:(href:string,identity:string|undefined)=>void;
  onRemove:(href:string)=>void; onError:(message:string)=>void;
}) {
  const openLink=useCallback((path:string)=>{if(!previewLink(taskId,path))void api.open(path,taskId).catch((e:Error)=>onError(e.message));},[taskId,onError]);
  const remove=useCallback(()=>onRemove(href),[href,onRemove]);
  const scope=JSON.stringify([taskId,href]);
  const [script,setScript]=useState<{scope:string;version:string}|null>(null);
  const [scriptError,setScriptError]=useState('');
  const [approval,setApproval]=useState<{scope:string;path:string}|null>(null);
  const [permission,setPermission]=useState<{scope:string;path:string}|null>(null);
  const approvedPath=approval?.scope===scope?approval.path:undefined;
  const requestedPath=permission?.scope===scope?permission.path:undefined;
  const [preview,setPreview]=useState<(Preview&{request:PreviewRequest})|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [request,setRequest]=useState<PreviewRequest>({revision:0,refresh:false});
  const [ready,setReady]=useState(false),[frameReady,setFrameReady]=useState(false);
  const latestRequest=useRef(request);
  useLayoutEffect(()=>{latestRequest.current=request;},[request]);
  const ref=useRef<HTMLElement>(null);
  const revealed=useRef('');
  useLayoutEffect(()=>{setApproval(null);setPermission(null);setPreview(null);setScript(null);setScriptError('');},[scope]);
  // Explicit opens read the source again. Passive mounts and expired leases reuse the hub copy.
  useLayoutEffect(()=>{
    const choice=JSON.stringify([scope,focusRevision]);
    if(!visible||!focusRevision||revealed.current===choice)return;
    revealed.current=choice;
    setRequest(value=>({revision:value.revision+1,refresh:true}));
    setReady(true);
  },[scope,focusRevision,visible]);
  useEffect(()=>{
    if(!visible||frameReady||!ref.current)return;
    if(typeof IntersectionObserver==='undefined'){setReady(true);setFrameReady(true);return;}
    let alive=true;
    const observer=new IntersectionObserver(entries=>{
      if(!alive||!entries.some(entry=>entry.isIntersecting))return;
      setReady(true);setFrameReady(true);observer.disconnect();
    },{root:ref.current.closest('.reference-feed'),rootMargin:'100px'});
    observer.observe(ref.current);
    return()=>{alive=false;observer.disconnect();};
  },[visible,frameReady]);
  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController();let alive=true;
    onResolve(href,undefined);
    const [source,task]=splitId(taskId);setLoading(true);setError('');setPermission(null);
    void fetch('/api/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,task_id:task,href,refresh:request.refresh,...(approvedPath!==undefined?{approved_path:approvedPath}:{})}),signal:controller.signal})
      .then(async r=>{const data=await r.json();if(!r.ok){
        if(r.status===403&&data.code==='document_permission_required'&&typeof data.path==='string'&&data.path.startsWith('/')&&data.path.length<=4096&&!/[\x00-\x1f]/.test(data.path))throw new PermissionRequired(data.path);
        throw Error(data.error??`HTTP ${r.status}`);
      }return data as Preview;})
      .then(data=>{
        if(!alive){void releasePreview(data.url);return;}
        const saved=savedScript(scope);
        if(saved && data.scriptVersion && saved!==data.scriptVersion) saveScript(scope);
        setScript(previous=>saved && saved===data.scriptVersion ? {scope,version:saved}
          : previous?.scope===scope&&previous.version===data.scriptVersion ? previous : null);
        setScriptError('');
        setPreview({...data,request});
      },e=>{if(alive){if(e instanceof PermissionRequired){setPermission({scope,path:e.path});setPreview(null);}else setError(e instanceof Error?e.message:String(e));}})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;controller.abort();};
  },[taskId,href,ready,request,approvedPath,scope,onResolve]);
  useEffect(()=>()=>{if(preview)void releasePreview(preview.url);},[preview]);
  useEffect(()=>{
    if(preview?.request===request&&typeof preview.identity==='string')onResolve(href,preview.identity);
  },[preview,request,href,onResolve]);
  useEffect(()=>{
    if(!preview||!visible)return;
    const controller=new AbortController();let pending=false,expired=false;
    const renew=async()=>{
      if(pending||expired||document.hidden||latestRequest.current!==preview.request)return;
      pending=true;
      try {
        const response=await fetch('/api/preview',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id:preview.url.split('/')[2]}),signal:controller.signal});
        // Older hubs have no lease endpoint (404); only a known expired lease (409) needs renewal.
        if(response.status===409&&!controller.signal.aborted&&latestRequest.current===preview.request){
          expired=true;setRequest(value=>({revision:value.revision+1,refresh:false}));
        }
      }catch{/* Reconnection or returning to this tab retries the lease. */}
      finally{pending=false;}
    };
    void renew();const timer=setInterval(()=>{void renew();},30_000);
    const resume=()=>{void renew();};document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
  },[preview,visible]);
  const refresh=useCallback(()=>{setReady(true);setRequest(value=>({revision:value.revision+1,refresh:true}));},[]);
  const changed=useCallback(()=>{saveScript(scope);setScript(null);refresh();},[scope,refresh]);
  const scriptEnabled=!!preview?.scriptVersion&&script?.scope===scope&&script.version===preview.scriptVersion;
  const runningScript=scriptEnabled&&!scriptError&&preview?.request===request&&visible;
  useEffect(()=>{
    const update=(event:StorageEvent)=>{
      if(event.key!==null&&event.key!==scriptKey(scope))return;
      setScript(null);
    };
    window.addEventListener('storage',update);
    return()=>window.removeEventListener('storage',update);
  },[scope]);
  const toggleScript=()=>{
    const version=preview?.scriptVersion;
    if(!version||preview.request!==request)return;
    if(scriptEnabled){saveScript(scope);setScript(null);setScriptError('');return;}
    saveScript(scope,version);setScript({scope,version});setScriptError('');
  };
  const scriptLabel=scriptEnabled?'이 문서의 JS 실행 허용 취소':'이 문서에서 JS 실행';
  return <section ref={ref} className="reference-card document-card">
    <div className="reference-tools"><FileText/><DocumentLink path={href} taskId={taskId} previewId={preview?.url.split('/')[2]} onPreview={()=>openLink(href)}><strong>{preview?.name??href.split('/').at(-1)}</strong></DocumentLink><span className="spacer"/>
      {preview?.kind === 'markdown' && typeof preview.text === 'string' && <CopyButton text={preview.text} label="문서 Markdown 원문 복사" onNotice={onError} />}
      <ReferenceMoveButtons first={first} last={last} onMove={direction=>onMove(href,direction)}/>
      <button className="icon-btn" title="원본 파일 다시 가져오기" aria-label="문서 새로고침" disabled={loading} onClick={refresh}><RotateCw/></button>
      {preview?.scriptVersion&&<button className="icon-btn document-script-toggle" aria-pressed={scriptEnabled}
        title={scriptLabel} aria-label={scriptLabel} disabled={loading||preview.request!==request} onClick={toggleScript}>
        {scriptEnabled?<ShieldCheck/>:<Shield/>}
      </button>}
      <button className="icon-btn" title="문서 닫기" aria-label="문서 닫기" onClick={remove}><X/></button>
    </div>
    {loading&&<p className="muted" role="status">문서를 불러오는 중…</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {scriptError&&<p className="error" role="status">{scriptError}</p>}
    {requestedPath&&!loading&&<div role="group" aria-label="문서 접근 확인">
      <p>프로젝트 밖의 문서입니다. 아래 실제 파일 한 개를 이 작업에서 열도록 허용할까요?</p>
      <p><code style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{requestedPath}</code></p>
      <p className="muted small">주변 폴더와 HTML의 부속 파일은 허용하지 않습니다.</p>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={()=>{setApproval({scope,path:requestedPath});setRequest(value=>({revision:value.revision+1,refresh:true}));}}>이 파일만 허용</button>
        <button type="button" className="btn" onClick={remove}>취소</button>
      </div>
    </div>}
    {preview?.kind==='html'&&frameReady&&(runningScript
      ? <InteractiveDocument key={preview.url} id={preview.url.split('/')[2]} version={preview.scriptVersion!} title={preview.name}
          onChanged={changed} onFailure={setScriptError}/>
      : <iframe title={preview.name} src={preview.url} sandbox="" referrerPolicy="no-referrer" className="document-frame"/>)}
    {preview?.kind==='html'&&!frameReady&&<div className="document-frame"/>}
    {preview?.kind==='markdown'&&<div className="body md"><Markdown text={preview.text??''} resourceBase={preview.url} taskId={taskId} linkBase={href}
      onLocalLink={openLink} onNotice={onError}/></div>}
  </section>;
});
