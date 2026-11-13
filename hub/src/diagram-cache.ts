import { createHash } from 'node:crypto';
import { MAX_DIAGRAM_TEXT, type DiagramResult } from '../../shared/diagram.ts';
import { HttpError } from './errors.ts';

const TTL = 24 * 60 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
type Cached = { result:DiagramResult; at:number; bytes:number };
type Job = { result:Promise<DiagramResult>; readers:number; controller:AbortController };

/** One render at a time, shared work for identical input, and a bounded in-memory SVG LRU. */
export class DiagramCache {
  private cache = new Map<string,Cached>();
  private jobs = new Map<string,Job>();
  private queue:Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private stopped = false;
  private timer = setInterval(()=>this.expire(),60_000);
  private draw:(source:string,signal:AbortSignal)=>Promise<DiagramResult>;
  constructor(draw:(source:string,signal:AbortSignal)=>Promise<DiagramResult>) {this.draw=draw;this.timer.unref();}
  private remove(key:string) {const prior=this.cache.get(key);if(prior)this.bytes-=prior.bytes;this.cache.delete(key);}
  private expire() {for(const [key,value] of this.cache)if(Date.now()-value.at>=TTL)this.remove(key);}
  async render(source:string,version:string,signal?:AbortSignal) {
    if(source.length>MAX_DIAGRAM_TEXT)throw new HttpError(413,'도표가 너무 큽니다');
    signal?.throwIfAborted();
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    this.expire();
    const key=createHash('sha256').update(version).update('\0').update(source).digest('hex');
    const cached=this.cache.get(key);
    if(cached){cached.at=Date.now();this.cache.delete(key);this.cache.set(key,cached);return cached.result;}
    let job=this.jobs.get(key);
    if(job?.controller.signal.aborted){this.jobs.delete(key);job=undefined;}
    if(!job){
      if(this.jobs.size>=16)throw new HttpError(429,'도표 요청이 많습니다. 잠시 뒤 다시 시도해 주세요');
      const accepted=Date.now();
      const item:Job={result:Promise.resolve({image:'',background:''}),readers:0,controller:new AbortController()};
      item.result=this.queue.then(async()=>{
        if(this.stopped||!item.readers)throw new DOMException('도표 요청이 취소됐습니다','AbortError');
        if(Date.now()-accepted>30_000)throw new HttpError(504,'도표 대기 시간이 초과됐습니다');
        const deadline=setTimeout(()=>item.controller.abort(new HttpError(504,'도표 처리 시간이 초과됐습니다')),Math.max(1,40_000-(Date.now()-accepted)));
        let result:DiagramResult;
        try{result=await this.draw(source,item.controller.signal);item.controller.signal.throwIfAborted();}finally{clearTimeout(deadline);}
        const bytes=Buffer.byteLength(result.image)+Buffer.byteLength(result.background);
        if(bytes>MAX_BYTES)throw new HttpError(413,'도표 결과가 너무 큽니다');
        if(!this.stopped){
          while(this.cache.size>=128||this.bytes+bytes>MAX_BYTES)this.remove(this.cache.keys().next().value!);
          this.cache.set(key,{result,at:Date.now(),bytes});this.bytes+=bytes;
        }
        return result;
      }).finally(()=>{if(this.jobs.get(key)===item)this.jobs.delete(key);});
      this.jobs.set(key,item);this.queue=item.result.then(()=>{},()=>{});job=item;
    }
    job.readers++;
    let abort:(()=>void)|undefined;
    try {
      return await Promise.race([job.result,new Promise<never>((_,reject)=>{
        abort=()=>reject(signal?.reason??new DOMException('취소됨','AbortError'));
        signal?.addEventListener('abort',abort,{once:true});
      })]);
    }finally{job.readers--;if(!job.readers)job.controller.abort();if(abort)signal?.removeEventListener('abort',abort);}
  }
  close(){this.stopped=true;for(const job of this.jobs.values())job.controller.abort();clearInterval(this.timer);this.cache.clear();this.bytes=0;}
}
