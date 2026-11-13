import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import type { DiagramReply, DiagramResult } from '../../shared/diagram.ts';
import { HttpError } from './errors.ts';

const ORIGIN='http://desk-diagram.invalid';

/** A private Chromium process; only built renderer assets are served, never hub APIs or the network. */
export class DiagramBrowser {
  private browser?:Browser;
  private controls=new WeakMap<Browser,AbortController>();
  private launching?:AbortController;
  private idle?:ReturnType<typeof setTimeout>;
  private unavailableUntil=0;
  private stopped=false;
  private dist:string;
  private executable?:string;
  constructor(dist:string,executable?:string){this.dist=dist;this.executable=executable;}
  async version() {
    try {return createHash('sha256').update(await readFile(join(this.dist,'mermaid-renderer.html'))).digest('hex');}
    catch{throw new HttpError(503,'허브의 도표 렌더러 빌드가 필요합니다');}
  }
  private async start(signal?:AbortSignal) {
    if(this.stopped)throw new HttpError(503,'허브가 종료 중입니다');
    if(this.browser?.connected)return this.browser;
    if(Date.now()<this.unavailableUntil)throw new HttpError(503,'허브의 도표 브라우저를 사용할 수 없습니다');
    const candidates=this.executable?[this.executable]:[
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',
    ];
    let executablePath:string|undefined;
    for(const candidate of candidates){try{await access(candidate,constants.X_OK);executablePath=candidate;break;}catch{}}
    const control=this.launching=new AbortController();
    const abort=()=>control.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      signal?.throwIfAborted();
      if(!executablePath)throw Error('browser unavailable');
      const {default:puppeteer}=await import('puppeteer-core');
      const browser=await puppeteer.launch({executablePath,headless:true,pipe:true,timeout:10_000,signal:control.signal,
        handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
        defaultViewport:{width:1000,height:800},
        env:Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR'].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[])),
        args:['--disable-background-networking','--disable-extensions','--disable-dev-shm-usage'],
      });
      if(this.stopped){await browser.close();throw Error('stopped');}
      this.browser=browser;
      this.controls.set(browser,control);
      browser.once('disconnected',()=>{if(this.browser===browser)this.browser=undefined;});
      return browser;
    }catch{signal?.throwIfAborted();this.unavailableUntil=Date.now()+30_000;throw new HttpError(503,'허브의 도표 브라우저를 사용할 수 없습니다');}
    finally{signal?.removeEventListener('abort',abort);if(this.launching===control)this.launching=undefined;}
  }
  async render(source:string,signal?:AbortSignal):Promise<DiagramResult> {
    signal?.throwIfAborted();
    clearTimeout(this.idle);
    const browser=await this.start(signal);let page:Page|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    let timedOut=false;
    const stop=()=>{timedOut=true;this.controls.get(browser)?.abort();if(this.browser===browser)this.browser=undefined;};
    let abort:(()=>void)|undefined;
    try {
      if(signal?.aborted){stop();signal.throwIfAborted();}
      return await Promise.race([
        (async()=>{
          page=await browser.newPage();
          if(timedOut)throw new HttpError(504,'도표 생성 시간이 초과됐습니다');
          await page.setRequestInterception(true);
          page.on('request',request=>{
            void (async()=>{
              const url=new URL(request.url());
              if(url.origin!==ORIGIN||url.search||!/^\/(mermaid-renderer\.html|assets\/[\w.-]+\.(js|css|woff2?))$/.test(url.pathname))return request.abort();
              const body=await readFile(join(this.dist,url.pathname));
              const contentType=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff':'font/woff','.woff2':'font/woff2'} as Record<string,string>)[extname(url.pathname)];
              await request.respond({status:200,contentType,body,headers:{'content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'"}});
            })().catch(()=>{if(!request.isInterceptResolutionHandled())void request.abort().catch(()=>{});});
          });
          await page.goto(ORIGIN+'/mermaid-renderer.html',{waitUntil:'load',timeout:10_000});
          const reply=await page.evaluate((text:string)=>new Promise<DiagramReply>(resolve=>{
            const channel=new MessageChannel();
            channel.port1.onmessage=({data})=>{
              if(data.ready)channel.port1.postMessage({id:1,source:text});
              else if(data.id===1){channel.port1.close();resolve(data);}
            };
            window.postMessage({type:'desk-mermaid-connect'},location.origin,[channel.port2]);
          }),source);
          if(!reply.result)throw new HttpError(reply.errorKind==='infrastructure'?503:422,reply.error??'도표를 그리지 못했습니다');
          if(!reply.result.image.startsWith('data:image/svg+xml;'))throw new HttpError(502,'도표 응답이 올바르지 않습니다');
          return reply.result;
        })(),
        new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{
          // The watchdog belongs to the hub process, so a blocked renderer cannot block chat delivery.
          stop();
          reject(new HttpError(504,'도표 생성 시간이 초과됐습니다'));
        },30_000);}),
        new Promise<never>((_,reject)=>{abort=()=>{stop();reject(signal?.reason??new DOMException('취소됨','AbortError'));};signal?.addEventListener('abort',abort,{once:true});}),
      ]);
    }finally{
      clearTimeout(deadline);
      if(abort)signal?.removeEventListener('abort',abort);
      if(page&&!timedOut){
        const closing=setTimeout(stop,2000);closing.unref();
        try{await page.close().catch(()=>{});}finally{clearTimeout(closing);}
      }
      if(!this.stopped)this.idle=setTimeout(()=>{void this.release();},10_000);
      this.idle?.unref();
    }
  }
  private async release() {
    const browser=this.browser;this.browser=undefined;
    if(!browser)return;
    const deadline=setTimeout(()=>this.controls.get(browser)?.abort(),2000);deadline.unref();
    try{await browser.close();}catch{}finally{clearTimeout(deadline);}
  }
  async close(){this.stopped=true;this.launching?.abort();clearTimeout(this.idle);await this.release();}
}
