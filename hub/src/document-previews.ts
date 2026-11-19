import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { HttpError } from './errors.ts';
import { TemporaryFiles } from './shared-files.ts';

const TTL = 24 * 60 * 60 * 1000;
const LEASE = 90_000;
const PREVIEW_SCROLL_STYLE = 'html { scrollbar-width: none; } html::-webkit-scrollbar { display: none; }';
const PARALLEL_SOURCES = 4;
const MAX_TRANSFERS = 32;
const versionOf = (identity: string | undefined, bytes: Buffer) =>
  createHash('sha256').update(identity ?? '').update('\0').update(bytes).digest('hex');
const MIME: Record<string,string> = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.md':'text/plain; charset=utf-8','.markdown':'text/plain; charset=utf-8',
  '.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf',
};
const HTML_TAGS=new Set('html head body title style link a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup data dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark menu nav ol p picture pre q rp rt ruby s samp section small source span strong sub summary sup table tbody td th thead time tr u ul var wbr'.split(' '));
const SVG_TAGS=new Set('svg a style g defs symbol use path rect circle ellipse line polyline polygon text tspan textpath title desc clippath mask pattern marker lineargradient radialgradient stop image filter feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence'.split(' '));
const STATIC_ATTRIBUTES=new Set('id class style title lang dir role width height alt loading decoding colspan rowspan span scope headers abbr start reversed type value open datetime cite align valign bgcolor border cellpadding cellspacing color size face translate hidden tabindex draggable contenteditable d x y x1 x2 y1 y2 dx dy cx cy r rx ry points viewbox preserveaspectratio transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity clip-path clip-rule mask filter vector-effect paint-order font-family font-size font-style font-weight text-anchor dominant-baseline alignment-baseline textlength lengthadjust offset stop-color stop-opacity gradientunits gradienttransform spreadmethod patternunits patterncontentunits patterntransform markerwidth markerheight markerunits refx refy orient clippathunits maskunits maskcontentunits filterunits primitiveunits in in2 result mode operator k1 k2 k3 k4 values stddeviation edgemode kernelmatrix order targetx targety divisor bias preservealpha scale xchannelselector ychannelselector surfaceScale diffuseconstant specularconstant specularexponent limitingconeangle azimuth elevation flood-color flood-opacity lighting-color numoctaves seed stitchtiles basefrequency tablevalues slope intercept amplitude exponent'.toLowerCase().split(' '));

