import { createHash } from 'node:crypto';
import { MAX_DIAGRAM_TEXT, type DiagramResult } from '../../shared/diagram.ts';
import { HttpError } from './errors.ts';

const TTL = 24 * 60 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
type Cached = { result:DiagramResult; at:number; bytes:number };
type Job = {
  key:string;
  source:string;
  accepted:number;
  result:Promise<DiagramResult>;
  resolve:(result:DiagramResult)=>void;
  reject:(error:unknown)=>void;
  readers:number;
  controller:AbortController;
};

/** One render at a time, shared work for identical input, and a bounded in-memory SVG LRU. */
export class DiagramCache {
  private cache = new Map<string,Cached>();
  private jobs = new Map<string,Job>();
  private waiting = new Set<Job>();
  private active?:Job;
  private bytes = 0;
  private stopped = false;
  private timer = setInterval(()=>this.expire(),60_000);
  private draw:(source:string,signal:AbortSignal)=>Promise<DiagramResult>;
  constructor(draw:(source:string,signal:AbortSignal)=>Promise<DiagramResult>) {this.draw=draw;this.timer.unref();}
  private remove(key:string) {const prior=this.cache.get(key);if(prior)this.bytes-=prior.bytes;this.cache.delete(key);}
  private expire() {for(const [key,value] of this.cache)if(Date.now()-value.at>=TTL)this.remove(key);}
  private removeJob(job:Job) {
    if(this.jobs.get(job.key)===job)this.jobs.delete(job.key);
  }
  private cancel(job:Job) {
    if(this.waiting.delete(job)){
      this.removeJob(job);
      job.controller.abort();
      job.reject(job.controller.signal.reason);
    }else if(this.active===job)job.controller.abort();
  }
  private startNext() {
    if(this.active||this.stopped)return;
    const job=this.waiting.values().next().value;
    if(!job)return;
    this.waiting.delete(job);
    this.active=job;
    void this.run(job);
  }
  private async run(job:Job) {
    const {key,source,accepted,controller}=job;
    try {
      if(Date.now()-accepted>30_000)throw new HttpError(504,'도표 대기 시간이 초과됐습니다');
      const deadline=setTimeout(()=>controller.abort(new HttpError(504,'도표 처리 시간이 초과됐습니다')),Math.max(1,40_000-(Date.now()-accepted)));
      let result:DiagramResult;
      try{result=await this.draw(source,controller.signal);controller.signal.throwIfAborted();}finally{clearTimeout(deadline);}
      const bytes=Buffer.byteLength(result.image)+Buffer.byteLength(result.background);
      if(bytes>MAX_BYTES)throw new HttpError(413,'도표 결과가 너무 큽니다');
      if(!this.stopped){
        while(this.cache.size>=128||this.bytes+bytes>MAX_BYTES)this.remove(this.cache.keys().next().value!);
        this.cache.set(key,{result,at:Date.now(),bytes});this.bytes+=bytes;
      }
      job.resolve(result);
    }catch(error){job.reject(error);}
    finally{this.removeJob(job);this.active=undefined;this.startNext();}
  }
  private acquire(key:string,source:string) {
    const existing=this.jobs.get(key);
    if(existing&&!existing.controller.signal.aborted)return existing;
    if(this.waiting.size+Number(!!this.active)>=16)throw new HttpError(429,'도표 요청이 많습니다. 잠시 뒤 다시 시도해 주세요');
    const {promise,resolve,reject}=Promise.withResolvers<DiagramResult>();
    const job:Job={key,source,accepted:Date.now(),result:promise,resolve,reject,readers:0,controller:new AbortController()};
    this.jobs.set(key,job);
    this.waiting.add(job);
    return job;
  }
  async render(source:string,version:string,signal?:AbortSignal) {
    if(source.length>MAX_DIAGRAM_TEXT)throw new HttpError(413,'도표가 너무 큽니다');
    signal?.throwIfAborted();
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    this.expire();
    const key=createHash('sha256').update(version).update('\0').update(source).digest('hex');
    const cached=this.cache.get(key);
    if(cached){cached.at=Date.now();this.cache.delete(key);this.cache.set(key,cached);return cached.result;}
    const job=this.acquire(key,source);
    job.readers++;
    const release=()=>{if(--job.readers===0)this.cancel(job);};
    const aborted=signal?Promise.withResolvers<never>():undefined;
    const abort=()=>{aborted?.reject(signal?.reason);release();};
    try {
      signal?.addEventListener('abort',abort,{once:true});
      const result=aborted?Promise.race([job.result,aborted.promise]):job.result;
      this.startNext();
      return await result;
    }finally{if(!signal?.aborted)release();signal?.removeEventListener('abort',abort);}
  }
  close(){
    this.stopped=true;
    for(const job of this.waiting)this.cancel(job);
    this.active?.controller.abort();
    clearInterval(this.timer);this.cache.clear();this.bytes=0;
  }
}
