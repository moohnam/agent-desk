import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { HttpError } from './errors.ts';
import { TemporaryFiles } from './shared-files.ts';

const TTL = 24 * 60 * 60 * 1000;
const LEASE = 90_000;
const MIME: Record<string,string> = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.md':'text/plain; charset=utf-8','.markdown':'text/plain; charset=utf-8',
  '.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf',
};
export function documentPath(href:string) {
  let path:string;
  try {path=decodeURIComponent(/^file:/i.test(href)?new URL(href).pathname:href);} catch {throw new HttpError(400,'잘못된 파일 경로입니다');}
  path=path.replace(/#L\d+(-L?\d+)?$/,'').replace(/:\d+(:\d+)?(-\d+)?$/,'');
  if(!path || /[\x00-\x1f\\?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path))throw new HttpError(400,'파일 경로가 필요합니다');
  return posix.normalize(path);
}
type Entry = { source:string; task:string; href:string; name:string; at:number; busy:number; files:Map<string,Promise<string>> };
type Grant = { entry:Entry; until:number; allowed:()=>boolean };
export type PreviewReader = (source:string,task:string,href:string,base:string|undefined,receive:(r:Response)=>Promise<string>)=>Promise<string>;

/** Private copies with document-scoped, revocable read capabilities for sandboxed frames. */
export class DocumentPreviews {
  private files: TemporaryFiles;
  private versions = new Set<Entry>();
  private maintenance:Promise<unknown> = Promise.resolve();
  private entries = new Map<string,Entry>();
  private grants = new Map<string,Grant>();
  private queue:Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private stopped = false;
  private timer = setInterval(()=>{void this.collect().catch(()=>{});},60_000);
  private read:PreviewReader;
  constructor(read:PreviewReader, limits: {maxBytes?:number;maxFiles?:number} = {}) {
    this.read=read;this.files=new TemporaryFiles(undefined,{...limits,managed:true});this.timer.unref();
  }
  private expireGrants() {
    for(const [id,grant] of this.grants)if(Date.now()>=grant.until||!grant.allowed())this.grants.delete(id);
  }
  private collect(size?:number, entryRoom=false) {
    const run=this.maintenance.then(async()=>{
      this.expireGrants();
      const current=new Set(this.entries.values());
      for(const entry of [...this.versions].sort((a,b)=>a.at-b.at)) {
        if(entry.busy||[...this.grants.values()].some(g=>g.entry===entry))continue;
        if(current.has(entry)&&Date.now()-entry.at<TTL
          && !(entryRoom&&this.entries.size>=100)&&!(size!==undefined&&!this.files.canReceive(size)))continue;
        // Remove the index and the whole version together; no cached promise may point at a deleted file.
        for(const [key,value] of this.entries)if(value===entry)this.entries.delete(key);
        await Promise.all([...entry.files.values()].map(async work=>{
          const path=await work.catch(()=>null);if(path)await this.files.discard(path);
        }));
        // Keep failed deletions in the retired set so a later cleanup can reclaim their quota.
        this.versions.delete(entry);
      }
    });
    this.maintenance=run.catch(()=>{});return run;
  }
  renew(id:string) {
    this.expireGrants();const grant=this.grants.get(id);
    if(!grant)throw new HttpError(404,'문서 미리보기가 만료됐습니다. 다시 열어 주세요');
    grant.until=Date.now()+LEASE;grant.entry.at=Date.now();
  }
  private file(entry:Entry,path:string):Promise<string> {
    const prior=entry.files.get(path);
    if(prior)return prior.then(async file=>{
      try {await stat(file);return file;}
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        // Another hub may reap crash-age copies while this process is suspended.
        await this.files.discard(file);
        if(entry.files.get(path)===prior)entry.files.delete(path);
        return this.file(entry,path);
      }
    });
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    if(this.waiting>=32)throw new HttpError(429,'문서를 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요');
    this.waiting++;entry.busy++;
    // Serialize the existing bounded receiver; concurrent requests for one resource share a promise.
    const work=this.queue.then(async()=>{
      if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
      const href=path===entry.name?entry.href:posix.join(posix.dirname(entry.href),path);
      return this.read(entry.source,entry.task,href,path===entry.name?undefined:entry.href,async response=>{
        if(path===entry.name&&Number(response.headers.get('content-length'))>5*1024*1024)
          throw new HttpError(413,'문서 본문은 5 MB까지 미리 볼 수 있습니다');
        const size=Number(response.headers.get('content-length'));
        if(response.headers.has('content-length')&&Number.isSafeInteger(size)&&size>=0&&size<=50*1024*1024)await this.collect(size);
        const result=await this.files.receive(response);
        if(result.kind!=='file')throw new HttpError(502,'파일 응답이 필요합니다');
        return result.path;
      });
    }).finally(()=>{this.waiting--;entry.busy--;});
    entry.files.set(path,work);
    this.queue=work.catch(()=>{entry.files.delete(path);});
    return work;
  }
  async prepare(source:string,task:string,href:string,refresh:boolean,allowed:()=>boolean) {
    href=documentPath(href);
    const ext=posix.extname(href).toLowerCase();
    if(!['.md','.markdown','.html','.htm'].includes(ext))throw new HttpError(400,'HTML 또는 Markdown 파일만 미리 볼 수 있습니다');
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    await this.collect(undefined,true);
    const key=JSON.stringify([source,task,href]);
    let entry=this.entries.get(key);
    if(this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
    if(!entry||refresh){
      if(!entry&&this.entries.size>=100)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
      entry={source,task,href,name:posix.basename(href),at:Date.now(),busy:0,files:new Map()};
      this.entries.set(key,entry);this.versions.add(entry);
    }
    entry.busy++;entry.at=Date.now();
    try {
      const path=await this.file(entry,entry.name);
      const kind=ext==='.md'||ext==='.markdown'?'markdown':'html';
      const text=kind==='markdown'?await readFile(path,'utf8'):undefined;
      if(!allowed())throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
      if(this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
      const id=randomBytes(24).toString('base64url');
      this.grants.set(id,{entry,allowed,until:Date.now()+LEASE});
      const url=`/_preview/${id}/${encodeURIComponent(entry.name)}`;
      return {url,name:entry.name,kind,...(text!==undefined?{text}:{})};
    } catch(error) {
      if(this.entries.get(key)===entry)this.entries.delete(key);
      throw error;
    } finally {entry.busy--;void this.collect().catch(()=>{});}
  }
  async release(id:string) {
    const grant=this.grants.get(id);if(!grant)return;
    this.grants.delete(id);grant.entry.at=Date.now();await this.collect();
  }
  async serve(id:string,rawPath:string,res:ServerResponse,origin:string) {
    this.expireGrants();const grant=this.grants.get(id);
    if(!grant||!grant.allowed())throw new HttpError(404,'문서 미리보기가 만료됐습니다. 다시 열어 주세요');
    let path:string;
    try {path=decodeURIComponent(rawPath);}catch{throw new HttpError(400,'잘못된 파일 경로입니다');}
    // No absolute paths, traversal, encoded second decoding or hidden files in resource URLs.
    if(!path||path.split('/').some(p=>!p||p.startsWith('.'))||/[\\%\x00-\x1f?#:]/.test(path))throw new HttpError(403,'문서 폴더 밖의 파일은 볼 수 없습니다');
    const mime=MIME[posix.extname(path).toLowerCase()];
    if(!mime)throw new HttpError(415,'미리보기를 지원하지 않는 부속 파일입니다');
    const entry=grant.entry;entry.busy++;entry.at=Date.now();
    try {
    const file=await this.file(entry,path);
    if(!grant.allowed())throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
    const size=(await stat(file)).size;
    const root=`${origin}/_preview/${id}/ ${origin.replace(/^http:/,'https:')}/_preview/${id}/`;
    // Header sandbox also protects direct navigation, not just the UI's iframe.
    const policy=`sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${root}; style-src 'unsafe-inline' ${root}; img-src data: ${root}; font-src data: ${root}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    res.writeHead(200,{'content-type':mime,'content-length':size,'cache-control':'no-store','referrer-policy':'no-referrer',
      'x-content-type-options':'nosniff','content-security-policy':policy,'access-control-allow-origin':'*'});
    await pipeline(createReadStream(file),res);
    } finally {entry.busy--;void this.collect().catch(()=>{});}
  }
  async close(){this.stopped=true;clearInterval(this.timer);await this.queue;await this.maintenance;this.grants.clear();this.entries.clear();this.versions.clear();await this.files.close();}
}
