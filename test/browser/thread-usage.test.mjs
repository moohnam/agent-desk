import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { interactionData } from '../../perf-bench/interaction-data.mjs';

test('thread usage details support mouse, keyboard and touch within the viewport', {timeout:30000}, async () => {
  const data=interactionData(4,'short'),dist=resolve(import.meta.dirname,'../../web/dist');
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/streams'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"source":"","connected":true}\n\n');return;}
    if(url.pathname.startsWith('/api/')){
      let body=data(url)??[];
      if(url.pathname==='/api/state') body={...body,tasks:body.tasks.map(t=>({...t,runner_id:'test-runner',runner_connected:false,source:'app'}))};
      if(/\/tasks\/[^/]+\/events$/.test(url.pathname))body={events:[{id:999,task_id:url.pathname.split('/')[3],kind:'status',ts:'2026-11-25T00:00:00Z',payload:{state:'started',detail:{model:'claude-sonnet-4-6'}}}],more:false};
      if(url.pathname==='/api/runner-usage')body=url.searchParams.has('engine')?{status:'offline',value:{engine:'claude',plan:null,fetchedAt:'2026-11-25T00:00:00Z',windows:[{label:'5시간',usedPercent:20,resetsAt:'2026-11-25T05:00:00Z',applicability:'all'},{label:'주간',usedPercent:65,resetsAt:null,applicability:'all'},{label:'Opus',usedPercent:99,resetsAt:null,applicability:'opus'},...Array.from({length:20},(_,i)=>({label:`추가 ${i}`,usedPercent:1,resetsAt:null,applicability:'all'}))]}}:[{id:'local',runnerId:'test-runner',label:'test'}];
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));return;
    }
    try {const file=resolve(dist,url.pathname==='/'?'index.html':'.'+url.pathname);if(!file.startsWith(dist+sep))throw Error();const bytes=await readFile(file);res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]??'application/octet-stream'}).end(bytes);}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome'),headless:true,pipe:true,args:['--disable-background-networking']});
    for(const touch of [false,true]){
      const page=await browser.newPage();page.setDefaultTimeout(5000);
      if(touch){const cdp=await page.createCDPSession();await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});}
      await page.setViewport({width:touch?390:1100,height:844,isMobile:touch,hasTouch:touch});
      await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
      await page.waitForSelector('[data-post]');await page.keyboard.press('r');
      const button='.thread-usage > button', detail='.thread-usage-detail';
      await page.waitForSelector(button);assert.match(await page.$eval(button,e=>e.textContent),/35% 남음/);
      assert.ok(await page.$('.thread-usage.stale'));
      if(touch)await page.tap(button);else await page.hover(button);
      await page.waitForSelector(detail);assert.match(await page.$eval(detail,e=>e.textContent),/조회/);
      const bounds=await page.$eval(detail,e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:innerWidth}));
      assert.ok(bounds.left>=0&&bounds.right<=bounds.width,JSON.stringify(bounds));
      if(!touch){
        const from=await page.$eval(button,e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});
        const to=await page.$eval(detail,e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+30};});
        await page.mouse.move(from.x,from.y);await page.mouse.move(to.x,to.y,{steps:15});
        await new Promise(resolve=>setTimeout(resolve,180));
        assert.ok(await page.$(detail),'pointer can cross into details and remain there');
        const edge=await page.$eval(detail,e=>e.getBoundingClientRect().right);
        await page.mouse.move(edge+20,to.y);await page.mouse.move(to.x,to.y);
        await new Promise(resolve=>setTimeout(resolve,180));
        assert.ok(await page.$(detail),'quick re-entry cancels every pending hover dismissal');
        await page.mouse.wheel({deltaY:150});
        await page.waitForFunction(selector=>document.querySelector(selector)?.scrollTop>0,{},detail);
        assert.ok(await page.$(detail),'details scrolling keeps the popup open');
      }
      await page.focus(detail);await page.keyboard.press('Escape');await page.waitForSelector(detail,{hidden:true});
      assert.ok(await page.$eval(button,e=>document.activeElement===e),'Escape returns focus from portalled details');
      await page.keyboard.press('Enter');await page.waitForSelector(detail);
      // A real first tap can overlap smooth thread movement. The popup must track
      // the anchor rather than close on each subpixel animation step.
      await page.$eval('.thread-usage',async e=>{await e.animate([{transform:'translateX(0)'},{transform:'translateX(5px)'}],{duration:220}).finished;});
      assert.ok(await page.$(detail),'anchor animation keeps details open');
      await page.$eval('.thread-usage',e=>e.style.transform='translateX(3px)');
      await page.waitForFunction(({button,detail})=>{
        const a=document.querySelector(button).getBoundingClientRect(), d=document.querySelector(detail)?.getBoundingClientRect();
        return d && Math.abs(d.top-a.bottom)<1 && Math.abs(d.left-Math.max(8,Math.min(a.left,innerWidth-268)))<1;
      },{}, {button,detail});
      await page.focus(button);await page.keyboard.press('Escape');await page.waitForSelector(detail,{hidden:true});
      await page.keyboard.press('Enter');await page.waitForSelector(detail);
      await page.waitForFunction(({button,detail})=>Math.abs(document.querySelector(button).getBoundingClientRect().bottom-document.querySelector(detail).getBoundingClientRect().top)<1,{}, {button,detail});
      await page.setViewport({width:touch?410:1000,height:844,isMobile:touch,hasTouch:touch});
      await page.waitForSelector(detail,{hidden:true});
      await page.close();
    }
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
