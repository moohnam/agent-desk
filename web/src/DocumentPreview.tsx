import { useEffect, useRef, useState } from 'react';
import { FileText, RotateCw, X } from 'lucide-react';
import { api } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { previewLink } from './documentLinks.ts';
import { splitId } from './federation.ts';

const releasePreview=(url:string)=>fetch('/api/preview',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:url.split('/')[2]}),keepalive:true}).catch(()=>{});
type Preview = {name:string;url:string;kind:'html'|'markdown';text?:string};
export function DocumentPreview({taskId,href,visible,onRemove,onError}:{taskId:string;href:string;visible:boolean;onRemove:()=>void;onError:(message:string)=>void}) {
  const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [request,setRequest]=useState({revision:0,refresh:false}),[ready,setReady]=useState(false),[near,setNear]=useState(false);
  const ref=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(!visible){setNear(false);return;}
    if(!ref.current)return;
    if(typeof IntersectionObserver==='undefined'){setReady(true);setNear(true);return;}
    const observer=new IntersectionObserver(entries=>{const inside=entries.some(e=>e.isIntersecting);setNear(inside);if(inside)setReady(true);}, {root:ref.current.closest('.reference-feed'),rootMargin:'100px'});
    observer.observe(ref.current);return()=>observer.disconnect();
  },[visible]);
  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController();let alive=true;
    const [source,task]=splitId(taskId);setLoading(true);setError('');
    void fetch('/api/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,task_id:task,href,refresh:request.refresh}),signal:controller.signal})
      .then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error??`HTTP ${r.status}`);return data as Preview;})
      .then(data=>{if(alive)setPreview(data);else void releasePreview(data.url);},e=>{if(alive)setError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;controller.abort();};
  },[taskId,href,ready,request]);
  useEffect(()=>()=>{if(preview)void releasePreview(preview.url);},[preview]);
  useEffect(()=>{
    if(!preview||!visible)return;
    const controller=new AbortController();let pending=false,expired=false;
    const renew=async()=>{
      if(pending||expired||document.hidden)return;
      pending=true;
      try {
        const response=await fetch('/api/preview',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id:preview.url.split('/')[2]}),signal:controller.signal});
        // Older hubs have no lease endpoint (404); only a known expired lease (409) needs renewal.
        if(response.status===409&&!controller.signal.aborted){
          expired=true;setRequest(value=>({revision:value.revision+1,refresh:false}));
        }
      }catch{/* Reconnection or returning to this tab retries the lease. */}
      finally{pending=false;}
    };
    void renew();const timer=setInterval(()=>{void renew();},30_000);
    const resume=()=>{void renew();};document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
  },[preview,visible]);
  const relative=(value:string)=>{
    if(/^[a-z][a-z\d+.-]*:/i.test(value)||value.startsWith('//')||value.startsWith('/')||value.startsWith('~'))return value;
    return href.replace(/[^/]*$/,'')+value;
  };
  return <section ref={ref} className="reference-card document-card">
    <div className="reference-tools"><FileText/><strong title={href}>{preview?.name??href.split('/').at(-1)}</strong><span className="spacer"/>
      <button className="icon-btn" title="원본 파일 다시 가져오기" aria-label="문서 새로고침" disabled={loading} onClick={()=>{setReady(true);setRequest(value=>({revision:value.revision+1,refresh:true}));}}><RotateCw/></button>
      <button className="icon-btn" title="문서 닫기" aria-label="문서 닫기" onClick={onRemove}><X/></button>
    </div>
    {loading&&<p className="muted" role="status">문서를 불러오는 중…</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {preview?.kind==='html'&&visible&&near&&<iframe title={preview.name} src={preview.url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="document-frame"/>}
    {preview?.kind==='html'&&(!visible||!near)&&<div className="document-frame"/>}
    {preview?.kind==='markdown'&&<div className="body md"><Markdown text={preview.text??''} resourceBase={preview.url}
      onLocalLink={value=>{const path=relative(value);if(!previewLink(taskId,path))void api.open(path,taskId).catch((e:Error)=>onError(e.message));}}/></div>}
  </section>;
}
