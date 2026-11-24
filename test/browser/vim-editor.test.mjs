import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { interactionData } from '../../perf-bench/interaction-data.mjs';

const dist = resolve(import.meta.dirname, '../../web/dist');
const input = '.reply-box [data-desk-input]';
const textarea = '.reply-box textarea';
const mode = '.reply-box .editor-mode';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function fixtureServer() {
  const fixture = interactionData(24);
  const groupedFeed = interactionData(215, 'short');
  const deepGroupedFeed = interactionData(1500, 'short');
  let groupedFailure = true;
  const groupedStreams = new Set();
  let enrollmentPending = true;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__fixture/grouped-live') {
        for (let i = 0; i < 3; i++) for (const stream of groupedStreams) stream.write(`data: ${JSON.stringify({ source: '', message: {
          type: 'event', event: {id: 100001+i, task_id:url.searchParams.get('task') ?? 't9', kind:'assistant', ts:'2026-01-02T00:00:00.000Z', payload:{text:`재시도 보호 ${i}`}},
        } })}\n\n`);
        response.writeHead(204).end(); return;
      }
      if (url.pathname === '/api/streams') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"source":"","connected":true}\n\n');
        if (['grouped-failure', 'grouped-deep'].includes(request.headers['x-desk-fixture'])) { groupedStreams.add(response); response.on('close', () => groupedStreams.delete(response)); }
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const layout = request.headers['x-desk-fixture'];
        const note = layout === 'note' || layout === 'note-order' || layout === 'note-emoji';
        if (layout === 'workspace-request' || layout === 'queue-reorder') {
          const connection={ id:'request-key',linkId:'shared-link',workspaceName:'srv19 공유',name:'oh-mac',
            ownerName:'오 사용자',fingerprint:'SHA256:fixture',created_at:'2026-01-01T00:00:00Z' };
          if (url.pathname==='/api/workspaces/ssh-requests' || url.pathname==='/api/workspaces/shared-link/ssh-peers' ||
              url.pathname==='/api/workspaces/shared-link/ssh-requests/request-key') {
            response.writeHead(200,{'content-type':'application/json'});
            if (request.method==='POST') enrollmentPending=false;
            response.end(JSON.stringify(url.pathname.endsWith('request-key')?{ok:true}:
              url.pathname.endsWith('ssh-peers')?[]:(layout==='queue-reorder'?request.headers['x-desk-request-ready']==='1':enrollmentPending)?[connection]:[]));
            return;
          }
        }
        const route = /^\/api\/tasks\/([^/]+)\/(events|messages)$/.exec(url.pathname);
        if (layout === 'grouped-failure' && url.pathname === '/api/feed'
            && Number(url.searchParams.get('cursor_id')) !== Number.MAX_SAFE_INTEGER && groupedFailure) {
          groupedFailure = false;
          response.writeHead(500, {'content-type':'application/json'}).end('{"error":"fixture failure"}');
          return;
        }
        let body = (layout === 'grouped-deep' ? deepGroupedFeed : layout?.startsWith('grouped-') ? groupedFeed : fixture)(url);
        if (url.pathname === '/api/updates') body = {
          ...body, targets: [],
          ...(request.headers['x-desk-settings-update'] && { current: 'old', latest: 'new' }),
        };
        if (layout === 'queue-reorder' && url.pathname==='/api/state') {
          body.approvals=['first','second'].map((id,index)=>({id,task_id:'t'+index,session_id:'s'+index,
            tool_name:'Bash',input:{command:id},status:'pending',created_at:`2026-01-02T00:00:0${index}Z`}));
        }

        if (note && url.pathname === '/api/state') body.tasks = body.tasks.map(task => ({ ...task, kind: 'note' }));
        if (layout === 'channel' || layout === 'feed-channel') {
          const channel = { id: 'news', name: '테스트 채널', source: layout === 'feed-channel' ? 'feed' : 'push', enabled: true, read_through_id: 0, latest_entry_id: 1, unread_count: 1 };
          if (url.pathname === '/api/state') body.channels = [channel];
          if (url.pathname === '/api/channels') body = [channel];
          if (url.pathname === '/api/channels/news/entries') body = { entries: [], more: false, total: 0 };
        }
        if (route?.[2] === 'events') {
          const questions = layout === 'async-batch' ? [{ title: '방향?', options: ['왼쪽', '오른쪽'] }, { title: '이유?', options: [] }]
            : layout === 'async-open' ? [{ title: '의견은?', options: [] }] : undefined;
          const payload = note ? { text: '저장된 메모' } : questions ? { text: '에이전트의 질문', questions } : undefined;
          body = { events: payload ? [{ id: 300, task_id: route[1], kind: note ? 'user' : 'assistant',
            ts: '2026-01-01T00:00:00Z', payload }] : [], more: false };
          if (layout === 'note-order') body = { events: [
            { id: 300, task_id: route[1], kind: 'user', ts: '2026-01-01T00:00:00Z', edited_at: '2026-01-03T00:00:00Z',
              payload: { text: '수정한 첫 글', revision: 1 } },
            { id: 301, task_id: route[1], kind: 'user', ts: '2026-01-02T00:00:00Z', payload: { text: '두 번째 글', revision: 0 } },
          ], more: false };
          if (layout === 'emoji' || layout === 'note-emoji') body = { events: [
            'b', 'b alone', 'B', 'b', ':+1:', ':-1:', ':smile:', ':cry:', ':sob:', ':rofl:', ':tada:', ':heart:', ':eyes:', ':white_check_mark:',
            ':thumbsup:', ':thumbsdown:', '문장 속 :+1:과 :ROFL:', '답변 속 :cry:', ':+1:',
            '본문 **:sob:** · `:rofl:` · :unknown:\n\n```text\n:+1:\n```',
            '이스케이프 \\:cry:와 &#58;s&#111;b: 옆의 :smile:\n다음 줄 :heart:',
          ].map((text, index) => ({
            id: 300 + index, task_id: route[1], kind: !note && (index === 3 || index === 17) ? 'assistant' : 'user',
            ts: '2026-01-01T00:00:00Z',
            payload: { text, ...(!note && index === 18 && { request: { id: 'example', task_id: 'other', from: 'other#1', title: '질문' } }) },
          })), more: false };
          if (layout==='ssh-author-avatar') body={events:['남무현','👩‍💻 개발',null].map((ownerName,index)=>({
            id:300+index,task_id:route[1],kind:'user',ts:'2026-01-01T00:00:00Z',
            payload:{text:`메시지 ${index+1}`,...(ownerName?{author:{ownerName}}:{})},
          })),more:false};
        }
        if (route?.[2] === 'messages' && request.method === 'POST') body = { task_id: route[1] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body ?? {}));
        return;
      }
      const file = resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(dist + sep)) { response.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function text(page, selector = input) {
  return page.$eval(selector, element => [...element.querySelectorAll('.cm-line')].map(line => {
    const copy = line.cloneNode(true);
    copy.querySelector('.cm-placeholder')?.remove();
    return copy.textContent.replace(/\u200b/g, '');
  }).join('\n'));
}

async function expectMode(page, label) {
  await page.waitForFunction((selector, want) => document.querySelector(selector)?.textContent.includes(want), {}, mode, label);
}

async function openReply(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-post]');
  await page.keyboard.press('r');
}

