import { MAX_DIAGRAM_TEXT, type DiagramResult } from './mermaidProtocol.ts';
import { createDiagramQueue, DiagramBusyError, renderMermaid } from './mermaid.ts';

const requestInQueue=createDiagramQueue(2,32);
const RETRY_DELAYS=[1000,2000,4000];
const TIMEOUT_RETRY_WINDOW=15_000;
class DiagramTimeoutError extends DiagramBusyError {}
let unavailableUntil=0;

/** Prefer shared hub results. Older hubs or hubs without Chromium retain the existing local renderer. */
export async function renderDiagram(source:string,signal?:AbortSignal):Promise<DiagramResult> {
  signal?.throwIfAborted();
  if(source.length>MAX_DIAGRAM_TEXT)throw new Error('도표가 너무 커서 원문으로 표시합니다.');
  if(Date.now()>=unavailableUntil){
    const result=await retryBusy(lastAttempt=>requestInQueue(()=>requestHub(source,lastAttempt,signal),signal),signal);
    if(result)return result;
  }
  return retryBusy(()=>renderMermaid(source,signal),signal);
}

async function retryBusy<T>(render:(lastAttempt:boolean)=>Promise<T>,signal?:AbortSignal):Promise<T> {
  const timeoutRetryUntil=Date.now()+TIMEOUT_RETRY_WINDOW;
  for(let attempt=0;;attempt++){
    const delay=RETRY_DELAYS[attempt];
    try{return await render(delay===undefined);}
    catch(error){
      if(!(error instanceof DiagramBusyError)||delay===undefined)throw error;
      signal?.throwIfAborted();
      // A quick gateway timeout can clear, but a full hub render timeout has already spent the retry window.
      if(error instanceof DiagramTimeoutError&&Date.now()+delay>=timeoutRetryUntil)throw error;
      await new Promise<void>((resolve,reject)=>{
        const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
        const timer=setTimeout(done,delay);
        const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
        signal?.addEventListener('abort',abort,{once:true});
      });
    }
  }
}

async function requestHub(source:string,lastAttempt:boolean,signal?:AbortSignal):Promise<DiagramResult|undefined> {
  if(Date.now()<unavailableUntil)return;
  const controller=new AbortController();
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const deadline=setTimeout(()=>controller.abort(new Error('도표 요청 시간이 초과됐습니다.')),45_000);
  try {
    let response:Response;
    try {
      response=await fetch('/api/diagram',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source}),signal:controller.signal});
    }catch{
      controller.signal.throwIfAborted();
      unavailableUntil=Date.now()+30_000;
      return;
    }
    controller.signal.throwIfAborted();
    if(response.status===404||response.status===503&&lastAttempt){
      void response.body?.cancel().catch(()=>{});
      unavailableUntil=Date.now()+30_000;
      return;
    }
    if(response.status===429||response.status===503||response.status===504){
      const data=await response.json().catch(()=>undefined);
      controller.signal.throwIfAborted();
      const message=data?.error??'허브 도표 요청을 일시적으로 처리할 수 없습니다.';
      if(response.status===504)throw new DiagramTimeoutError(message);
      throw new DiagramBusyError(message);
    }
    const data=await response.json();
    if(!response.ok)throw new Error(data.error??'도표를 그리지 못했습니다.');
    if(typeof data.image!=='string'||!data.image.startsWith('data:image/svg+xml;')||typeof data.background!=='string')throw new Error('도표 응답이 올바르지 않습니다.');
    return data;
  }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);}
}
