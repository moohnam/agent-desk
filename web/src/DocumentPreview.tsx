import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, RotateCw, X } from 'lucide-react';
import { api } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { previewLink } from './documentLinks.ts';
import { splitId } from './federation.ts';

const releasePreview=(url:string)=>fetch('/api/preview',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:url.split('/')[2]}),keepalive:true}).catch(()=>{});
class PermissionRequired extends Error { constructor(readonly path:string) { super('문서 접근 확인이 필요합니다'); } }
type Preview = {name:string;url:string;kind:'html'|'markdown';text?:string};
type PreviewRequest = {revision:number;refresh:boolean};
export const DocumentPreview = memo(function DocumentPreview({taskId,href,visible,focusRevision=0,onRemove,onError}:{taskId:string;href:string;visible:boolean;focusRevision?:number;onRemove:(href:string)=>void;onError:(message:string)=>void}) {
  const openLink=useCallback((path:string)=>{if(!previewLink(taskId,path))void api.open(path,taskId).catch((e:Error)=>onError(e.message));},[taskId,onError]);
  const remove=useCallback(()=>onRemove(href),[href,onRemove]);
  const scope=JSON.stringify([taskId,href]);
  const [approval,setApproval]=useState<{scope:string;path:string}|null>(null);
  const [permission,setPermission]=useState<{scope:string;path:string}|null>(null);
  const approvedPath=approval?.scope===scope?approval.path:undefined;
  const requestedPath=permission?.scope===scope?permission.path:undefined;
  const [preview,setPreview]=useState<(Preview&{request:PreviewRequest})|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [request,setRequest]=useState({revision:0,refresh:true}),[ready,setReady]=useState(false),[near,setNear]=useState(false);
  const latestRequest=useRef(request);
  useLayoutEffect(()=>{latestRequest.current=request;},[request]);
  const ref=useRef<HTMLElement>(null);
  const revealed=useRef('');
  useLayoutEffect(()=>{setApproval(null);setPermission(null);setPreview(null);},[scope]);
  // An explicit open reads the source again, including an already mounted or failed card.
  // Visibility changes and lease renewal can still reuse the existing preview.
  useLayoutEffect(()=>{
    const choice=JSON.stringify([scope,focusRevision]);
    if(!visible||!focusRevision||revealed.current===choice)return;
    revealed.current=choice;
    setRequest(value=>({revision:value.revision+1,refresh:true}));
    setReady(true);
  },[scope,focusRevision,visible]);
  useEffect(()=>{
    if(!visible)return;
    if(!ref.current)return;
    if(typeof IntersectionObserver==='undefined'){setReady(true);setNear(true);return;}
    const observer=new IntersectionObserver(entries=>{const inside=entries.some(e=>e.isIntersecting);setNear(inside);if(inside)setReady(true);}, {root:ref.current.closest('.reference-feed'),rootMargin:'100px'});
    observer.observe(ref.current);return()=>observer.disconnect();
  },[visible]);
  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController();let alive=true;
    const [source,task]=splitId(taskId);setLoading(true);setError('');setPermission(null);
    void fetch('/api/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,task_id:task,href,refresh:request.refresh,...(approvedPath!==undefined?{approved_path:approvedPath}:{})}),signal:controller.signal})
      .then(async r=>{const data=await r.json();if(!r.ok){
        if(r.status===403&&data.code==='document_permission_required'&&typeof data.path==='string'&&data.path.startsWith('/')&&data.path.length<=4096&&!/[\x00-\x1f]/.test(data.path))throw new PermissionRequired(data.path);
        throw Error(data.error??`HTTP ${r.status}`);
      }return data as Preview;})
      .then(data=>{if(alive)setPreview({...data,request});else void releasePreview(data.url);},e=>{if(alive){if(e instanceof PermissionRequired){setPermission({scope,path:e.path});setPreview(null);}else setError(e instanceof Error?e.message:String(e));}})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;controller.abort();};
  },[taskId,href,ready,request,approvedPath,scope]);
  useEffect(()=>()=>{if(preview)void releasePreview(preview.url);},[preview]);
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
  return <section ref={ref} className="reference-card document-card">
    <div className="reference-tools"><FileText/><strong title={href}>{preview?.name??href.split('/').at(-1)}</strong><span className="spacer"/>
      <button className="icon-btn" title="원본 파일 다시 가져오기" aria-label="문서 새로고침" disabled={loading} onClick={()=>{setReady(true);setRequest(value=>({revision:value.revision+1,refresh:true}));}}><RotateCw/></button>
      <button className="icon-btn" title="문서 닫기" aria-label="문서 닫기" onClick={remove}><X/></button>
    </div>
    {loading&&<p className="muted" role="status">문서를 불러오는 중…</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {requestedPath&&!loading&&<div role="group" aria-label="문서 접근 확인">
      <p>프로젝트 밖의 문서입니다. 아래 실제 파일 한 개를 이 작업에서 열도록 허용할까요?</p>
      <p><code style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{requestedPath}</code></p>
      <p className="muted small">주변 폴더와 HTML의 부속 파일은 허용하지 않습니다.</p>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={()=>{setApproval({scope,path:requestedPath});setRequest(value=>({revision:value.revision+1,refresh:true}));}}>이 파일만 허용</button>
        <button type="button" className="btn" onClick={remove}>취소</button>
      </div>
    </div>}
    {preview?.kind==='html'&&near&&<iframe title={preview.name} src={preview.url} sandbox="" referrerPolicy="no-referrer" className="document-frame"/>}
    {preview?.kind==='html'&&!near&&<div className="document-frame"/>}
    {preview?.kind==='markdown'&&<div className="body md"><Markdown text={preview.text??''} resourceBase={preview.url} taskId={taskId} linkBase={href}
      onLocalLink={openLink}/></div>}
  </section>;
});
