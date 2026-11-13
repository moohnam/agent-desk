import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { HttpError } from './errors.ts';
import { TemporaryFiles } from './shared-files.ts';

const TTL = 24 * 60 * 60 * 1000;
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
type Entry = { source:string; task:string; href:string; name:string; at:number; files:Map<string,Promise<string>> };
type Grant = { entry:Entry; allowed:()=>boolean };
export type PreviewReader = (source:string,task:string,href:string,base:string|undefined,receive:(r:Response)=>Promise<string>)=>Promise<string>;

/** Private copies with document-scoped, revocable read capabilities for sandboxed frames. */
export class DocumentPreviews {
  private files = new TemporaryFiles();
  private entries = new Map<string,Entry>();
  private grants = new Map<string,Grant>();
  private queue:Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private stopped = false;
  private timer = setInterval(()=>this.expire(),60_000);
  private read:PreviewReader;
  constructor(read:PreviewReader) {this.read=read;this.timer.unref();}
  private expire() {
    for(const [key,entry] of this.entries)if(Date.now()-entry.at>=TTL)this.entries.delete(key);
    for(const [id,grant] of this.grants)if(Date.now()-grant.entry.at>=TTL||!grant.allowed())this.grants.delete(id);
  }
  private file(entry:Entry,path:string) {
    const prior=entry.files.get(path);if(prior)return prior;
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    if(this.waiting>=32)throw new HttpError(429,'문서를 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요');
    this.waiting++;
    // Serialize the existing bounded receiver; concurrent requests for one resource share a promise.
    const work=this.queue.then(async()=>{
      if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
      const href=path===entry.name?entry.href:posix.join(posix.dirname(entry.href),path);
      return this.read(entry.source,entry.task,href,path===entry.name?undefined:entry.href,async response=>{
        if(path===entry.name&&Number(response.headers.get('content-length'))>5*1024*1024)
          throw new HttpError(413,'문서 본문은 5 MB까지 미리 볼 수 있습니다');
        const result=await this.files.receive(response);
        if(result.kind!=='file')throw new HttpError(502,'파일 응답이 필요합니다');
        return result.path;
      });
    }).finally(()=>{this.waiting--;});
    entry.files.set(path,work);
    this.queue=work.catch(()=>{entry.files.delete(path);});
    return work;
  }
  async prepare(source:string,task:string,href:string,refresh:boolean,allowed:()=>boolean) {
    this.expire();
    href=documentPath(href);
    const ext=posix.extname(href).toLowerCase();
    if(!['.md','.markdown','.html','.htm'].includes(ext))throw new HttpError(400,'HTML 또는 Markdown 파일만 미리 볼 수 있습니다');
    const key=JSON.stringify([source,task,href]);
    let entry=this.entries.get(key);
    if(!entry||refresh){
      if(this.entries.size>=100||this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
      entry={source,task,href,name:posix.basename(href),at:Date.now(),files:new Map()};
      this.entries.set(key,entry);
    }
    let path:string;
    try {path=await this.file(entry,entry.name);}
    catch(error){if(this.entries.get(key)===entry)this.entries.delete(key);throw error;}
    if(!allowed())throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
    if(this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
    const id=randomBytes(24).toString('base64url');
    this.grants.set(id,{entry,allowed});
    const url=`/_preview/${id}/${encodeURIComponent(entry.name)}`;
    const kind=ext==='.md'||ext==='.markdown'?'markdown':'html';
    return {url,name:entry.name,kind,...(kind==='markdown'?{text:await readFile(path,'utf8')}:{})};
  }
  async release(id:string) {
    const grant=this.grants.get(id);if(!grant)return;
    this.grants.delete(id);
    // Replaced versions can be removed once no reading frame still uses them.
    if(![...this.grants.values()].some(g=>g.entry===grant.entry)&&![...this.entries.values()].includes(grant.entry))
      await Promise.all([...grant.entry.files.values()].map(async work=>{const path=await work.catch(()=>null);if(path)await this.files.discard(path);}));
  }
  async serve(id:string,rawPath:string,res:ServerResponse,origin:string) {
    this.expire();const grant=this.grants.get(id);
    if(!grant||!grant.allowed())throw new HttpError(404,'문서 미리보기가 만료됐습니다. 다시 열어 주세요');
    let path:string;
    try {path=decodeURIComponent(rawPath);}catch{throw new HttpError(400,'잘못된 파일 경로입니다');}
    // No absolute paths, traversal, encoded second decoding or hidden files in resource URLs.
    if(!path||path.split('/').some(p=>!p||p.startsWith('.'))||/[\\%\x00-\x1f?#:]/.test(path))throw new HttpError(403,'문서 폴더 밖의 파일은 볼 수 없습니다');
    const mime=MIME[posix.extname(path).toLowerCase()];
    if(!mime)throw new HttpError(415,'미리보기를 지원하지 않는 부속 파일입니다');
    const file=await this.file(grant.entry,path);
    if(!grant.allowed())throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
    const size=(await stat(file)).size;
    const root=`${origin}/_preview/${id}/ ${origin.replace(/^http:/,'https:')}/_preview/${id}/`;
    // Header sandbox also protects direct navigation, not just the UI's iframe.
    const policy=`sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${root}; style-src 'unsafe-inline' ${root}; img-src data: ${root}; font-src data: ${root}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    res.writeHead(200,{'content-type':mime,'content-length':size,'cache-control':'no-store','referrer-policy':'no-referrer',
      'x-content-type-options':'nosniff','content-security-policy':policy,'access-control-allow-origin':'*'});
    await pipeline(createReadStream(file),res);
  }
  async close(){this.stopped=true;clearInterval(this.timer);await this.queue;this.grants.clear();this.entries.clear();await this.files.close();}
}
