import { MAX_DIAGRAM_TEXT, type DiagramResult } from './mermaidProtocol.ts';
import { renderMermaid } from './mermaid.ts';

let unavailableUntil=0;

/** Prefer shared hub results. Older hubs or hubs without Chromium retain the existing local renderer. */
export async function renderDiagram(source:string,signal?:AbortSignal):Promise<DiagramResult> {
  signal?.throwIfAborted();
  if(source.length>MAX_DIAGRAM_TEXT)throw new Error('도표가 너무 커서 원문으로 표시합니다.');
  if(Date.now()<unavailableUntil)return renderMermaid(source,signal);
  const controller=new AbortController();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const deadline=setTimeout(()=>controller.abort(new Error('도표 요청 시간이 초과됐습니다.')),45_000);
  let fallback=false;
  try {
    let response:Response;
    try {
      response=await fetch('/api/diagram',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source}),signal:controller.signal});
    }catch(error){
      signal?.throwIfAborted();
      if(controller.signal.aborted)throw controller.signal.reason;
      fallback=true;throw error;
    }
    if(response.status===404||response.status===503){fallback=true;throw new Error('허브 렌더러를 사용할 수 없습니다');}
    const data=await response.json();
    if(!response.ok)throw new Error(data.error??'도표를 그리지 못했습니다.');
    if(typeof data.image!=='string'||!data.image.startsWith('data:image/svg+xml;')||typeof data.background!=='string')throw new Error('도표 응답이 올바르지 않습니다.');
    return data;
  }catch(error){
    if(!fallback)throw error;
    unavailableUntil=Date.now()+30_000;
  }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
  return renderMermaid(source,signal);
}