/** Parse with scripting disabled, matching the response sandbox. Never execute document code. */
function staticDocument(source:string,svg:boolean) {
  const document=svg?parseFragment(source,{scriptingEnabled:false}):parse(source,{scriptingEnabled:false});
  const resource=(value:string,image=false)=>{
    if(image&&/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z\d+/=\s]+$/i.test(value))return true;
    // Only document-relative assets, matching serve's single-decoding path rules.
    if(!value||value.startsWith('/')||/[\\\x00-\x1f?#:]/.test(value))return false;
    try {
      const base='https://preview.invalid/_preview/document/';
      const url=new URL(value,base);
      if(!url.href.startsWith(base))return false;
      const path=decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
      return !/[\\%\x00-\x1f?#:]/.test(path)&&path.split('/').every(part=>part&&!part.startsWith('.'));
    }catch{return false;}
  };
  const visit=(parent:DefaultTreeAdapterTypes.ParentNode,depth=0)=>{
    if(depth>=256){parent.childNodes=[];return;}
    parent.childNodes=parent.childNodes.filter(node=>{
      if(!('tagName' in node))return node.nodeName!=='#comment';
      const tag=node.tagName.toLowerCase(),isSvg=node.namespaceURI==='http://www.w3.org/2000/svg';
      if(!(isSvg?SVG_TAGS:node.namespaceURI==='http://www.w3.org/1999/xhtml'?HTML_TAGS:new Set()).has(tag))return false;
      if(tag==='link'&&!node.attrs.some(attr=>attr.name==='rel'&&attr.value.toLowerCase()==='stylesheet'))return false;
      node.attrs=node.attrs.filter(attr=>{
        const name=attr.name.toLowerCase();
        if(name.startsWith('on'))return false;
        if(isSvg&&attr.namespace==='http://www.w3.org/2000/xmlns/')return (name==='xmlns'&&attr.value==='http://www.w3.org/2000/svg')||(name==='xlink'&&attr.value==='http://www.w3.org/1999/xlink');
        if(name==='href') {
          if(attr.namespace&&attr.namespace!=='http://www.w3.org/1999/xlink')return false;
          if(tag==='a'||(isSvg&&tag!=='image'))return /^#[^\x00-\x20]*$/.test(attr.value);
          return (tag==='link'||(isSvg&&tag==='image'))&&resource(attr.value,tag==='image');
        }
        if(attr.namespace)return false;
        if(name==='src')return tag==='img'&&resource(attr.value,true);
        if(name==='rel')return tag==='link';
        // srcset, ping, actions, targets, autofocus, srcdoc and unknown future URL attributes are omitted.
        return STATIC_ATTRIBUTES.has(name)||name.startsWith('aria-')||name.startsWith('data-');
      });
      visit(node,depth+1);return true;
    });
  };
  visit(document);
  if(!svg) {
    const head=document.childNodes.flatMap(node=>'tagName' in node&&node.tagName==='html'?node.childNodes:[])
      .find(node=>'tagName' in node&&node.tagName==='head');
    if(head&&'childNodes' in head)head.childNodes.push(...parseFragment(`<style>${PREVIEW_SCROLL_STYLE}</style>`).childNodes);
  }
  return serialize(document);
}
export function documentPath(href:string) {
  let path:string;
  try {path=decodeURIComponent(/^file:/i.test(href)?new URL(href).pathname:href);} catch {throw new HttpError(400,'잘못된 파일 경로입니다');}
  path=path.replace(/#L\d+(-L?\d+)?$/,'').replace(/:\d+(:\d+)?(-\d+)?$/,'');
  if(!path || /[\x00-\x1f\\?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path))throw new HttpError(400,'파일 경로가 필요합니다');
  return posix.normalize(path);
}
type Entry = { approvedPath?:string; identity?:string; source:string; task:string; href:string; name:string; at:number; busy:number; files:Map<string,Promise<string>> };
type Grant = { entry:Entry; until:number; allowed:()=>boolean; owner?:string };
export type PreviewReader = (source:string,task:string,href:string,base:string|undefined,receive:(r:Response)=>Promise<string>,approvedPath?:string)=>Promise<string>;

/** Private copies with document-scoped, revocable read capabilities for sandboxed frames. */
export class DocumentPreviews {
  private files: TemporaryFiles;
  private versions = new Set<Entry>();
  private maintenance:Promise<unknown> = Promise.resolve();
  private entries = new Map<string,Entry>();
  private grants = new Map<string,Grant>();
  private queue: { source: string; start: () => void }[] = [];
  private activeSources = new Set<string>();
  private transfers = new Set<Promise<string>>();
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
  private drain() {
    while (this.activeSources.size < PARALLEL_SOURCES) {
      const next = this.queue.findIndex(job => !this.activeSources.has(job.source));
      if (next < 0) return;
      const [job] = this.queue.splice(next, 1);
      this.activeSources.add(job.source);
      job.start();
    }
  }
  private schedule(source: string, read: () => Promise<string>) {
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push({ source, start: () => {
        void Promise.resolve().then(read).then(resolve, reject).finally(() => {
          this.activeSources.delete(source);
          this.drain();
        });
      } });
    });
    this.drain();
    return work;
  }
  private file(entry:Entry,path:string):Promise<string> {
    if(entry.approvedPath!==undefined&&path!==entry.name)throw new HttpError(403,'허용한 문서 한 파일만 볼 수 있습니다. 부속 파일은 포함하지 않습니다');
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
    if(this.transfers.size>=MAX_TRANSFERS)throw new HttpError(429,'문서를 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요');
    entry.busy++;
    // A runner gets one transfer at a time. Another runner can fill an unused global slot.
    const work=this.schedule(entry.source,async()=>{
      if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
      const href=path===entry.name?entry.href:posix.join(posix.dirname(entry.href),path);
      return this.read(entry.source,entry.task,href,path===entry.name?undefined:entry.href,async response=>{
        if(path===entry.name&&Number(response.headers.get('content-length'))>5*1024*1024)
          throw new HttpError(413,'문서 본문은 5 MB까지 미리 볼 수 있습니다');
        const result=await this.files.receive(response,size=>this.collect(size));
        if(result.kind!=='file')throw new HttpError(502,'파일 응답이 필요합니다');
        if(path===entry.name) {
          const identity=response.headers.get('x-desk-document-identity');
          entry.identity=identity&&/^[a-f0-9]{64}$/.test(identity)?identity:undefined;
        }
        return result.path;
      },entry.approvedPath);
    }).catch(error=>{
      if(entry.files.get(path)===work)entry.files.delete(path);
      throw error;
    }).finally(()=>{this.transfers.delete(work);entry.busy--;});
    entry.files.set(path,work);
    this.transfers.add(work);
    return work;
  }
  async prepare(source:string,task:string,href:string,refresh:boolean,allowed:()=>boolean,approvedPath?:string,owner?:string) {
    href=documentPath(href);
    if(approvedPath!==undefined&&(typeof approvedPath!=='string'||!posix.isAbsolute(approvedPath)||approvedPath.length>4096||/[\x00-\x1f]/.test(approvedPath)))throw new HttpError(400,'확인한 문서의 절대 경로가 필요합니다');
    const ext=posix.extname(href).toLowerCase();
    if(!['.md','.markdown','.html','.htm'].includes(ext))throw new HttpError(400,'HTML 또는 Markdown 파일만 미리 볼 수 있습니다');
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    await this.collect(undefined,true);
    const key=JSON.stringify([source,task,href,approvedPath??null]);
    let entry=this.entries.get(key);
    if(this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
    // Explicit document approval must revalidate the source path on each prepare, including symlinks.
    if(!entry||refresh||approvedPath!==undefined){
      if(!entry&&this.entries.size>=100)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
      entry={source,task,href,approvedPath,name:posix.basename(href),at:Date.now(),busy:0,files:new Map()};
      this.entries.set(key,entry);this.versions.add(entry);
    }
    entry.busy++;entry.at=Date.now();
    try {
      const path=await this.file(entry,entry.name);
      const kind=ext==='.md'||ext==='.markdown'?'markdown':'html';
      const text=kind==='markdown'?await readFile(path,'utf8'):undefined;
      const scriptVersion=kind==='html'?versionOf(entry.identity,await readFile(path)):undefined;
      if(!allowed())throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
      if(this.grants.size>=256)throw new HttpError(429,'열어 둔 문서가 너무 많습니다');
      const id=randomBytes(24).toString('base64url');
      this.grants.set(id,{entry,allowed,until:Date.now()+LEASE,owner});
      const url=`/_preview/${id}/${encodeURIComponent(entry.name)}`;
      return {url,name:entry.name,kind,...(entry.identity&&{identity:entry.identity}),...(text!==undefined?{text}:{}),...(scriptVersion&&{scriptVersion})};
    } catch(error) {
      if(this.entries.get(key)===entry)this.entries.delete(key);
      throw error;
    } finally {entry.busy--;void this.collect().catch(()=>{});}
  }
  async interactive(id: string, version: string, owner: string) {
    this.expireGrants();
    const grant = this.grants.get(id);
    if (!grant || grant.owner!==owner || !/\.html?$/i.test(grant.entry.name)) throw new HttpError(404,'HTML 미리보기를 다시 열어 주세요');
    const {source,task,href,approvedPath}=grant.entry;
    const refreshed=await this.prepare(source,task,href,true,grant.allowed,approvedPath,owner);
    const nextId=refreshed.url.split('/')[2];
    try {
      if(refreshed.scriptVersion!==version)throw new HttpError(409,'문서가 변경되었습니다. 다시 확인한 뒤 JavaScript를 허용하세요.');
      const entry=this.grants.get(nextId)!.entry;
      const bytes=await readFile(await this.file(entry,entry.name));
      if(!grant.allowed()||!this.grants.has(id))throw new HttpError(403,'문서 접근 권한이 취소되었습니다');
      if(versionOf(entry.identity,bytes)!==version)throw new HttpError(409,'문서가 변경되었습니다. 다시 확인한 뒤 JavaScript를 허용하세요.');
      return { html:bytes.toString('utf8'), allowed:()=>this.grants.get(id)===grant&&grant.until>Date.now()&&grant.allowed() };
    } finally { await this.release(nextId); }
  }
  async release(id:string) {
    const grant=this.grants.get(id);if(!grant)return;
    this.grants.delete(id);grant.entry.at=Date.now();await this.collect();
  }
  /** Reuse only this live document capability, never its directory or another task's approval. */
  approvedPath(id: string | null, source: string, task: string, href: string): string | undefined {
    const grant = id ? this.grants.get(id) : undefined;
    if (!grant || grant.until <= Date.now() || !grant.allowed()) return undefined;
    const entry = grant.entry;
    return entry.source === source && entry.task === task && entry.href === documentPath(href) ? entry.approvedPath : undefined;
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
    const ext=posix.extname(path).toLowerCase();
    const body=['.html','.htm','.svg'].includes(ext)?Buffer.from(staticDocument(await readFile(file,'utf8'),ext==='.svg')):undefined;
    const size=body?.length??(await stat(file)).size;
    const root=`${origin}/_preview/${id}/ ${origin.replace(/^http:/,'https:')}/_preview/${id}/`;
    // Header sandbox also protects direct navigation, not just the UI's iframe.
    const policy=`sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${root}; img-src data: ${root}; font-src data: ${root}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    res.writeHead(200,{'content-type':mime,'content-length':size,'cache-control':'no-store','referrer-policy':'no-referrer',
      'x-content-type-options':'nosniff','content-security-policy':policy,'access-control-allow-origin':'*'});
    if(body)res.end(body);else await pipeline(createReadStream(file),res);
    } finally {entry.busy--;void this.collect().catch(()=>{});}
  }
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.allSettled(this.transfers);await this.maintenance;this.grants.clear();this.entries.clear();this.versions.clear();await this.files.close();}
}