function editorEvents(page, cdp) {
  return {
    insert: text => cdp.send('Input.insertText', { text }),
    compose: text => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }),
    physical: (key, code, extra = {}) => page.$eval(input, (element, args) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...args }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: args.key, code: args.code }));
    }, { key, code, ...extra }),
  };
}

test('Vim replies obey mode boundaries and keep IME composition separate', { timeout: 60_000 }, async t => {
  const server = fixtureServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    await readFile(resolve(dist, 'index.html'));
    const executablePath = process.env.CHROME_BIN ?? (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ['--disable-background-networking'] });
    const withPage = async (callback, emulateWebKit = false, editorMode = 'vim') => {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.evaluateOnNewDocument(({ emulateWebKit, editorMode }) => {
          localStorage.setItem('agent-desk.editor-mode', editorMode);
          if (emulateWebKit) Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
        }, { emulateWebKit, editorMode });
        await callback(page);
      } finally { await context.close(); }
    };

    await t.test('grouped columns fill empty space after resize without paging a full viewport', () => withPage(async page => {
      await page.setViewport({ width: 1440, height: 180 });
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'grouped-feed' });
      await page.evaluateOnNewDocument(() => localStorage.setItem('agent-desk.columns.v2',
        JSON.stringify([{ id: 'grouped', title: '작업별', filter: {}, byTask: true }])));
      const older = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/feed' && Number(url.searchParams.get('cursor_id')) !== Number.MAX_SAFE_INTEGER) older.push(url.search);
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      const column = '[data-col="grouped"]';
      const card = `${column} [data-post]`;
      await page.waitForSelector(card);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(older.length, 0);
      assert.equal(await page.$$eval(card, cards => cards.length), 1);
      await page.$eval(`${column} .feed`, feed => { feed.scrollTop = 1; });
      await page.waitForFunction(selector => document.querySelectorAll(selector).length > 1, {}, card);
      assert.equal(older.length, 1, 'a real downward scroll still requests the next page');
      await page.setViewport({ width: 1440, height: 2400 });
      await page.waitForFunction(selector => document.querySelectorAll(selector).length === 10, {}, card);
      assert.equal(older.length, 2);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(older.length, 2, 'stop after exhausting the available tasks');
    }, false, 'emacs'));

    for (const layout of ['grouped-deep', 'grouped-failure']) {
      await t.test(`grouped fill continues through collapsed pages and permits a manual retry (${layout})`, () => withPage(async page => {
        await page.setViewport({ width: 1440, height: layout === 'grouped-failure' ? 180 : 700 });
        await page.setExtraHTTPHeaders({ 'x-desk-fixture': layout });
        await page.evaluateOnNewDocument(() => localStorage.setItem('agent-desk.columns.v2',
          JSON.stringify([{ id: 'grouped', title: '작업별', filter: {}, byTask: true }])));
        let older = 0;
        page.on('request', request => {
          const u = new URL(request.url());
          if (u.pathname === '/api/feed' && Number(u.searchParams.get('cursor_id')) !== Number.MAX_SAFE_INTEGER) older++;
        });
        const failure = layout === 'grouped-failure' ? page.waitForResponse(r => r.status() === 500) : null;
        await page.goto(origin, {waitUntil: layout === 'grouped-failure' ? 'networkidle2' : 'load'});
        const column = '[data-col="grouped"]';
        if (layout === 'grouped-failure') {
          // Let initial source synchronization finish before injecting a read failure.
          await page.setViewport({ width: 1440, height: 700 });
          await failure;
          await page.waitForSelector(`${column} .older-posts button:enabled`);
          await page.evaluate(() => fetch('/__fixture/grouped-live', {method:'POST'}));
          await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('재시도 보호 2'), {}, column);
          await new Promise(resolve => setTimeout(resolve, 400));
          assert.equal(older, 1, 'do not automatically retry the same failed page');
          await page.click(`${column} .older-posts button`);
        }
        await page.waitForFunction(selector => document.querySelectorAll(`${selector} [data-post]`).length > 1, {}, column).catch(async error => {
          const state = await page.$eval(`${column} .feed`, feed => ({ height: feed.clientHeight, scrollHeight: feed.scrollHeight,
            top: feed.scrollTop, cards: feed.querySelectorAll('[data-post]').length, text: feed.innerText }));
          throw new Error(`${error.message}; older=${older}; ${JSON.stringify(state)}`);
        });
        assert.ok(older >= 2);
        await page.waitForFunction(selector => {
          const feed = document.querySelector(`${selector} .feed`);
          return feed.scrollHeight > feed.clientHeight || !feed.querySelector('.older-posts');
        }, {}, column).catch(async error => {
          const state = await page.$eval(`${column} .feed`, feed => ({ height: feed.clientHeight, scrollHeight: feed.scrollHeight,
            top: feed.scrollTop, cards: feed.querySelectorAll('[data-post]').length, text: feed.innerText }));
          throw new Error(`${error.message}; older=${older}; ${JSON.stringify(state)}`);
        });
      }, false, 'emacs'));
    }

    for (const scenario of ['bottom', 'top-cache']) {
      await t.test(`grouped scroll retains progress (${scenario})`, () => withPage(async page => {
        await page.setViewport({ width: 1440, height: 180 });
        await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'grouped-deep' });
        await page.evaluateOnNewDocument(() => localStorage.setItem('agent-desk.columns.v2',
          JSON.stringify([{ id: 'grouped', title: '작업별', filter: {}, byTask: true }])));
        let older = 0;
        page.on('request', request => {
          const u = new URL(request.url());
          if (u.pathname === '/api/feed' && Number(u.searchParams.get('cursor_id')) !== Number.MAX_SAFE_INTEGER) older++;
        });
        await page.goto(origin, { waitUntil: 'networkidle2' });
        const column = '[data-col="grouped"]';
        const card = `${column} [data-post]`;
        const feed = `${column} .feed`;
        if (scenario === 'bottom') {
          await page.$eval(feed, element => { element.scrollTop = element.scrollHeight; });
          await page.waitForFunction(selector => document.querySelectorAll(selector).length > 1, {}, card);
          assert.ok(older >= 2, 'continue across pages collapsed into the existing task');
        } else {
          for (let i = 0; i < 12 && await page.$$eval(card, nodes => nodes.length) < 5; i++) {
            await page.waitForSelector(`${column} .older-posts button:enabled`);
            await page.click(`${column} .older-posts button`);
            await page.waitForSelector(`${column} .older-posts button:enabled`);
          }
          const before = await page.$$eval(card, nodes => nodes.map(node => node.dataset.post));
          assert.ok(before.length >= 5);
          await page.$eval(feed, element => { element.scrollTop = element.scrollHeight; });
          await new Promise(resolve => setTimeout(resolve, 250));
          await page.waitForSelector(`${column} .older-posts button:enabled`);
          const loaded = await page.$$eval(card, nodes => nodes.map(node => node.dataset.post));
          await page.$eval(feed, element => { element.scrollTop = 0; });
          await new Promise(resolve => setTimeout(resolve, 400));
          assert.deepEqual(await page.$$eval(card, nodes => nodes.map(node => node.dataset.post)), loaded,
            'returning to the top must retain already loaded grouped task cards');
          const requests = older;
          await new Promise(resolve => setTimeout(resolve, 400));
          assert.equal(older, requests, 'returning to the top does not reload history');
        }
      }, false, 'emacs'));
    }

    for (const scenario of ['live-race', 'upward', 'failure']) {
      await t.test(`historical task discovery ignores live cards (${scenario})`, () => withPage(async page => {
        await page.setViewport({width:1440,height:180});
        await page.setExtraHTTPHeaders({'x-desk-fixture':'grouped-deep'});
        await page.evaluateOnNewDocument(()=>localStorage.setItem('agent-desk.columns.v2',
          JSON.stringify([{id:'grouped',title:'작업별',filter:{},byTask:true}])));
        let held, older=0;
        await page.setRequestInterception(true);
        page.on('request', request => {
          const u=new URL(request.url());
          if(u.pathname==='/api/feed' && Number(u.searchParams.get('cursor_id'))!==Number.MAX_SAFE_INTEGER) {
            older++;
            if(older===1) {held=request;return;}
          }
          void request.continue();
        });
        await page.goto(origin,{waitUntil:'networkidle2'});
        const feed='[data-col="grouped"] .feed';
        await page.$eval(feed,element=>{element.scrollTop=element.scrollHeight;});
        const deadline=Date.now()+5000;
        while(!held && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(held,'first historical page is in flight');
        await page.evaluate(()=>fetch('/__fixture/grouped-live?task=t0',{method:'POST'}));
        await page.waitForFunction(()=>document.querySelector('[data-col="grouped"]')?.textContent.includes('재시도 보호 2'));
        if(scenario==='upward') {
          await page.$eval(feed,element=>{element.scrollTop=0;});
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(scenario==='failure') await held.respond({status:500,contentType:'application/json',body:'{}'});
        else await held.continue();
        if(scenario!=='live-race') {
          await page.waitForSelector('[data-col="grouped"] .older-posts button:enabled');
          await new Promise(resolve=>setTimeout(resolve,400));
          assert.equal(older,1,'upward movement or failure stops automatic continuation');
          if(scenario==='upward') return;
          await page.click('[data-col="grouped"] .older-posts button');
        }
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-col="grouped"] .ctx .ttl'))
          .some(node=>node.textContent.includes('측정 작업 8')));
        assert.ok(older>=2,'live t0 must not finish historical discovery of t8');
      },false,'emacs'));
    }

    await t.test('one scroll does not exhaust history when all task cards are already known', () => withPage(async page => {
      await page.setViewport({width:1440,height:180});
      await page.setExtraHTTPHeaders({'x-desk-fixture':'grouped-deep'});
      await page.evaluateOnNewDocument(()=>localStorage.setItem('agent-desk.columns.v2',JSON.stringify([
        {id:'grouped',title:'작업별',filter:{taskIds:['t9']},byTask:true},
      ])));
      let older=0;
      page.on('request',request=>{
        const u=new URL(request.url());
        if(u.pathname==='/api/feed' && Number(u.searchParams.get('cursor_id'))!==Number.MAX_SAFE_INTEGER) older++;
      });
      await page.goto(origin,{waitUntil:'networkidle2'});
      const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/feed');
      await page.$eval('[data-col="grouped"] .feed',element=>{element.scrollTop=element.scrollHeight;});
      await response;
      await page.waitForSelector('[data-col="grouped"] .older-posts button:enabled');
      await new Promise(resolve=>setTimeout(resolve,400));
      assert.equal(older,1,'the known task total at scroll start prevents continuation');
    },false,'emacs'));

    await t.test('offscreen grouped columns wait until visible before filling', () => withPage(async page => {
      await page.setViewport({ width: 1000, height: 700 });
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'grouped-feed' });
      await page.evaluateOnNewDocument(() => localStorage.setItem('agent-desk.columns.v2', JSON.stringify([
        ...Array.from({length:4}, (_,i) => ({id:`pad${i}`,title:'작업',filter:{taskIds:[`t${i}`]},byTask:true})),
        {id:'grouped',title:'작업별',filter:{},byTask:true},
      ])));
      let older = 0;
      page.on('request', r => {
        const u = new URL(r.url());
        if (u.pathname === '/api/feed' && !u.searchParams.has('task') && Number(u.searchParams.get('cursor_id')) !== Number.MAX_SAFE_INTEGER) older++;
      });
      await page.goto(origin);
      await page.waitForSelector('[data-col="grouped"] [data-post]');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(older, 0);
      await page.$eval('.deck', deck => { deck.scrollLeft = deck.scrollWidth; });
      await page.waitForFunction(() => document.querySelectorAll('[data-col="grouped"] [data-post]').length > 1);
      assert.ok(older > 0);
    }, false, 'emacs'));

    await t.test('f toggles the selected thread pin and the layout is a persistent setting', () => withPage(async page => {
      await page.setViewport({ width: 1440, height: 900 });
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'note', 'x-desk-settings-update': '1' });
      await openReply(page, origin);
      const thread = '.thread-split [data-col="thread"]';
      const pin = `${thread} [data-post="300"] button.reference-button[aria-pressed]`;
      await page.waitForSelector(`${pin}[aria-pressed="false"]`);
      await page.focus(textarea);
      await page.keyboard.press('f');
      assert.equal(await page.$eval(textarea, field => field.value), 'f');
      await page.$eval(textarea, field => field.blur());
      await page.keyboard.press('G');
      await page.waitForSelector(`${thread} [data-post="300"].selected`);
      await page.keyboard.down('f');
      await page.waitForSelector(`${pin}[aria-pressed="true"]`);
      await page.waitForSelector('.reference-feed .body');
      await page.keyboard.down('f');
      await page.keyboard.up('f');
      assert.equal(await page.$eval(pin, button => button.getAttribute('aria-pressed')), 'true');
      await page.keyboard.press('f');
      await page.waitForSelector(`${pin}[aria-pressed="false"]`);

      await page.click('.settings-button');
      const categories = ['화면·입력', '에이전트 실행', '연동', '러너·세션', '업데이트'];
      await page.waitForSelector('.settings-content[aria-label="화면·입력"]:not([hidden])');
      assert.deepEqual(await page.$$eval('.settings-nav button', buttons => buttons.map(button => button.textContent.trim())), categories);
      await page.waitForSelector('.settings-nav button[data-update][aria-label="업데이트: 새 버전 있음"]');
      for (const index of [1, 2, 3, 4, 0]) {
        const refresh = index === 4 ? page.waitForRequest(request => request.url() === origin + '/api/updates?refresh=1') : undefined;
        await page.click(`.settings-nav button:nth-child(${index + 1})`);
        await page.waitForSelector(`.settings-content[aria-label="${categories[index]}"]:not([hidden])`);
        await refresh;
      }
      const layout = '.settings-content[aria-label="화면·입력"] select:has(option[value="split"])';
      await page.waitForSelector(layout);
      await page.select(layout, 'column');
      await page.waitForSelector('.deck-space [data-col="thread"]');
      assert.equal(await page.evaluate(() => localStorage.getItem('agent-desk.threadFloat')), '0');
      await page.setViewport({ width: 525, height: 900 });
      await page.waitForSelector(layout, { hidden: true });
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForSelector(layout);
      await page.keyboard.press('Escape');
      await page.waitForSelector(layout, { hidden: true });
      await page.keyboard.press('f');
      assert.ok(await page.$('.deck-space [data-col="thread"]'));
      await openReply(page, origin);
      await page.waitForSelector('.deck-space [data-col="thread"]');
    }, false, 'emacs'));
    await t.test('column navigation reaches its target even when animation frames are slow', () => withPage(async page => {
      await page.setViewport({ width: 1000, height: 800 });
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('agent-desk.view', 'custom');
        localStorage.setItem('agent-desk.composeOpen', '0');
        localStorage.setItem('agent-desk.columns.v2', JSON.stringify(Array.from({ length: 6 }, (_, i) =>
          ({ id: `c${i}`, title: `컬럼 ${i}`, filter: { taskIds: [`t${i}`] } }))));
      });
      await page.goto(origin);
      await page.waitForSelector('.deck section[data-col="c0"] [data-post]');
      // Simulate sparse frames without a CPU busy loop or machine-dependent throttling.
      await page.evaluate(() => {
        const raf = window.requestAnimationFrame.bind(window);
        const cancel = window.cancelAnimationFrame.bind(window);
        const pending = new Map();
        let sequence = 0;
        window.requestAnimationFrame = callback => {
          const id = ++sequence;
          const entry = { timer: setTimeout(() => {
            entry.frame = raf(now => { pending.delete(id); callback(now); });
          }, 100), frame: null };
          pending.set(id, entry);
          return id;
        };
        window.cancelAnimationFrame = id => {
          const entry = pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          if (entry.frame != null) cancel(entry.frame);
          pending.delete(id);
        };
      });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector('.deck section[data-col="c2"].focused');
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('.deck section[data-col="c1"].focused');
      const stoppedAt = await page.$eval('.deck', deck => deck.scrollLeft);
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(await page.$eval('.deck', deck => deck.scrollLeft), stoppedAt,
        'returning to a visible column must cancel the previous scroll target');
      await page.$eval('.deck', deck => {
        const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
        window.columnScrollSteps = [];
        Object.defineProperty(deck, 'scrollLeft', {
          get() { return scroll.get.call(this); },
          set(value) { window.columnScrollSteps.push(value); scroll.set.call(this, value); },
        });
      });
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector('.deck section[data-col="c2"].focused');
      await page.waitForFunction(() => {
        const deck = document.querySelector('.deck');
        const column = deck.querySelector('section[data-col="c2"]');
        const target = Math.min(column.offsetLeft + column.offsetWidth + 8 - deck.clientWidth, column.offsetLeft - 8);
        return Math.abs(deck.scrollLeft - target) < 2 && deck.style.scrollSnapType === '';
      }, { timeout: 800 });
      assert.ok(await page.evaluate(start => window.columnScrollSteps[0] > start, stoppedAt),
        'the first animation frame must move, even if keyboard repeat replaces the next frame');
    }));

    for (const editorMode of ['vim', 'emacs']) {
      await t.test(`Tab and Enter keep indentation in the reply composer (${editorMode})`, () => withPage(async page => {
        await openReply(page, origin);
        const field = editorMode === 'vim' ? input : textarea;
        await page.waitForSelector(field);
        const value = () => editorMode === 'vim' ? text(page) : page.$eval(field, el => el.value);
        const shift = async key => {
          await page.keyboard.down('Shift');
          try { await page.keyboard.press(key); } finally { await page.keyboard.up('Shift'); }
        };
        const { insert } = editorEvents(page, await page.createCDPSession());
        await page.keyboard.press('Tab');
        await insert('첫째');
        await page.keyboard.press('Enter');
        await insert('둘째');
        assert.equal(await value(), '  첫째\n  둘째');
        await shift('Tab');
        assert.equal(await value(), '  첫째\n둘째');
        if (editorMode === 'vim') {
          await page.keyboard.press('Escape');
          await page.keyboard.press('V');
          await page.keyboard.press('k');
          await expectMode(page, '선택');
        } else await shift('ArrowUp');
        await page.keyboard.press('Tab');
        assert.equal(await value(), '    첫째\n  둘째');
        await shift('Tab');
        assert.equal(await value(), '  첫째\n둘째');
        assert.equal(await page.$eval(field, el => el === document.activeElement), true);
        await page.keyboard.down('Control');
        try { await page.keyboard.press('m'); } finally { await page.keyboard.up('Control'); }
        await page.keyboard.press('Tab');
        assert.equal(await page.$eval(field, el => el === document.activeElement), false);
      }, false, editorMode));
    }

    await t.test('Tab completes an open suggestion and Shift+Tab still outdents', () => withPage(async page => {
      await openReply(page, origin);
      await page.waitForSelector(textarea);
      await page.keyboard.press('Tab');
      await page.keyboard.type('#lat');
      await page.waitForSelector('.reply-box [role="option"]');
      await page.keyboard.down('Shift');
      try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
      assert.equal(await page.$eval(textarea, el => el.value), '#lat');
      await page.keyboard.press('Tab');
      assert.equal(await page.$eval(textarea, el => el.value), '#later ');
    }, false, 'emacs'));

    for (const editorMode of ['vim', 'emacs']) {
      await t.test(`a colon completes an emoji within a sentence (${editorMode})`, () => withPage(async page => {
        await openReply(page, origin);
        const field = editorMode === 'vim' ? input : textarea;
        await page.waitForSelector(field);
        await page.keyboard.type('nice  work');
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
        await page.keyboard.type(':');
        const options = '.reply-box [role="option"]';
        await page.waitForSelector(options);
        assert.ok((await page.$$(options)).length > 1);
        await page.keyboard.type('ro');
        await page.waitForFunction(selector => {
          const choices = document.querySelectorAll(selector);
          return choices.length === 1 && choices[0].textContent.includes(':rofl:');
        }, {}, options);
        await page.keyboard.press('Tab');
        const value = editorMode === 'vim' ? await text(page) : await page.$eval(field, el => el.value);
        assert.equal(value, 'nice :rofl: work');
        assert.equal(await page.$(options), null);
      }, false, editorMode));

      await t.test(`emoji completion leaves code typing alone (${editorMode})`, () => withPage(async page => {
        await openReply(page, origin);
        const field = editorMode === 'vim' ? input : textarea;
        await page.waitForSelector(field);
        await page.keyboard.type('```text');
        await page.keyboard.press('Enter');
        await page.keyboard.type(':ro');
        const options = '.reply-box [role="option"]';
        assert.equal(await page.$(options), null);
        await page.keyboard.press('Enter');
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.keyboard.type('inline `code :ro');
        assert.equal(await page.$(options), null);
        await page.keyboard.type('` :ro');
        await page.waitForSelector(options);
      }, false, editorMode));
    }

    await t.test('a note thread displays both posts with the edited lower ID last', () => withPage(async page => {
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'note-order' });
      await openReply(page, origin);
      await page.waitForSelector('.thread-content [data-post="300"]');
      assert.deepEqual(await page.$$eval('.thread-content [data-post]', posts => posts.map(post => post.dataset.post)),
        ['301', '300']);
    }, false, 'emacs'));

    for (const note of [false, true]) {
      await t.test(`Slack emoji preserve stored Markdown and render in posts and pins (${note ? 'note' : 'reply'})`, () => withPage(async page => {
        await page.setViewport({ width: 1440, height: 900 });
        await page.setExtraHTTPHeaders({ 'x-desk-fixture': note ? 'note-emoji' : 'emoji' });
        await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async text => { window.deskCopied = text; } },
        }));
        await openReply(page, origin);
        const post = id => `.thread-content [data-post="${id}"]`;
        await Promise.all([page.waitForSelector(post(300)), page.waitForSelector(post(320))]);
        const rendered = id => page.$eval(post(id), element => element.querySelector('p').textContent);
        const tail = ['👍', '👎', '😄', '😢', '😭', '🤣', '🎉', '❤️', '👀', '✅', '👍', '👎'];
        assert.deepEqual(await Promise.all(Array.from({ length: 20 }, (_, i) => rendered(300 + i))),
          ['b', 'b alone', 'B', 'b', ...tail,
            '문장 속 👍과 🤣', '답변 속 😢', note ? '👍' : ':+1:', '본문 😭 · :rofl: · :unknown:']);
        assert.equal(await page.$eval(`${post(319)} pre code`, el => el.textContent.trim()), ':+1:');
        await page.$eval(`${post(300)} [aria-label="메시지 Markdown 원문 복사"]`, el => el.click());
        await page.waitForFunction(() => window.deskCopied === 'b');
        await page.$eval(`${post(305)} [aria-label="메시지 Markdown 원문 복사"]`, el => el.click());
        await page.waitForFunction(() => window.deskCopied === ':-1:');
        await page.$eval(`${post(316)} [aria-label="메시지 Markdown 원문 복사"]`, el => el.click());
        await page.waitForFunction(() => window.deskCopied === '문장 속 :+1:과 :ROFL:');
        assert.equal(await rendered(320), '이스케이프 :cry:와 :sob: 옆의 😄\n다음 줄 ❤️');
        await page.$eval(`${post(316)} [aria-label="이 글을 왼쪽에 고정"]`, el => el.click());
        await page.waitForFunction(() => document.querySelector('.reference-feed .body p')?.textContent === '문장 속 👍과 🤣');
      }, false, 'emacs'));
    }

    await t.test('cold loading retains initial input and remembers Escape', () => withPage(async page => {
      let ready;
      const importRequest = new Promise(resolve => { ready = resolve; });
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (/\/VimInput-[^/]+\.js$/.test(request.url())) ready(request);
        else void request.continue();
      });
      await openReply(page, origin);
      await page.waitForSelector(textarea);
      const request = await importRequest;
      await page.focus(textarea);
      try {
        assert.equal(await page.$eval(textarea, element => element.readOnly), false);
        await page.keyboard.type('initial');
        await page.$eval(textarea, element => element.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true, cancelable: true, code: 'Escape', key: 'Process', isComposing: true,
        })));
        assert.equal(await page.$eval(textarea, element => element.readOnly), true);
      } finally { await request.continue(); }
      await expectMode(page, '일반');
      await page.$eval(input, element => {
        const init = { bubbles: true, cancelable: true, code: 'Escape', key: 'Escape' };
        element.dispatchEvent(new KeyboardEvent('keydown', init));
        element.dispatchEvent(new KeyboardEvent('keyup', init));
      });
      assert.equal(await page.$eval(input, element => element === document.activeElement), true);
      assert.equal(await text(page), 'initial');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval(input, element => element === document.activeElement), false);
    }));

    for (const [layout, opener, area] of [['reply', 'r', '.reply-box'], ['drawer', 'i', '.compose'],
      ['note', 'r', '.reply-box'], ['channel', 'r', '.channel-chat-compose']]) {
      await t.test(`Vim Escape switches mode first and returns focus without closing (${layout})`, () => withPage(async page => {
        const requests = [];
        page.on('request', request => { if (request.method() !== 'GET') requests.push(request.url()); });
        await page.setExtraHTTPHeaders({ 'x-desk-fixture': layout });
        if (layout === 'channel') await page.evaluateOnNewDocument(() => localStorage.setItem('agent-desk.columns.v2',
          JSON.stringify([{ id: 'news-col', title: '테스트 채널', filter: {}, channelId: 'news' }])));
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(layout === 'channel' ? 'section[data-col="news-col"] button[role="tab"]' : '[data-post]');
        if (layout === 'channel') await page.click('section[data-col="news-col"] header');
        await page.keyboard.press(opener);
        const field = `${area} [data-desk-input]`;
        await page.waitForSelector(field);
        assert.equal(await page.$eval(field, element => element === document.activeElement), true);
        await page.keyboard.press('Escape');
        await page.$eval(field, element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape',
          bubbles: true, cancelable: true, repeat: true })));
        assert.equal(await page.$eval(field, element => element === document.activeElement), true);
        for (const key of ['s', 'Escape', 'y', 'd', 'd', 'D', 'D']) await page.keyboard.press(key);
        assert.equal(await page.$eval(field, element => element === document.activeElement), true);
        assert.deepEqual(requests, []);
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval(field, element => element === document.activeElement), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval(field, element => element === document.activeElement), false);
        if (layout !== 'channel') {
          await page.keyboard.press('?');
          await page.waitForSelector('[role="dialog"][aria-label="단축키"]');
        }
      }));
    }

    await t.test('an unavailable local workspace does not erase a saved RSS column', () => withPage(async page => {
      const column = 'section[data-col="news-col"]';
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'feed-channel' });
      await page.evaluateOnNewDocument(() => {
        if (sessionStorage.getItem('saved-columns')) return;
        sessionStorage.setItem('saved-columns', '1');
        localStorage.setItem('agent-desk.columns.v2', JSON.stringify([
          { id: 'news-col', title: '저장된 RSS', filter: {}, channelId: 'news' },
        ]));
      });
      let state = 'offline';
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (new URL(request.url()).pathname !== '/api/state' || state === 'ready') return void request.continue();
        if (state === 'offline') return void request.respond({ status: 503, contentType: 'application/json', body: '{}' });
        return void request.respond({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ projects: [], tasks: [], approvals: [], questions: [], channels: [] }) });
      });
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('agent-desk.columns.v2') ?? '[]'));
      await page.goto(origin, { waitUntil: 'networkidle2' });
      assert.equal((await saved())[0]?.id, 'news-col');
      state = 'ready';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${column} button[role="tab"]`);
      assert.equal((await saved())[0]?.id, 'news-col');
      state = 'deleted';
      await page.reload({ waitUntil: 'networkidle2' });
      assert.equal((await saved()).length, 0);
    }));

    await t.test("a shared author's avatar uses the first displayed character of their name", () => withPage(async page => {
      await page.setExtraHTTPHeaders({'x-desk-fixture':'ssh-author-avatar'});
      await openReply(page,origin);
      await page.waitForFunction(()=>[...document.querySelectorAll('[data-post] .name')].some(name=>name.textContent==='남무현'));
      const avatars=await page.$$eval('[data-post]',posts=>Object.fromEntries(posts.flatMap(post=>{
        const name=post.querySelector('.name')?.textContent, avatar=post.querySelector('.av.user')?.textContent;
        return name&&avatar?[[name,avatar]]:[];
      })));
      assert.equal(avatars['남무현'],'남');
      assert.equal(avatars['👩‍💻 개발'],'👩‍💻');
      assert.equal(avatars['나'],'나');
    }));

    await t.test('a hub connection request appears in the response queue and opens approval management', () => withPage(async page => {
      await page.setExtraHTTPHeaders({'x-desk-fixture':'workspace-request'});
      await page.goto(origin,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('.queue')?.textContent.includes('oh-mac'));
      await page.click('.queue-row .yes');
      const dialog='[role="dialog"][aria-label="공유 러너 허브 승인"]';
      await page.waitForFunction(selector=>document.querySelector(selector)?.textContent.includes('SHA256:fixture'),{},dialog);
      await page.$eval(dialog,element=>[...element.querySelectorAll('button')].find(button=>button.textContent==='승인').click());
      await page.waitForFunction(()=>!document.querySelector('.queue-row'));
    }));

    await t.test('an older connection request cannot redirect keyboard approval to another item', () => withPage(async page => {
      await page.setExtraHTTPHeaders({'x-desk-fixture':'queue-reorder'});
      await page.goto(origin,{waitUntil:'domcontentloaded'});
      await page.waitForSelector('.queue-row[data-queue-index="1"] .yes');
      await page.click('.queue-row[data-queue-index="1"] .where');
      await page.setExtraHTTPHeaders({'x-desk-fixture':'queue-reorder','x-desk-request-ready':'1'});
      await page.waitForFunction(()=>document.querySelector('.queue-row[data-queue-index="0"]')?.textContent.includes('oh-mac'),{timeout:10000});
      const sent=page.waitForRequest(request=>request.method()==='POST' && new URL(request.url()).pathname.includes('/approvals/'));
      await page.keyboard.press('y');
      assert.match(new URL((await sent).url()).pathname,/\/approvals\/second(?:\/|$)/);
    }));

    for (const editorMode of ['vim', 'emacs']) {
      await t.test(`opening an editor by key accepts the next character (${editorMode})`, () => withPage(async page => {
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-post]');
        for (const [open, region] of [['r', '.reply-box'], ['i', '.compose']]) {
          await page.keyboard.press(open);
          await page.keyboard.type('first');
          await page.waitForFunction(region => {
            const input = document.querySelector(`${region} [data-desk-input], ${region} textarea`);
            return input && (input.value ?? input.textContent) === 'first';
          }, {}, region);
          if (open === 'r') await page.click('[aria-label="스레드 닫기"]');
        }
      }, false, editorMode));
    }

    await t.test('memo cancellation confirms dirty edits and Emacs reply Escape goes back once', () => withPage(async page => {
      await page.setViewport({ width: 525, height: 880 });
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'note' });
      await page.evaluateOnNewDocument(() => {
        window.backCalls = 0;
        const back = history.back.bind(history);
        history.back = () => { window.backCalls++; back(); };
      });
      await openReply(page, origin);
      await page.waitForSelector('[data-note-action="edit"]');
      await page.click('[data-note-action="edit"]');
      const item = 'textarea[aria-label="메모 글 수정"]';
      await page.waitForSelector(item);
      await page.keyboard.type(' 수정');
      const dialogClosed = new Promise(resolve => page.once('dialog', dialog => { void dialog.dismiss().then(resolve); }));
      await page.keyboard.press('Escape');
      await dialogClosed;
      assert.match(await page.$eval(item, element => element.value), /수정/);
      await page.click('[aria-label="스레드 닫기"]');
      await page.waitForSelector(textarea, { hidden: true });
      await page.evaluate(() => { document.activeElement?.blur(); });
      await page.keyboard.press('r');
      await page.waitForSelector('[data-note-action="edit"]');
      await page.click('[data-note-action="edit"]');
      await page.waitForSelector(item);
      assert.match(await page.$eval(item, element => element.value), /수정/);
      const dialogueAccepted = new Promise(resolve => page.once('dialog', dialog => { void dialog.accept().then(resolve); }));
      await page.keyboard.press('Escape');
      await dialogueAccepted;
      await page.waitForSelector(item, { hidden: true });
      await page.evaluate(() => { window.backCalls = 0; });
      await page.focus(textarea);
      await page.keyboard.press('Escape');
      await page.waitForSelector(textarea, { hidden: true });
      assert.equal(await page.evaluate(() => window.backCalls), 1);
    }, false, 'emacs'));

    await t.test('insert undo/redo works and a sent draft cannot be restored', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
      const press = async (key, shift = false) => {
        await page.keyboard.down(mod);
        if (shift) await page.keyboard.down('Shift');
        await page.keyboard.press(key);
        if (shift) await page.keyboard.up('Shift');
        await page.keyboard.up(mod);
      };
      await page.keyboard.type('draft');
      await press('z');
      assert.equal(await text(page), '');
      await press('z', true);
      assert.equal(await text(page), 'draft');
      await press('Enter');
      await page.waitForFunction(selector => !document.querySelector(`${selector} .cm-line`)?.innerText.replace(/\n/g, '').trim() ||
        !!document.querySelector(`${selector} .cm-placeholder`), {}, input);
      await press('z');
      await page.keyboard.press('Escape');
      await page.keyboard.press('u');
      assert.equal(await text(page), '');
    }));

    await t.test('Vim can undo a chosen example but cannot revive a draft replaced by another tab', () => withPage(async page => {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-post]');
      await page.keyboard.press('i');
      const field = '.compose [data-desk-input]';
      await page.waitForSelector(field);
      await page.keyboard.type('original');
      await page.click('.compose .examples button');
      await page.keyboard.press('Escape');
      await page.keyboard.press('u');
      assert.equal(await text(page, field), 'original');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('agent-desk.drafts.v1') ?? '{}').drawer?.value === 'original');
      await page.evaluate(() => {
        const key = 'agent-desk.drafts.v1';
        const newValue = JSON.stringify({ drawer: { value: 'from another tab', at: Date.now() } });
        localStorage.setItem(key, newValue);
        dispatchEvent(new StorageEvent('storage', { key, newValue }));
      });
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'from another tab', {}, field);
      await page.keyboard.press('u');
      assert.equal(await text(page, field), 'from another tab');
    }));

    await t.test('async batches collect Other and open answers in the card before sending once', () => withPage(async page => {
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'async-batch' });
      await openReply(page, origin);
      const card = '.thread .ask-card.async';
      const direction = `${card} textarea[aria-label="방향?"]`;
      const reason = `${card} textarea[aria-label="이유?"]`;
      await page.waitForSelector(`${card} button.yes`);
      const sent = [];
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/messages')) sent.push(JSON.parse(request.postData())); });
      await page.evaluate(selector => [...document.querySelectorAll(`${selector} button`)].find(button => button.textContent.includes('기타')).click(), card);
      await page.waitForSelector(direction);
      assert.equal(await page.$eval(direction, element => element === document.activeElement), true);
      await page.type(direction, '직진');
      assert.equal(await page.$eval(`${card} button.yes`, element => element.disabled), true);
      assert.equal(await page.$(`${card} button.link`), null);
      await page.type(reason, '빠른 경로');
      assert.deepEqual(sent, []);
      await page.click(`${card} button.yes`);
      await page.waitForSelector(`${card}.resolved`);
      assert.deepEqual(sent, [{ text: '1. 직진\n\n2. 빠른 경로' }]);
    }, false, 'emacs'));

    await t.test('a single async open question chooses the reply composer', () => withPage(async page => {
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'async-open' });
      await openReply(page, origin);
      const card = '.thread .ask-card.async';
      await page.waitForSelector(`${card} button.link`);
      assert.equal(await page.$(`${card} textarea`), null);
      await page.click(`${card} button.link`);
      await page.waitForFunction(() => document.querySelector('.thread .reply-note')?.textContent.includes('의견은?'));
      assert.equal(await page.$eval(textarea, element => element === document.activeElement), true);
    }, false, 'emacs'));

    await t.test('normal, visual and literal argument modes reject unhandled DOM edits', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      await page.focus(input);
      const { insert, physical } = editorEvents(page, await page.createCDPSession());
      await insert('한글 글');
      await page.keyboard.press('Escape');
      await expectMode(page, '일반');
      await insert('unwanted한글');
      assert.equal(await text(page), '한글 글');
      await page.keyboard.press('0');
      await physical('ㄱ', 'KeyR');
      await insert('stray');
      await physical('다', 'KeyE');
      assert.equal(await text(page), '다글 글');
      await page.keyboard.press('x');
      await page.keyboard.press('v');
      await expectMode(page, '선택');
      await insert('stray');
      assert.equal(await text(page), '글 글');
      await page.keyboard.press('Escape');
      await expectMode(page, '일반');
      await physical('ㄱ', 'KeyR');
      assert.equal(await page.$eval(input, element => element.isContentEditable), true);
      await page.keyboard.press('F2');
      assert.equal(await page.$eval(input, element => element.isContentEditable), false);
    }));

    for (const emulateWebKit of [false, true]) {
      await t.test(`one Escape stroke during Korean IME keeps focus for i (${emulateWebKit ? 'delayed branch' : 'Chromium'})`, () => withPage(async page => {
        await openReply(page, origin);
        await expectMode(page, '입력');
        const { insert, compose } = editorEvents(page, await page.createCDPSession());
        await insert('첫째\n');
        await compose('한');
        const key = (type, key, code, isComposing = false) => page.$eval(input, (element, args) =>
          element.dispatchEvent(new KeyboardEvent(args.type, { bubbles: true, cancelable: true, ...args })),
        { type, key, code, isComposing });
        await key('keydown', 'Process', 'Escape', true);
        await insert('한');
        await expectMode(page, '일반');
        await key('keydown', 'Escape', 'Escape');
        await key('keyup', 'Escape', 'Escape');
        assert.equal(await page.$eval(input, element => element === document.activeElement), true);
        await key('keydown', 'ㅑ', 'KeyI');
        await key('keyup', 'ㅑ', 'KeyI');
        await expectMode(page, '입력');
        await insert('글');
        assert.equal(await text(page), '첫째\n한글');
        await page.keyboard.press('Escape');
        await expectMode(page, '일반');
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval(input, element => element === document.activeElement), false);
      }, emulateWebKit));

      await t.test(`Escape keeps the IME commit and drops the next composition (${emulateWebKit ? 'delayed branch' : 'Chromium'})`, () => withPage(async page => {
        await openReply(page, origin);
        await expectMode(page, '입력');
        await page.focus(input);
        const { insert, compose, physical } = editorEvents(page, await page.createCDPSession());
        await compose('임');
        await physical('Process', 'Escape', { isComposing: true });
        await insert('입');
        await compose('새');
        await insert('unwanted');
        await expectMode(page, '일반');
        assert.equal(await text(page), '입');
      }, emulateWebKit));
    }

    await t.test('a Chrome IME keyup between the two Escape events does not lose focus', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      const { compose, insert } = editorEvents(page, await page.createCDPSession());
      await compose('한');
      await page.$eval(input, element => element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, code: 'Escape', key: 'Process', isComposing: true,
      })));
      await insert('한');
      await expectMode(page, '일반');
      await page.$eval(input, element => {
        const init = { bubbles: true, cancelable: true, code: 'Escape' };
        element.dispatchEvent(new KeyboardEvent('keyup', { ...init, key: 'Process' }));
        element.dispatchEvent(new KeyboardEvent('keydown', { ...init, key: 'Escape' }));
        element.dispatchEvent(new KeyboardEvent('keyup', { ...init, key: 'Escape' }));
      });
      assert.equal(await page.$eval(input, el => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval(input, el => el === document.activeElement), false);
    }));

    await t.test('duplicate plain Esc after a canceled composition keeps the editor focused', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      const { compose } = editorEvents(page, await page.createCDPSession());
      await compose('한');
      await compose('');
      await page.$eval(input, element => {
        const init = { bubbles: true, cancelable: true, code: 'Escape', key: 'Escape' };
        element.dispatchEvent(new KeyboardEvent('keydown', init));
        element.dispatchEvent(new KeyboardEvent('keydown', init));
        element.dispatchEvent(new KeyboardEvent('keyup', init));
      });
      await expectMode(page, '일반');
      assert.equal(await page.$eval(input, el => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval(input, el => el === document.activeElement), false);
    }));

    await t.test('command-mode Hangul becomes a Vim key and cannot seed the next insert', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      await page.focus(input);
      const { insert, compose, physical } = editorEvents(page, await page.createCDPSession());
      await insert('한글 첫째 둘째 셋째 마지막');
      const caret = () => page.$eval(input, element => {
        const selection = getSelection();
        const range = document.createRange();
        range.setStart(element.querySelector('.cm-line'), 0);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        return range.toString().length;
      });
      await page.keyboard.press('Escape');
      await expectMode(page, '일반');
      assert.equal(await page.$eval(input, element => element.isContentEditable), false);
      assert.equal(await page.$eval(input, element => element === document.activeElement), true);
      await page.keyboard.press('0');
      const positions = [];
      for (let i = 0; i < 4; i++) {
        await page.$eval(input, element => {
          const init = { bubbles: true, cancelable: true, code: 'KeyE' };
          element.dispatchEvent(new KeyboardEvent('keydown', { ...init, key: 'Process' }));
          element.dispatchEvent(new KeyboardEvent('keydown', { ...init, key: 'ㄷ' }));
          element.dispatchEvent(new KeyboardEvent('keyup', { ...init, key: 'ㄷ' }));
        });
        positions.push(await caret());
      }
      assert.deepEqual(positions, [1, 4, 7, 10]);
      for (const [key, code, typed] of [['ㅑ', 'KeyI', '가'], ['ㅁ', 'KeyA', '나']]) {
        const before = await text(page);
        await compose('ㄴ');
        assert.equal(await text(page), before);
        await physical(key, code);
        await expectMode(page, '입력');
        assert.equal(await page.$eval(input, element => element.isContentEditable), true);
        await compose(typed);
        await insert(typed);
        const after = await text(page);
        assert.equal(after.replace(typed, ''), before);
        assert.equal(after.length, before.length + typed.length);
        await page.keyboard.press('Escape');
        await expectMode(page, '일반');
      }
    }));

    await t.test('quick Escape and i after Korean text resumes on the same line and caret', () => withPage(async page => {
      await openReply(page, origin);
      await expectMode(page, '입력');
      await page.focus(input);
      const { insert, physical } = editorEvents(page, await page.createCDPSession());
      await insert('첫째\n한');
      await page.keyboard.press('Escape');
      await expectMode(page, '일반');
      await physical('ㅑ', 'KeyI');
      await expectMode(page, '입력');
      await insert('글');
      assert.equal(await text(page), '첫째\n한글');
    }));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
