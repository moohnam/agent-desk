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
const requestDescription = '첫 줄\n둘째 줄\n\n- **확인** [작업 문서](docs/readme.md)\n<!-- 승인 전 확인 -->';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function fixtureServer() {
  const fixture = interactionData(24);
  const settledApprovals = new Set();
  const approvalStreams = new Set();
  const groupedFeed = interactionData(215, 'short');
  const deepGroupedFeed = interactionData(1500, 'short');
  let groupedFailure = true;
  const groupedStreams = new Set();
  const subagentStreams = new Set();
  let enrollmentPending = true;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__fixture/subagent-message' && request.method === 'POST') {
        let body='';for await (const chunk of request) body+=chunk;
        const message=JSON.parse(body);
        for(const stream of subagentStreams)stream.write(`data: ${JSON.stringify({source:'',message})}\n\n`);
        response.writeHead(204).end();return;
      }
      if (url.pathname === '/__fixture/subagent-reconnect' && request.method === 'POST') {
        for (const stream of subagentStreams) stream.end();
        response.writeHead(204).end();return;
      }
      if (url.pathname === '/__fixture/grouped-live') {
        for (let i = 0; i < 3; i++) for (const stream of groupedStreams) stream.write(`data: ${JSON.stringify({ source: '', message: {
          type: 'event', event: {id: 100001+i, task_id:url.searchParams.get('task') ?? 't9', kind:'assistant', ts:'2026-01-02T00:00:00.000Z', payload:{text:`재시도 보호 ${i}`}},
        } })}\n\n`);
        response.writeHead(204).end(); return;
      }
      if (url.pathname === '/api/streams') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"source":"","connected":true}\n\n');
        subagentStreams.add(response);response.on('close',()=>subagentStreams.delete(response));
        if (request.headers['x-desk-fixture']==='queue-many') {
          approvalStreams.add(response);
          response.on('close',()=>approvalStreams.delete(response));
        }
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
        if (url.pathname === '/api/removals') body = [];
        if (url.pathname === '/api/prompt-templates') body = {revision:'initial',items:[]};
        if (url.pathname === '/api/updates') body = {
          ...body, targets: [],
          ...(request.headers['x-desk-settings-update'] && { current: 'old', latest: 'new' }),
        };
        if (layout === 'queue-many') {
          if (url.pathname==='/api/state') body.approvals=Array.from({length:6},(_,i)=>({
            id:'many'+i,task_id:'t0',session_id:'s0',tool_name:'Bash',input:{command:'cmd'+i},
            status:'pending',created_at:'2026-01-02T00:00:0'+i+'Z',
          })).filter(a=>!settledApprovals.has(a.id));
          if (request.method==='POST' && url.pathname.startsWith('/api/approvals/')) {
            const id=url.pathname.split('/').at(-1);
            settledApprovals.add(id);
            const message={type:'approval',approval:{id,task_id:'t0',session_id:'s0',tool_name:'Bash',status:'allowed'}};
            for(const stream of approvalStreams)stream.write('data: '+JSON.stringify({source:'',message})+'\n\n');
            body={ok:true};
          }
        }
        if (layout === 'queue-reorder' && url.pathname==='/api/state') {
          body.approvals=['first','second'].map((id,index)=>({id,task_id:'t'+index,session_id:'s'+index,
            tool_name:'Bash',input:{command:id},status:'pending',created_at:`2026-01-02T00:00:0${index}Z`}));
        }
        if (layout === 'request-markdown' && url.pathname === '/api/preview' && request.method === 'POST')
          body = {name: 'readme.md', kind: 'markdown', url: '/_preview/request/readme.md', text: '승인 링크 미리보기'};
        if (layout === 'request-markdown' && url.pathname === '/api/state') {
          body.approvals = ['allow-request', 'deny-request'].map((id, index) => ({
            id, task_id: 't' + index, session_id: 's' + index, tool_name: 'desk_request',
            input: {to: '@target', description: requestDescription}, status: 'pending', created_at: `2026-01-02T00:00:0${index}Z`,
          }));
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
          if (layout === 'request-markdown' && route[1] === 't0') body = {events: [{
            id: 300, task_id: 't0', kind: 'approval', ts: '2026-01-02T00:00:00Z',
            payload: {decision: 'pending', approvalId: 'allow-request', toolName: 'desk_request',
              input: {to: '@target', description: requestDescription}},
          }], more: false};
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

// This shared-browser fixture runs many scenarios sequentially. Allow CI headroom
// for their combined duration; keep the 5-second default and explicit wait limits.
test('Vim replies obey mode boundaries and keep IME composition separate', { timeout: 180_000 }, async t => {
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

    await t.test('a missing diff bundle leaves the thread and draft usable', () => withPage(async page => {
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (/\/CodePanel-[^/]+\.js$/.test(new URL(request.url()).pathname)) void request.abort();
        else void request.continue();
      });
      await openReply(page, origin);
      await page.type(textarea, '작성 중인 답글');
      await page.click('[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-panel [role="alert"]');
      await page.focus('.code-panel button[aria-label="코드 보기 닫기"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.code-panel', { hidden: true });
      assert.equal(await page.$eval(textarea, field => field.value), '작성 중인 답글');
      await page.click('[aria-label="코드 변경 보기"]');await page.waitForSelector('.code-panel [role="alert"]');
      await page.focus('.code-panel button');await page.keyboard.press('Escape');
      await page.waitForSelector('.code-panel',{hidden:true});assert.ok(await page.$('.thread-head'));
    }, false, 'emacs'));

    await t.test('an unknown extension named constructor renders a plain-text diff', () => withPage(async page => {
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (new URL(request.url()).pathname !== '/api/code-view') return void request.continue();
        const { path } = JSON.parse(request.postData());
        void request.respond({ contentType: 'application/json', body: JSON.stringify({
          root: '/repo', head: 'a'.repeat(40), files: [{ path: 'file.constructor', status: 'modified' }],
          ...(path && {path, diff: '@@ -0,0 +1 @@\n+plain text\n'}),
        }) });
      });
      await openReply(page, origin);
      await page.click('[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-line.add');
      assert.equal(await page.$eval('.code-line.add code', el => el.textContent), 'plain text');
    }, false, 'emacs'));

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
        await page.waitForSelector(feed); // Initial durable-removal state may finish after network idle.
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

    for(const width of [1440,390])await t.test(`subagent pane separates active commands from history (${width})`,()=>withPage(async page=>{
      let backgroundItem;
      await page.setViewport({width,height:900});await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/state'){
          const state=interactionData(24)(new URL(request.url()));state.tasks=state.tasks.map(t=>({...t,source:'app'}));
          return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(state)});
        }
        const match=/\/tasks\/([^/]+)\/subagents$/.exec(path);
        if(match){
          const base={task_id:match[1],session_id:'s',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:01Z',detailed:true,background:true};
          backgroundItem={...base,id:'bg',toolUseId:'call-bg',type:'shell',backgroundEvidence:'native',description:'실제 백그라운드 명령',status:'running',command:'sleep fixture',output:'보존된 명령 출력'};
          return void request.respond({status:200,contentType:'application/json',body:JSON.stringify([
            {...base,id:'agent',toolUseId:'call-agent',type:'local_agent',description:'완료된 하위 작업',status:'ended',detailNote:'과거 전체 기록은 제공되지 않았습니다.'},
            backgroundItem,
            {...base,id:'legacy',type:'shell',detailed:false,description:'구버전 미확인 명령',status:'running'},
            {...base,id:'old',toolUseId:'call-old',type:'shell',description:'기존 오분류 종료 명령',status:'completed'},
            {...base,id:'foreground',type:'local_bash',description:'전경 명령',status:'running',background:false},
          ])});
        }
        const events=/\/tasks\/([^/]+)\/events$/.exec(path);
        if(events){
          const e={task_id:events[1],session_id:'s',ts:'2026-01-01T00:00:00Z'};
          return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({events:[
            {...e,id:9001,kind:'assistant',payload:{text:'하위 작업을 시작합니다.'}},
            ...['agent','bg','old'].map((id,i)=>({...e,id:9002+i,kind:'tool',payload:{name:'Bash',toolUseId:'call-'+id,input:{command:id}}})),
          ],more:false})});
        }
        if(/\/subagents\/history$/.test(path))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({events:[],more:false})});
        if(/\/subagents\/[^/]+\/events$/.test(path))return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({events:[{id:8000,task_id:path.split('/')[3],session_id:'s',subagent_id:'agent',kind:'assistant',ts:'2026-01-01T00:00:00Z',payload:{text:'선택한 과거 에이전트의 본문'}}],more:false})});
        void request.continue();
      });
      await openReply(page,origin);await page.waitForSelector('[aria-label="서브 에이전트 창"]');
      if(width===390){
        await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('b');
        await page.waitForFunction(()=>document.body.textContent.includes('서브 에이전트 창은 스레드를 옆에 띄운 넓은 화면에서 열 수 있습니다.'));
        assert.equal(await page.$('.subagent-panel'),null);return;
      }
      await page.waitForFunction(()=>document.querySelectorAll('.thread .sa-chip').length===2);
      assert.equal(await page.$eval('[aria-label="서브 에이전트 창"] span',e=>e.textContent),'1');
      assert.ok(!(await page.$eval('.thread',e=>e.textContent)).includes('명령: 기존 오분류 종료 명령'));
      const commandChip=(await page.$$('.thread .sa-chip'))[1];
      assert.ok((await commandChip.evaluate(e=>e.textContent)).includes('실제 백그라운드 명령'));
      await commandChip.click();
      await page.waitForSelector('.sa-command');
      assert.equal(await page.$$eval('.sa-command',nodes=>nodes.length),1);
      const content=await page.$eval('.subagent-panel',e=>e.textContent);
      assert.ok(content.includes('실제 백그라운드 명령'));assert.ok(content.includes('보존된 명령 출력'));assert.ok(content.includes('완료된 하위 작업'));
      assert.ok(!content.includes('과거 전체 기록은 제공되지 않았습니다.'));
      const statusLine='[data-column="history"] .sa-history-line';
      await page.click(statusLine);
      assert.ok((await page.$eval('[data-column="history"]',e=>e.textContent)).includes('과거 전체 기록은 제공되지 않았습니다.'));
      await page.focus(statusLine);
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval(statusLine,e=>e.getAttribute('aria-expanded')),'false');
      await page.keyboard.press('Space');
      assert.equal(await page.$eval(statusLine,e=>e.getAttribute('aria-expanded')),'true');
      assert.equal(await page.$$eval('[data-column="history"]',nodes=>nodes.length),1);
      assert.equal(await page.$$eval('[data-column="commands"]',nodes=>nodes.length),1);
      assert.equal(await page.$('.sa-strip'),null);
      assert.equal(await page.$('.sa-col [aria-label="컬럼 닫기"]'),null);
      assert.ok(!content.includes('기존 오분류 종료 명령'));assert.ok(!content.includes('전경 명령'));assert.ok(!content.includes('구버전 미확인 명령'));
      await page.evaluate(message=>fetch('/__fixture/subagent-message',{method:'POST',body:JSON.stringify(message)}),{type:'subagent',subagent:{...backgroundItem,status:'completed',updated_at:'2026-01-01T00:00:02Z'}});
      await page.waitForFunction(()=>document.querySelectorAll('.thread .sa-chip').length===1 && !document.querySelector('.sa-command'));
      assert.ok((await page.$eval('.thread .sa-chip',e=>e.textContent)).includes('완료된 하위 작업'));
      assert.equal(await page.$('[aria-label="서브 에이전트 창"] span'),null);
      await page.click('.thread .sa-chip');
      await page.waitForFunction(()=>document.querySelector('[data-column="history"] .post.selected')?.textContent.includes('선택한 과거 에이전트의 본문'));
      await page.keyboard.press('Escape');await page.waitForSelector('.subagent-panel',{hidden:true});
      assert.ok(await page.$('.thread-head'));
    }));


    await t.test('subagent columns follow concurrent lifecycles and retain isolated history across reconnect and reload',()=>withPage(async page=>{
      await page.setViewport({width:2400,height:1000});
      let taskId, snapshots=0, historyReads=0;
      const detailReads=new Set();
      const started=Date.now()-5000;
      const timestamp=seconds=>new Date(started+seconds*1000).toISOString();
      const screenshot=async suffix=>{
        if(!process.env.DESK_SUBAGENT_SCREENSHOT)return;
        const target=resolve(process.env.DESK_SUBAGENT_SCREENSHOT);
        assert.ok(target.startsWith('/private/tmp/')||target.startsWith('/tmp/'),'comparison screenshot must use a system temporary directory');
        const path=suffix?target.slice(0,target.length-extname(target).length)+'-'+suffix+'.png':target;
        await page.screenshot({path});
      };
      let agents=[], events=[];
      const send=message=>page.evaluate(message=>fetch('/__fixture/subagent-message',{method:'POST',body:JSON.stringify(message)}),message);
      const respond=(request,body)=>void request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const url=new URL(request.url()), path=url.pathname;
        if(path==='/api/state'){
          const state=interactionData(24)(url);state.tasks=state.tasks.map(t=>({...t,source:'app'}));
          return respond(request,state);
        }
        const list=/\/tasks\/([^/]+)\/subagents$/.exec(path);
        if(list){snapshots++;return respond(request,list[1]===taskId?agents:[]);}
        const history=/\/tasks\/([^/]+)\/subagents\/history$/.exec(path);
        if(history){historyReads++;return respond(request,{events:history[1]===taskId?events:[],more:false});}
        const detail=/\/tasks\/([^/]+)\/subagents\/([^/]+)\/events$/.exec(path);
        if(detail){detailReads.add(decodeURIComponent(detail[2]));return respond(request,{events:events.filter(e=>e.task_id===detail[1]&&e.subagent_id===decodeURIComponent(detail[2])),more:false});}
        void request.continue();
      });
      const open=async()=>{
        await page.waitForSelector('[data-post]');await page.click('[data-post]');
        await page.waitForSelector('.thread');
        await page.click('[aria-label="서브 에이전트 창"]');
        await page.waitForSelector('[data-column="history"]');
      };
      await page.goto(origin,{waitUntil:'networkidle2'});
      await page.waitForSelector('.column:not(.sa-col) [data-post]');
      await screenshot('all');
      await open();
      taskId=await page.$eval('.thread',e=>e.dataset.task);
      assert.equal(await page.$$eval('.sa-col',nodes=>nodes.length),1,'empty history column stays present');
      const base={task_id:taskId,session_id:'parallel-session',type:'local_agent',background:true,detailed:true,
        created_at:timestamp(0),updated_at:timestamp(1),status:'running'};
      await page.setViewport({width:1280,height:900});
      agents=[1,2,3].map(n=>({...base,id:'worker-'+n,description:'동시 작업 '+n}));
      for(const agent of agents)await send({type:'subagent',subagent:agent});
      const activeColumns=()=>page.$$eval('.sa-col[data-column]',nodes=>nodes.map(n=>n.dataset.column).filter(k=>k!=='history'&&k!=='commands').sort());
      await page.waitForFunction(()=>document.querySelectorAll('.sa-col').length===4);
      assert.deepEqual(await activeColumns(),agents.map(a=>a.session_id+'/'+a.id));
      await page.waitForFunction(()=>document.querySelector('.sa-cols').scrollWidth>document.querySelector('.sa-cols').clientWidth);
      assert.ok(!detailReads.has('worker-3'),'offscreen agent does not request details at startup');
      await Promise.all([page.waitForResponse(r=>r.url().includes('/worker-3/events')),page.$eval('.sa-cols',e=>{e.scrollLeft=e.scrollWidth;})]);
      await page.setViewport({width:2400,height:1000});
      assert.equal(await page.$('.sa-strip'),null);
      assert.equal(await page.$('.sa-col [aria-label="컬럼 닫기"]'),null);
      for(const agent of agents) {
        const selector=`[data-column="${agent.session_id}/${agent.id}"]`;
        const fetched=detailReads.has(agent.id)?undefined:page.waitForResponse(r=>r.url().includes('/'+agent.id+'/events'));
        await page.$eval(selector,e=>e.scrollIntoView({inline:'start'}));
        await fetched;
      }
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.sa-col')).every(el=>Math.abs(el.getBoundingClientRect().width-document.querySelector('[data-col="thread"]').getBoundingClientRect().width)<1));
      assert.equal(await page.$$eval('.sa-col.thread-surface > .thread-head',nodes=>nodes.length),3);
      events=agents.map((a,i)=>({id:12000+i,task_id:taskId,session_id:a.session_id,subagent_id:a.id,
        kind:'assistant',ts:timestamp(2),payload:{text:'검증 본문 '+a.id}}));
      for(const event of events){await send({type:'subagent_event',event});await send({type:'subagent_event',event});}
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.sa-col:not([data-column="history"]) .post')).filter(n=>n.textContent.includes('검증 본문')).length===3);
      assert.ok(!(await page.$eval('[data-column="history"]',e=>e.textContent)).includes('검증 본문'),'running agents retain their bodies only in individual columns');
      await page.$eval('.sa-col.thread-surface',el=>el.scrollIntoView({behavior:'instant',inline:'start',block:'nearest'}));
      await screenshot('active');
      await send({type:'subagent_event',event:{...events[0],id:13000,task_id:'foreign-parent',payload:{text:'다른 부모의 본문'}}});
      await send({type:'subagent',subagent:{...agents[0],task_id:'foreign-parent',id:'foreign-worker',description:'다른 부모의 작업'}});
      agents[0]={...agents[0],status:'completed',updated_at:timestamp(3),summary:'첫 작업의 요약 결과'};
      await send({type:'subagent',subagent:agents[0]});
      await page.waitForFunction(()=>document.querySelectorAll('.sa-col').length===3);
      assert.deepEqual(await activeColumns(),agents.slice(1).map(a=>a.session_id+'/'+a.id));
      const verifyHistory=async()=>{
        await page.waitForFunction(()=>document.querySelector('[data-column="history"]')?.textContent.includes('검증 본문 worker-1')&&document.querySelector('[data-column="history"]')?.textContent.includes('첫 작업의 요약 결과'));
        const bodies=await page.$$eval('[data-column="history"] .post',nodes=>nodes.map(n=>n.textContent).join('\n'));
        assert.equal(bodies.split('검증 본문 worker-1').length-1,1,'repeated event is represented once');
        assert.ok(bodies.includes('첫 작업의 요약 결과'),'summary is rendered as a post');
        assert.ok(!(await page.$eval('.subagent-panel',e=>e.textContent)).includes('다른 부모의'));
      };
      await verifyHistory();
      await screenshot('');
      const before={snapshots,historyReads};
      await page.evaluate(()=>fetch('/__fixture/subagent-reconnect',{method:'POST'}));
      const deadline=Date.now()+10000;
      while((snapshots<=before.snapshots||historyReads<=before.historyReads)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      assert.ok(snapshots>before.snapshots&&historyReads>before.historyReads,'reconnect reloads list and shared history');
      await verifyHistory();assert.equal((await activeColumns()).length,2);
      await page.reload({waitUntil:'networkidle2'});
      if(!await page.$('.thread'))await open();
      else if(!await page.$('[data-column="history"]'))await page.click('[aria-label="서브 에이전트 창"]');
      await page.waitForFunction(()=>document.querySelectorAll('.sa-col').length===3);
      await verifyHistory();assert.equal((await activeColumns()).length,2);
      for(const [index,status] of ['failed','stopped'].entries()){
        agents[index+1]={...agents[index+1],status,updated_at:timestamp(4)};
        await send({type:'subagent',subagent:agents[index+1]});
      }
      for(const [index,status] of ['ended','unknown'].entries()){
        const agent={...base,id:'past-'+index,status,description:'과거 상태 '+status,summary:'과거 요약 '+status};
        agents.push(agent);await send({type:'subagent',subagent:agent});
      }
      await page.waitForFunction(()=>document.querySelectorAll('.sa-col').length===1);
      await page.waitForFunction(()=>document.querySelector('[data-column="history"]')?.textContent.includes('과거 요약 unknown'));
      const finalHistory=await page.$eval('[data-column="history"]',e=>e.textContent);
      for(const agent of agents.slice(0,3))assert.equal(finalHistory.split('검증 본문 '+agent.id).length-1,1,'all completed bodies are retained once');
      assert.ok(finalHistory.includes('과거 요약 ended'));
    },false,'emacs'));


    await t.test('subagent history retains an older page and its scroll anchor when another agent finishes',()=>withPage(async page=>{
      await page.setViewport({width:2400,height:1000});
      let taskId, agents=[], completedB=false;
      const historyRequests=[], detailRequests=[];
      const timestamp=id=>new Date(Date.UTC(2026,0,1)+id*1000).toISOString();
      const event=(id,agent='a')=>({id,task_id:taskId,session_id:'retention-session',subagent_id:agent,
        kind:'assistant',ts:timestamp(id),payload:{text:`보존 검증 ${agent} ${id}`}});
      const aEvents=()=>Array.from({length:591},(_,i)=>event(i+10));
      const respond=(request,body)=>void request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
      const send=message=>page.evaluate(message=>fetch('/__fixture/subagent-message',{method:'POST',body:JSON.stringify(message)}),message);
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const url=new URL(request.url()), path=url.pathname;
        if(path==='/api/state'){
          const state=interactionData(24)(url);state.tasks=state.tasks.map(t=>({...t,source:'app'}));
          return respond(request,state);
        }
        const list=/\/tasks\/([^/]+)\/subagents$/.exec(path);
        if(list)return respond(request,list[1]===taskId?agents:[]);
        const history=/\/tasks\/([^/]+)\/subagents\/history$/.exec(path);
        if(history){
          const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined;
          historyRequests.push({before,completedB});
          const all=history[1]===taskId&&agents.some(a=>a.id==='a'&&a.status==='completed')?aEvents():[];
          // B's old body is below even A's previously loaded boundary. Its own endpoint must supply it.
          if(completedB)all.push(event(5,'b'));
          all.sort((a,b)=>a.id-b.id);
          const eligible=all.filter(e=>before===undefined||e.id<before);
          return respond(request,{events:eligible.slice(-500),more:eligible.length>500});
        }
        const detail=/\/tasks\/([^/]+)\/subagents\/([^/]+)\/events$/.exec(path);
        if(detail){
          detailRequests.push({agent:detail[2],before:url.searchParams.get('before'),completedB});
          if(detail[2]==='b'&&!completedB){
            const older=url.searchParams.has('before');
            const rows=Array.from({length:30},(_,i)=>event((older?601:631)+i,'b'));
            rows[older?29:0]={...rows[older?29:0],kind:older?'tool':'tool_result',payload:older?{name:'Read',toolUseId:'edge',input:{}}:{toolUseId:'edge',text:'경계 결과'}};
            return respond(request,{events:rows,more:!older});
          }
          return respond(request,{events:detail[2]==='b'&&completedB?[event(5,'b')]:[],more:false});
        }
        void request.continue();
      });
      await page.goto(origin,{waitUntil:'networkidle2'});
      await page.waitForSelector('[data-post]');await page.click('[data-post]');
      await page.waitForSelector('.thread');
      taskId=await page.$eval('.thread',e=>e.dataset.task);
      const base={task_id:taskId,session_id:'retention-session',type:'local_agent',background:true,detailed:true,
        created_at:timestamp(0),updated_at:timestamp(601)};
      agents=[{...base,id:'a',description:'기존 완료 A',status:'completed'},
        {...base,id:'b',description:'새 완료 B',status:'running'}];
      for(const subagent of agents)await send({type:'subagent',subagent});
      await page.click('[aria-label="서브 에이전트 창"]');
      const active='[data-column="retention-session/b"]';
      await page.waitForSelector(active);
      await page.$eval(active,e=>e.scrollIntoView({inline:'start'}));
      const resultCard=active+' .post .activity .summary';
      await page.waitForSelector(resultCard);
      // Expand without scrolling the feed to the top (which would load the preceding call).
      await page.$eval(resultCard,e=>e.click());
      assert.equal(await page.$eval(active+' .activity pre.result',e=>e.textContent),'경계 결과');
      const reader=active+' .sa-feed', anchor=active+' [data-post="632"]';
      const activeOffset=()=>page.$eval(anchor,e=>e.getBoundingClientRect().top-e.closest('.sa-feed').getBoundingClientRect().top);
      const expectedOffset=await page.$eval(reader,f=>{
        f.scrollTop=1;
        return f.querySelector('[data-post="632"]').getBoundingClientRect().top-f.getBoundingClientRect().top;
      });
      await page.waitForSelector(active+' [data-post="601"]');
      assert.ok(Math.abs(await activeOffset()-expectedOffset)<=2,'loading an earlier page keeps the current text in place');
      const history='[data-column="history"]';
      await page.$eval(history,e=>e.scrollIntoView({inline:'start'}));
      const oldCard=`${history} [data-history-key="retention-session/a/10"]`;
      await page.waitForSelector(`${history} [data-history-key="retention-session/a/101"]`);
      assert.equal(await page.$(oldCard),null,'initial latest 500 excludes A event 10');
      await page.click(`${history} .sa-older`);
      await page.waitForSelector(oldCard);
      await page.waitForFunction(()=>!document.querySelector('[data-column="history"] .sa-note'));
      assert.ok(historyRequests.some(r=>r.before===101),'the reader explicitly loaded the older page');
      await page.$eval(oldCard,e=>{
        const feed=e.closest('.sa-feed');
        feed.scrollTop+=e.getBoundingClientRect().top-feed.getBoundingClientRect().top-120;
        window.retainedHistoryCard=e;
      });
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const offset=()=>page.$eval(oldCard,e=>e.getBoundingClientRect().top-e.closest('.sa-feed').getBoundingClientRect().top);
      const beforeOffset=await offset();
      const feedHeight=await page.$eval(`${history} .sa-feed`,e=>e.clientHeight);
      assert.ok(beforeOffset>=0&&beforeOffset<feedHeight,'A event 10 is the visible reading anchor');
      completedB=true;
      agents[1]={...agents[1],status:'completed',updated_at:timestamp(602)};
      await send({type:'subagent',subagent:agents[1]});
      // No click or user-triggered previous-page request follows B's completion.
      await page.waitForSelector(`${history} [data-history-key="retention-session/b/5"]`);
      await page.waitForFunction(()=>!document.querySelector('[data-column="history"] .sa-note'));
      assert.ok(detailRequests.some(r=>r.agent==='b'&&r.completedB&&r.before===null),'new member B is backfilled from its latest individual page');
      assert.ok(historyRequests.some(r=>r.completedB&&r.before===undefined),'completion refreshes shared latest history, whose 500 events exclude A event 10');
      assert.equal(await page.$eval(oldCard,e=>e===window.retainedHistoryCard),true,'previously read A card remains the same DOM node');
      assert.ok(Math.abs(await offset()-beforeOffset)<=2,'A event 10 retains its viewport offset without another previous-page action');
      assert.equal(await page.$$eval(`${history} [data-history-key="retention-session/a/10"]`,nodes=>nodes.length),1);
      agents[0]={...agents[0],status:'running',updated_at:timestamp(603)};
      await send({type:'subagent',subagent:agents[0]});
      await page.waitForSelector('[data-column="retention-session/a"]');
      await page.waitForFunction(()=>!document.querySelector('[data-column="history"] [data-subagent="retention-session/a"]'));
      assert.ok(await page.$(`${history} [data-history-key="retention-session/b/5"]`),'resuming A leaves B history intact');
    },false,'emacs'));


    await t.test('subagent header snapshot ignores foreground guards before history exists',()=>withPage(async page=>{
      await page.setRequestInterception(true);
      let tasks;
      const guards=[{id:'tool',type:'tool',description:'foreground'},{id:'status',type:'status',description:'조회 중'},
        {id:'legacy',type:'shell',description:'unproven'}];
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/state'){
          const state=interactionData(24)(new URL(request.url()));
          state.tasks=state.tasks.map(t=>({...t,source:'app',background:guards}));tasks=state.tasks;
          return void request.respond({status:200,contentType:'application/json',body:JSON.stringify(state)});
        }
        if(/\/tasks\/[^/]+\/subagents$/.test(path))return void request.respond({status:200,contentType:'application/json',body:'[]'});
        void request.continue();
      });
      await openReply(page,origin);await page.waitForSelector('[aria-label="서브 에이전트 창"]');
      assert.equal(await page.$('[aria-label="서브 에이전트 창"] span'),null);
      const id=await page.$eval('.thread',e=>e.dataset.task);
      const task=tasks.find(t=>t.id===id);
      await page.evaluate(message=>fetch('/__fixture/subagent-message',{method:'POST',body:JSON.stringify(message)}),{
        type:'task',task:{...task,background:[...guards,{id:'native',type:'shell',description:'background',backgroundEvidence:'native'},
          {id:'child',type:'local_agent',description:'child'}]},
      });
      await page.waitForFunction(()=>document.querySelector('[aria-label="서브 에이전트 창"] span')?.textContent==='2');
    }));

    for (const width of [1440,390]) await t.test(`code Escape closes only the panel after focus changes (${width})`, () => withPage(async page => {
      await page.setViewport({width,height:900});
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/prompt-templates')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({items:[],revision:'empty'})});
        if(path!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());
        void request.respond({status:200,contentType:'application/json',body:JSON.stringify({root:'/test',head:'a'.repeat(40),commit:body.commit,commits:[{id:'b'.repeat(40),subject:'commit'}],branches:[{ref:'refs/heads/main',id:'a'.repeat(40)}],files:[{path:'a.ts',status:'modified'},{path:'b.ts',status:'modified'}],...(body.path?{path:body.path,diff:'@@ -1 +1 @@\n-old();\n+newCode();\n'}:{})})});
      });
      await openReply(page,origin);
      const open=async()=>{await page.click('[aria-label="코드 변경 보기"]');await page.waitForSelector('.code-line.add');};
      const closed=async()=>{
        await page.keyboard.press('Escape');await page.waitForSelector('.code-panel',{hidden:true});
        assert.ok(await page.$('.thread-head'),'Escape must keep the current thread');
      };
      await page.click('[aria-label="코드 변경 보기"]');await closed(); // No data/bundle readiness wait.
      for(const focus of ['opener','commit','file','body','line']){
        await open();
        if(focus==='commit'){await page.select('[aria-label="변경 기준"]','b'.repeat(40));await page.focus('[aria-label="변경 기준"]');}
        if(focus==='file'){const file=`.code-file[data-file-key='${JSON.stringify(['tracked','b.ts'])}']`;await page.click(file);await page.focus(file);}
        if(focus==='body')await page.click('.code-diff');
        if(focus==='line'){
          await page.click('.code-line.add');await page.keyboard.press('Escape');
          assert.equal(await page.$('.code-line.quoted'),null,'first Escape lets the picked lines go');
          assert.ok(await page.$('.code-panel'),'the panel stays while lines were picked');
        }
        await closed();
      }
      await open();
      await page.click('.code-branches summary');await page.keyboard.press('Escape');
      assert.ok(await page.$('.code-panel'),'first Escape closes internal disclosure only');
      assert.equal(await page.$eval('.code-branches',e=>e.open),false);await closed();
      await open();await page.focus('[aria-label="변경 기준"]');await page.keyboard.down('Alt');await page.keyboard.press('ArrowDown');await page.keyboard.up('Alt');
      await page.waitForFunction(()=>document.querySelector('[aria-label="변경 기준"]').matches(':open'));
      await page.keyboard.press('Escape');
      assert.ok(await page.$('.code-panel'),'native select consumes its own Escape');
      await page.waitForFunction(()=>!document.querySelector('[aria-label="변경 기준"]').matches(':open'));await closed();
      await open();await page.click('.code-line.add');await page.click('[aria-label="템플릿 관리"]');
      await page.waitForSelector('[role="dialog"]');await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]',{hidden:true});assert.ok(await page.$('.code-panel'),'dialog closes before the panel');
      assert.ok(await page.$('.code-line.quoted'),'the dialog keeps the picked lines');
      await page.focus('.code-diff');await page.keyboard.press('Escape');assert.equal(await page.$('.code-line.quoted'),null);await closed();
      await open();await page.focus('.code-diff');
      await page.$eval('.code-diff',e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true})));
      assert.ok(await page.$('.code-panel'),'IME cancellation does not close the panel');await closed();
      if(await page.$('.compose'))await page.click('.compose [aria-label="닫기"]');
      await page.waitForSelector('.compose',{hidden:true});
      await open();await page.click('button[aria-label="새 작업"]');
      await page.waitForSelector('.compose');await page.focus('.compose [aria-label="닫기"]');
      if(width===390)assert.equal(await page.$eval('.deck-space',e=>e.inert),true,'drawer covers the code panel');
      await page.keyboard.press('Escape');await page.waitForSelector('.compose',{hidden:true});
      assert.ok(await page.$('.code-panel'),'foreground compose closes before code');
      assert.ok(await page.$('.thread-head'),'foreground compose keeps the thread');
      await closed();
      await page.keyboard.press('Escape');await page.waitForSelector('.thread-head',{hidden:true});
    }));

    await t.test('code panel keys, filter and picks hold across keyboard, Korean input and scope changes', () => withPage(async page => {
      await page.setViewport({width:1440,height:900});
      const seven=Array.from({length:7},(_,i)=>({path:`src/${i%2?'odd':'even'}${i}.ts`,status:'modified'}));
      const two=[{path:'z.ts',status:'modified'},{path:'src/y.ts',status:'modified'}];
      // The second hunk sits near the end, so it cannot scroll to the top of the pane.
      const diff='@@ -10,2 +3,2 @@\n-a\n-b\n+c\n+d\n'+Array.from({length:80},(_,i)=>' c'+i).join('\n')+'\n@@ -100,2 +100,2 @@\n-x\n+y\n ctx\n';
      let templateReads=0;
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/prompt-templates'){templateReads++;return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({items:[{id:'t1',name:'리뷰',text:'리뷰해 주세요'}],revision:'r'})});}
        if(path!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());
        void request.respond({status:200,contentType:'application/json',body:JSON.stringify({root:'/test',head:'a'.repeat(40),commit:body.commit,commits:[{id:'b'.repeat(40),subject:'commit'}],files:body.commit?two:seven,...(body.path?{path:body.path,diff}:{})})});
      });
      await openReply(page,origin);
      await page.click('[aria-label="코드 변경 보기"]');await page.waitForSelector('.code-line.add');
      const hunk=()=>page.$eval('.code-hunks small',e=>e.textContent);
      await page.focus('.code-diff');await page.keyboard.press('n');
      await page.waitForFunction(()=>document.querySelector('.code-hunks small').textContent==='헝크 2 / 2');
      await new Promise(resolve=>setTimeout(resolve,300));
      assert.equal(await hunk(),'헝크 2 / 2','a jump to a hunk near the end is not undone by its own scroll');
      await page.$eval('.code-diff',e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'ㅔ',code:'KeyP',bubbles:true,cancelable:true})));
      await page.waitForFunction(()=>document.querySelector('.code-hunks small').textContent==='헝크 1 / 2');
      // Keyboard picking: one tab stop for the signs; Enter picks a line, Shift+ArrowDown extends.
      assert.equal(await page.$$eval('button.code-sign[tabindex="0"]',n=>n.length),1,'the line signs are one tab stop');
      await page.focus('button.code-sign[tabindex="0"]');
      await page.keyboard.down('Shift');for(let i=0;i<3;i++)await page.keyboard.press('ArrowDown');await page.keyboard.up('Shift');
      assert.equal(await page.$$eval('.code-line.quoted',n=>n.length),4,'Shift+Arrow without a pick extends from the starting line');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-diff-row]')?.dataset.diffRow),'4','Escape keeps focus on the line');
      await page.keyboard.press('Tab');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
      assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-diff-row]')?.dataset.diffRow),'4','the tab stop follows the focused line');
      await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
      await page.keyboard.down('Shift');for(let i=0;i<3;i++)await page.keyboard.press('ArrowDown');await page.keyboard.up('Shift');
      assert.equal(await page.$$eval('.code-line.quoted',n=>n.length),4,'keyboard picks a range');
      assert.match(await page.$eval('.code-actions .code-range',e=>e.textContent),/ 3–4$/,'the range uses one side of the numbers');
      await page.waitForSelector('[aria-label="코드 프롬프트 템플릿"] option[value="t1"]');
      await page.select('[aria-label="코드 프롬프트 템플릿"]','t1');
      await page.click('.code-actions [aria-label="선택 해제"]');
      assert.equal(await page.$('.code-actions'),null);
      await page.keyboard.press('n');
      await page.waitForFunction(()=>document.querySelector('.code-hunks small').textContent==='헝크 2 / 2');
      await page.click('.code-line.add');
      assert.equal(await page.$eval('[aria-label="코드 프롬프트 템플릿"]',e=>e.value),'t1','the template survives a new pick');
      assert.equal(templateReads,1,'templates are read once, not on every pick');
      await page.click('.code-hunks small');await page.keyboard.press('Escape');
      assert.equal(await page.$('.code-line.quoted'),null,'Escape after a click on plain panel text lets the pick go');
      assert.ok(await page.$('.code-panel'));
      await page.click('.code-hunks small');
      const deskKeys=await page.evaluate(()=>{
        const seen=[];
        const record=e=>{seen.push(e.key);e.stopImmediatePropagation();};
        document.addEventListener('keydown',record);
        try{
          for(const init of [{key:'s'},{key:'?'},{key:';',code:'Semicolon',ctrlKey:true}])
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{...init,bubbles:true,cancelable:true}));
        }finally{document.removeEventListener('keydown',record);}
        return seen;
      });
      assert.deepEqual(deskKeys,['?',';'],'after clicking plain panel text only help and references reach the desk');
      // The filter: ] stays within the shown files; a shorter list after a scope change is not filtered.
      await page.type('.code-file-filter','even');await page.keyboard.press('Tab');
      await page.focus('button.code-sign[tabindex="0"]');await page.keyboard.press(']');
      await page.waitForFunction(()=>document.querySelector('.code-file[aria-pressed=true]')?.title==='src/even2.ts');
      assert.ok(await page.$eval('.code-diff',e=>e===document.activeElement),'switching files from a line keeps keyboard focus in the diff');
      await page.keyboard.press(']');
      await page.waitForFunction(()=>document.querySelector('.code-file[aria-pressed=true]')?.title==='src/even4.ts');
      await page.select('[aria-label="변경 기준"]','b'.repeat(40));
      await page.waitForFunction(()=>document.querySelectorAll('.code-file').length===2);
      assert.deepEqual(await page.$$eval('.code-files .code-dir-name, .code-files .code-file',n=>n.map(e=>e.title||e.textContent)),['z.ts','src','src/y.ts'],'root files come before folders');
      // A drag held below the diff scrolls it and keeps extending the pick.
      await page.waitForSelector('.code-line.add');
      const pane=await page.$eval('.code-diff',e=>{e.scrollTop=0;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,top:b.top,bottom:b.bottom};});
      await page.mouse.move(pane.x,pane.top+30);await page.mouse.down();await page.mouse.move(pane.x,pane.bottom+20,{steps:4});
      await page.waitForFunction(()=>document.querySelector('.code-diff').scrollTop>100);await page.mouse.up();
      assert.ok(await page.$$eval('.code-line.quoted',n=>n.length)>10,'the pick follows the scrolled edge');
      // The release settles the pick on the line under it, even when no move reached that line first.
      await page.$eval('.code-diff',e=>{e.scrollTop=0;});
      const ends=await page.$$eval('[data-diff-row="1"], [data-diff-row="5"]',n=>n.map(e=>{const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};}));
      await page.mouse.move(ends[0].x,ends[0].y);await page.mouse.down();
      await page.evaluate(({x,y})=>window.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true})),ends[1]);
      await page.mouse.up();
      assert.equal(await page.$$eval('.code-line.quoted',n=>n.length),5,'the release settles on the line under it');
    }));

    await t.test('code panel picks lines by tap on touch and scrolls on a finger drag', () => withPage(async page => {
      await page.setViewport({width:390,height:800,hasTouch:true,isMobile:true});
      const diff='@@ -1,80 +1,80 @@\n'+Array.from({length:80},(_,i)=>'+line'+i).join('\n')+'\n';
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/prompt-templates')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({items:[],revision:'r'})});
        if(path!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());
        void request.respond({status:200,contentType:'application/json',body:JSON.stringify({root:'/test',head:'a'.repeat(40),files:[{path:'a.ts',status:'modified'}],...(body.path?{path:body.path,diff}:{})})});
      });
      await openReply(page,origin);
      await page.click('[aria-label="코드 변경 보기"]');await page.waitForSelector('.code-line.add');
      const box=await page.$eval('.code-diff',e=>{const b=e.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height*0.7)};});
      const cdp=await page.createCDPSession();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[box]});
      for(let i=1;i<=10;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x,y:box.y-20*i}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      // Wait for the fling to stop, or the taps land on lines that are still moving.
      for(let last=-1,still=0;still<3;){const now=await page.$eval('.code-diff',e=>e.scrollTop);still=now===last?still+1:0;last=now;await new Promise(resolve=>setTimeout(resolve,150));}
      assert.ok(await page.$eval('.code-diff',e=>e.scrollTop>0),'a finger drag scrolls the diff');
      assert.equal(await page.$('.code-line.quoted'),null,'scrolling picks nothing');
      const lines=await page.$$('.code-line.add');
      await lines[30].tap();await lines[32].tap();
      assert.equal(await page.$$eval('.code-line.quoted',n=>n.length),3,'a tap picks and a second tap extends');
    }));

    for (const width of [1440,390]) await t.test(`code view stays beside conversation with highlighted diff and refreshes removed files (${width})`, () => withPage(async page => {
      await page.setViewport({width:width===1440?2000:width,height:900});
      const commit='1'.repeat(40);
      const longLineText='const token = '+JSON.stringify('x'.repeat(500))+';';
      let removed=false,reads=0;const requests=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(new URL(request.url()).pathname!=='/api/code-view')return void request.continue();
        reads++;
        const body=JSON.parse(request.postData());requests.push(body);
        return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({
          root:'/test/worktree',head:'1234567890abcdef',commits:[{id:commit,subject:'첫 커밋'}],commit:body.commit,files:removed?[]:[{path:'src/example.ts',status:'deleted'},{path:'src/example.ts',status:'untracked'},{path:'src/second.ts',status:'modified'}],
          ...(body.path&&!removed?{path:body.path,diff:'--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,1 +1,2 @@\n-const old = 1;\n+const value = "hello";\n+'+longLineText+'\n'}:{}),
        })});
      });
      await openReply(page,origin);
      await page.type('.reply-box textarea','검토 부탁');
      assert.equal(reads,0,'do not read code before opening the panel');
      await page.click('button[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-panel .hljs-keyword');
      assert.ok(await page.$('.deck-space > .code-panel'),'code opens inside the pinned document area');
      if(width===1440)assert.ok(await page.evaluate(()=>{
        const code=document.querySelector('.code-panel').getBoundingClientRect();
        const thread=document.querySelector('.thread-split').getBoundingClientRect();
        return code.right <= thread.left;
      }),'code is to the left of the conversation');
      const axis=width===1440?'width':'height';
      await page.waitForFunction(axis=>getComputedStyle(document.querySelector('.code-file-divider')).cursor===(axis==='width'?'col-resize':'row-resize'),{},axis);
      const fileSize=()=>page.$eval('.code-files',(e,axis)=>e.getBoundingClientRect()[axis],axis);
      const initial=await fileSize();
      const divider=await page.$('.code-file-divider');
      const grip=await divider.boundingBox();
      const x=grip.x+grip.width/2,y=grip.y+grip.height/2;
      await page.mouse.move(x,y);await page.mouse.down();
      await page.mouse.move(x+(axis==='width'?60:0),y+(axis==='height'?60:0));await page.mouse.up();
      assert.ok(Math.abs(await fileSize()-initial-60)<2,`drag on ${axis}: ${initial} → ${await fileSize()}`);
      assert.ok(await page.evaluate(axis=>Number(localStorage.getItem('desk.codeFiles.'+axis))>0,axis));
      await divider.click({count:2});
      const defaultSize=axis==='width'?await page.$eval('.code-main',e=>e.clientWidth*0.3):initial;
      assert.ok(Math.abs(await fileSize()-defaultSize)<2,`reset on ${axis}: ${defaultSize} → ${await fileSize()}`);
      const wrapControl='input[aria-label="코드 diff 긴 줄 자동 줄바꿈"]';
      const toggleWrap=async()=>{
        await page.$eval('.settings-button',button=>button.click());
        await page.waitForSelector(wrapControl);
        await page.click(wrapControl);
        await page.click('[role="dialog"][aria-label="설정"] button[aria-label="닫기"]');
      };
      const longLine=()=>page.$eval('.code-diff',pane=>pane.scrollWidth>pane.clientWidth);
      assert.equal(await longLine(),false,'long tokens wrap by default');
      await toggleWrap();
      assert.equal(await longLine(),true,'disabling wrap restores horizontal scroll');
      await toggleWrap();
      assert.equal(await longLine(),false,'restoring wrap removes horizontal scroll again');
      assert.ok(await page.$eval('.code-panel',panel=>{
        const box=panel.getBoundingClientRect(),basis=panel.querySelector('[aria-label="변경 기준"]').getBoundingClientRect(),
          files=panel.querySelector('nav[aria-label="변경 파일"]').getBoundingClientRect(),diff=panel.querySelector('.code-diff').getBoundingClientRect();
        return basis.width>0 && files.width>0 && basis.right<=box.right+1 && files.right<=box.right+1 && diff.width>0;
      }),'the basis selector, file tree and diff stay within the panel');
      assert.equal(await page.$$eval('nav[aria-label="변경 파일"] .code-file',nodes=>nodes.length),3,'every changed file is listed, both versions of a path apart');
      assert.equal(reads,2,'opening reads the list once and the first file once');
      assert.equal(requests[1].kind,'tracked');
      assert.equal(await page.$eval('.code-line.add .code-number:nth-child(2)',element=>element.textContent),'1');
      assert.equal(await page.$eval('.code-line.add code',element=>element.textContent),'const value = "hello";');
      assert.ok(await page.$('.reply-box'),'conversation remains mounted');
      assert.ok(await page.$eval('.code-panel',element=>element.getBoundingClientRect().right<=innerWidth),'panel controls stay inside the viewport');
      await page.click('.code-line.delete');
      assert.equal(await page.$eval('.quote-code',b=>b.disabled),false);
      // A tree click shows its loading state on the next render: wait for that file's own response.
      const detail=(path,kind)=>page.waitForResponse(response=>new URL(response.url()).pathname==='/api/code-view'&&JSON.parse(response.request().postData()).path===path&&JSON.parse(response.request().postData()).kind===kind);
      const untrackedRead=detail('src/example.ts','untracked');
      await page.click(`.code-file[data-file-key='${JSON.stringify(['untracked','src/example.ts'])}']`);
      await untrackedRead;
      await page.waitForFunction(()=>!document.querySelector('.code-panel [role="status"]'));
      assert.equal(reads,3,'selecting the untracked version reads only that detail');
      assert.equal(requests[2].kind,'untracked');
      assert.equal(await page.$('.quote-code'),null,'selection does not cross files');
      const secondRead=detail('src/second.ts','tracked');
      await page.click(`.code-file[data-file-key='${JSON.stringify(['tracked','src/second.ts'])}']`);
      await secondRead;
      await page.waitForFunction(()=>!document.querySelector('.code-panel [role="status"]'));
      assert.equal(reads,4,'switching files does not refresh the list');
      assert.equal(requests[3].path,'src/second.ts');
      const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/code-view'&&JSON.parse(response.request().postData()).path==='src/second.ts');
      await page.click('button[aria-label="코드 새로고침"]');
      await refreshed;
      await page.waitForFunction(()=>!document.querySelector('.code-panel [role="status"]'));
      assert.equal(reads,6,'refresh reads one list and the selected detail');
      removed=true;
      await page.click('button[aria-label="코드 새로고침"]');
      await page.waitForFunction(()=>document.querySelector('.code-panel')?.textContent.includes('미커밋 변경이 없습니다.'));
      assert.equal(reads,7,'an empty refreshed list needs no detail');
      removed=false;
      await page.select('select[aria-label="변경 기준"]',commit);
      await page.waitForSelector('.code-panel .code-line.add');
      assert.deepEqual(requests.slice(7).map(body=>[body.commit,body.path]),[[commit,undefined],[commit,'src/example.ts']]);
      await toggleWrap();
      await page.click('button[aria-label="코드 창 닫기"]');
      assert.equal(await page.$('.code-panel'),null);
      await page.click('button[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-diff:not(.wrap)');
      assert.equal(await page.evaluate(()=>localStorage.getItem('agent-desk.diff-wrap')),'off','wrap preference survives reopening');
      await page.waitForSelector('.code-line.delete');
      await toggleWrap();
      // Dragging from the deleted line to the last added line picks all three.
      const at=selector=>page.$eval(selector,node=>{const box=node.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+Math.min(8,box.height/2)};});
      const from=await at('.code-line.delete'),to=await at('.code-line.add:last-child');
      await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:5});await page.mouse.up();
      assert.equal(await page.$$eval('.code-line.quoted',nodes=>nodes.length),3,'dragging picks the lines it crosses');
      await page.click('.quote-code');
      const quote=await page.$eval('.reply-box textarea',node=>node.value);
      assert.ok(quote.startsWith('검토 부탁\n\n'));
      assert.ok(quote.includes('이전 1 / 이후 1–2'));
      assert.ok(quote.includes('-const old = 1;\n+const value = "hello";\n+'+longLineText));
      assert.ok(quote.includes('src/example.ts'));
      if(width===390)assert.equal(await page.$('.code-panel'),null);


    },false,'emacs'));

    for (const width of [1440,390]) await t.test(`code view recovers file selection after failed list refresh (${width})`, () => withPage(async page => {
      await page.setViewport({width,height:900});
      let failList=false,failDetail=false;const requests=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(new URL(request.url()).pathname!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());requests.push(body);
        if((!body.path&&failList)||(body.path&&failDetail))return void request.respond({status:500,contentType:'application/json',body:JSON.stringify({error:'temporary failure'})});
        return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({
          root:'/test/worktree',head:'1234567890abcdef',files:['a.ts','b.ts'].map(path=>({path,status:'modified'})),
          ...(body.path?{path:body.path,diff:`@@ -0,0 +1 @@\n+const file = "${body.path}";\n`}:{}),
        })});
      });
      const waitFile=path=>page.waitForFunction(path=>document.querySelector('.code-panel .code-line.add code')?.textContent.includes(path)&&!document.querySelector('.code-panel [role="status"]'),{},path);
      await openReply(page,origin);
      await page.click('button[aria-label="코드 변경 보기"]');
      await waitFile('a.ts');
      failList=true;
      await page.click('button[aria-label="코드 새로고침"]');
      await page.waitForFunction(()=>document.querySelector('.code-panel [role="alert"]')?.textContent.includes('목록 갱신 실패')&&!document.querySelector('.code-panel [role="status"]'));
      const listReads=requests.filter(body=>!body.path).length;
      await page.click(`.code-file[data-file-key='${JSON.stringify(['tracked','b.ts'])}']`);
      await waitFile('b.ts');
      assert.equal(requests.at(-1).path,'b.ts');
      assert.equal(requests.filter(body=>!body.path).length,listReads,'selection after failure only reads detail');
      failList=false;failDetail=true;
      const detailFailure=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/code-view'&&JSON.parse(response.request().postData()).path==='b.ts'&&response.status()===500);
      await page.click('button[aria-label="코드 새로고침"]');
      await detailFailure;
      await page.waitForFunction(()=>document.querySelector('.code-panel [role="alert"]')?.textContent.includes('temporary failure')&&!document.querySelector('.code-panel [role="status"]'));
      assert.equal(await page.$('.code-panel .code-line'),null,'failed detail refresh must not show stale diff');
      failDetail=false;
      await page.click('button[aria-label="코드 새로고침"]');
      await waitFile('b.ts');
      assert.equal(await page.$('.code-panel [role="alert"]'),null);
    },false,'emacs'));

    for (const width of [1440,390]) await t.test(`code templates manage, preview, send and preserve drafts (${width})`, () => withPage(async page => {
      await page.setViewport({width,height:900});
      let templates={revision:'initial',items:[]},sendStatus=width===390?202:409,pendingTemplate=width===390;
      const sends=[],templateOperations=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        const respond=(body,status=200)=>void request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
        if(path==='/api/prompt-templates'){
          if(request.method()==='PUT'){
            templateOperations.push(request.headers()['x-desk-operation-id']);
            if(pendingTemplate){pendingTemplate=false;return respond({shared_pending:true},202);}
            templates={...JSON.parse(request.postData()),revision:'saved'};
          }
          return respond(templates);
        }
        if(path==='/api/code-view'){
          const body=JSON.parse(request.postData());
          return respond({root:'/test',head:'abcdef',files:[{path:'a.ts',status:'modified'}],...(body.path?{path:body.path,diff:'@@ -1 +1 @@\n-old();\n+newCode();\n'}:{})});
        }
        if(path.endsWith('/messages')&&request.method()==='POST'){
          sends.push({...JSON.parse(request.postData()),operation:request.headers()['x-desk-operation-id']});
          if(sendStatus===202)return respond({shared_pending:true},202);
          return sendStatus===200?respond({task_id:'t0'}):respond({error:'send failed'},sendStatus);
        }
        void request.continue();
      });
      const clickText=(selector,text)=>page.$$eval(selector,(nodes,text)=>{const node=nodes.find(node=>node.textContent===text);if(!node)throw new Error(text);node.click();},text);
      await openReply(page,origin);await page.type('.reply-box textarea','기존 초안');
      await page.click('button[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-line.add');
      await page.click('.code-line.delete');await page.keyboard.down('Shift');await page.click('.code-line.add');await page.keyboard.up('Shift');
      await page.click('[aria-label="템플릿 관리"]');
      await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>b.textContent==='템플릿 추가')?.disabled);
      await clickText('[role="dialog"] button','템플릿 추가');
      await page.$eval('[aria-label="템플릿 이름"]',node=>{node.select();});await page.type('[aria-label="템플릿 이름"]','코드 검토');
      await page.type('[aria-label="템플릿 내용"]','이 코드의 문제와 수정안을 설명해주세요.');
      await clickText('[role="dialog"] button','템플릿 저장');
      if(width===390){
        await page.waitForFunction(()=>document.querySelector('[role="dialog"] [role="status"]')?.textContent.includes('템플릿 저장을 접수'));
        await clickText('[role="dialog"] button','저장 결과 확인');
      }
      await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.textContent.includes('템플릿을 저장했습니다.'));
      if(width===390)assert.equal(templateOperations[0],templateOperations[1]);
      await page.focus('[role="dialog"] button[aria-label="닫기"]');
      await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'최신 목록 다시 불러오기');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]',{hidden:true});
      await page.select('[aria-label="코드 프롬프트 템플릿"]',templates.items[0].id);
      await page.click('.code-actions summary');
      const preview=await page.$eval('[aria-label="코드 전송 내용"]',node=>node.textContent);
      assert.ok(preview.startsWith('이 코드의 문제와 수정안을 설명해주세요.\n\n'));
      assert.ok(preview.includes('-old();\n+newCode();'));assert.ok(preview.includes('이전 1 / 이후 1'));
      await clickText('.code-actions button','바로 전송');
      if(width===390){
        await page.waitForFunction(()=>document.querySelector('.code-actions [role="status"]')?.textContent.includes('전달 대기열'));
        sendStatus=409;
        await clickText('.code-actions button','전송 결과 확인');
      }
      await page.waitForFunction(()=>document.querySelector('.code-actions [role="alert"]')?.textContent.includes('send failed'));
      if(width===390)assert.equal(sends[0].operation,sends[1].operation,'check the receipt using the accepted operation ID');
      const rejected=sends.at(-1);
      assert.equal(await page.$eval('.reply-box textarea',node=>node.value),'기존 초안');
      assert.equal(sends[0].text,preview);
      assert.equal(sends[0].code_review,true);
      sendStatus=500;
      await clickText('.code-actions button','바로 전송');
      await page.waitForFunction(()=>document.querySelector('.code-actions [role="alert"]')?.textContent.includes('send failed'));
      const uncertain=sends.at(-1);
      assert.notEqual(rejected.operation,uncertain.operation,'a final rejection gets a new operation ID');
      sendStatus=200;
      await page.focus('.code-actions .send-code');await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('.code-actions [role="status"]')?.textContent.includes('전송했습니다'));
      // The send button disables itself once sent; focus stays in the panel so Escape lets the pick go first.
      await page.waitForFunction(()=>document.activeElement?.closest('.code-actions'));
      await clickText('.code-actions button','바로 전송');
      assert.equal(sends.length,width===390?4:3,'same selection cannot be submitted twice after success');
      assert.equal(uncertain.operation,sends.at(-1).operation,'an uncertain result keeps its operation ID');
      assert.equal(await page.$eval('.reply-box textarea',node=>node.value),'기존 초안');
      await page.click('.quote-code');
      assert.equal(await page.$eval('.reply-box textarea',node=>node.value),'기존 초안\n\n'+preview+'\n');
      if(width===390)await page.click('button[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-line.add');await page.click('.code-line.add');
      await page.click('[aria-label="템플릿 관리"]');
      await page.waitForSelector('[aria-label="템플릿 내용"]');
      assert.equal(await page.$eval('[aria-label="템플릿 내용"]',node=>node.value),'이 코드의 문제와 수정안을 설명해주세요.');
      page.once('dialog',dialog=>dialog.accept());await clickText('[role="dialog"] button','템플릿 삭제');
      await clickText('[role="dialog"] button','템플릿 저장');
      await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.textContent.includes('템플릿을 저장했습니다.'));
      assert.equal(templates.items.length,0);
    },false,'emacs'));

    await t.test('file line counts and totals follow uncommitted, commit and branch comparisons',()=>withPage(async page=>{
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(new URL(request.url()).pathname!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData()),count=body.commit?3:body.base&&body.target?7:1;
        void request.respond({status:200,contentType:'application/json',body:JSON.stringify({
          root:'/repo',head:'a'.repeat(40),files:[{path:'a.ts',status:'modified',additions:count,deletions:2},{path:'image',status:'modified',binary:true},{path:'large',status:'untracked'}],
          commits:[{id:'a'.repeat(40),subject:'change'}],
          branches:[{ref:'refs/heads/main',id:'a'.repeat(40)},{ref:'refs/heads/feature',id:'b'.repeat(40)}],
          ...(body.commit?{commit:body.commit}:{}),
          ...(body.base&&body.target?{base:body.base,target:body.target,baseId:'a'.repeat(40),targetId:'b'.repeat(40)}:{}),
          ...(body.path?{path:body.path,diff:'@@ -1 +1 @@\n-before\n+after\n'}:{}),
        })});
      });
      await openReply(page,origin);await page.click('[aria-label="코드 변경 보기"]');
      const expect=async count=>{
        await page.waitForFunction(n=>document.querySelector('[aria-label="비교 범위 변경량"]')?.textContent.includes(`+${n} −2`),{},count);
        assert.equal(await page.$eval('nav[aria-label="변경 파일"] .code-file',node=>node.textContent),`Ma.ts+${count}−2`);
        const summary=await page.$eval('[aria-label="비교 범위 변경량"]',node=>node.textContent);
        assert.ok(summary.includes('바이너리 1개'));assert.ok(summary.includes('미집계 1개 (합계 제외)'));
      };
      await expect(1);await page.select('[aria-label="변경 기준"]','a'.repeat(40));await expect(3);
      await page.click('.code-branches summary');await page.select('[aria-label="기준 브랜치"]','refs/heads/main');
      await page.waitForFunction(()=>!document.querySelector('.code-panel [role="status"]'));
      await page.select('[aria-label="대상 브랜치"]','refs/heads/feature');await expect(7);
    }));

    await t.test('branch and worktree comparisons carry the selected source into quoted code',()=>withPage(async page=>{
      const requests=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(new URL(request.url()).pathname!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());requests.push(body);
        void request.respond({status:200,contentType:'application/json',body:JSON.stringify({
          root:body.worktree||'/repo',head:'a'.repeat(40),files:[{path:'a.ts',status:'modified'}],
          branches:[{ref:'refs/heads/main',id:'a'.repeat(40)},{ref:'refs/heads/feature',id:'b'.repeat(40)}],
          worktrees:[{path:'/repo',branch:'refs/heads/main'},{path:'/repo-feature',branch:'refs/heads/feature'}],
          ...(body.base&&body.target?{base:body.base,target:body.target,baseId:'a'.repeat(40),targetId:'b'.repeat(40)}:{}),
          ...(body.path?{path:body.path,diff:'@@ -1 +1 @@\n-before\n+'+(body.base?'committed':body.worktree?'dirty worktree':'session')+'\n'}:{}),
        })});
      });
      await openReply(page,origin);await page.click('[aria-label="코드 변경 보기"]');
      await page.waitForSelector('.code-line.add');
      await page.select('[aria-label="코드 worktree"]','/repo-feature');
      await page.waitForFunction(()=>document.querySelector('.code-line.add code')?.textContent==='dirty worktree');
      await page.click('.code-branches summary');
      await page.select('[aria-label="기준 브랜치"]','refs/heads/main');
      await page.waitForFunction(()=>!document.querySelector('.code-panel [role="status"]'));
      await page.select('[aria-label="대상 브랜치"]','refs/heads/feature');
      await page.waitForFunction(()=>document.querySelector('.code-line.add code')?.textContent==='committed');
      await page.click('.code-line.add');await page.click('.quote-code');
      const text=await page.$eval('.reply-box textarea',node=>node.value);
      assert.ok(text.includes('/repo-feature'));assert.ok(text.includes('refs/heads/main'));assert.ok(text.includes('refs/heads/feature'));assert.ok(text.includes('b'.repeat(40)));assert.ok(text.includes('+committed'));
      assert.equal(requests.at(-1).worktree,'/repo-feature');assert.equal(requests.at(-1).target,'refs/heads/feature');
    },false,'emacs'));

    await t.test('the file detail uses the listed worktree and a stale registration requires an explicit fallback',()=>withPage(async page=>{
      let registered='/feature',headChanged=false;
      const requests=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        if(new URL(request.url()).pathname!=='/api/code-view')return void request.continue();
        const body=JSON.parse(request.postData());requests.push(body);
        const respond=(data,status=200)=>void request.respond({status,contentType:'application/json',body:JSON.stringify(data)});
        if(registered==='/missing'&&body.worktree===undefined)
          return respond({error:'등록된 작업 폴더를 사용할 수 없습니다. 작업 폴더 등록을 확인해 주세요'},403);
        const root=body.worktree===null?'/session':body.worktree??registered;
        if(body.worktree===undefined)registered='/different';
        return respond({root,head:headChanged&&body.path?'def':'abc',registeredWorktree:registered==='/different'&&!body.path?'/feature':registered,
          files:[{path:'a.ts',status:'modified'}],...(body.path?{path:body.path,diff:`@@ -0,0 +1 @@\n+${root}\n`}:{})});
      });
      await openReply(page,origin);await page.click('[aria-label="코드 변경 보기"]');
      await page.waitForFunction(()=>document.querySelector('.code-line.add code')?.textContent==='/feature');
      assert.equal(requests.at(-1).worktree,'/feature');
      registered='/missing';
      await page.click('[aria-label="코드 창 닫기"]');await page.click('[aria-label="코드 변경 보기"]');
      await page.waitForFunction(()=>document.querySelector('.code-panel [role="alert"]')?.textContent.includes('등록된 작업 폴더'));
      assert.equal(await page.$('.code-panel .code-line'),null);
      await page.$$eval('.code-panel button',buttons=>buttons.find(button=>button.textContent==='세션 작업 폴더 보기').click());
      await page.waitForFunction(()=>document.querySelector('.code-line.add code')?.textContent==='/session');
      assert.equal(requests.at(-1).worktree,null);
      headChanged=true;
      await page.click('[aria-label="코드 새로고침"]');
      await page.waitForFunction(()=>[...document.querySelectorAll('.code-panel [role="alert"]')].some(el=>el.textContent.includes('코드 비교 기준이 바뀌었습니다')));
      assert.equal(await page.$('.code-panel .code-line'),null);
    },false,'emacs'));

    await t.test('code sends survive a panel remount without duplicate requests',()=>withPage(async page=>{
      let pending;const sends=[];const queue=new Set();
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const path=new URL(request.url()).pathname;
        if(path==='/api/code-view'){
          const body=JSON.parse(request.postData());return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({root:'/repo',head:'abc',files:[{path:'a.ts',status:'modified'}],...(body.path?{path:body.path,diff:'@@ -0,0 +1,2 @@\n+newCode();\n+another();\n'}:{})})});
        }
        if(request.method()==='DELETE'||path.endsWith('/reset')){queue.clear();return void request.respond({status:200,contentType:'application/json',body:'{}'});}
        if(path.endsWith('/messages')&&request.method()==='POST'){sends.push(request);pending=request;return;}
        void request.continue();
      });
      const open=async()=>{await page.click('[aria-label="코드 변경 보기"]');await page.waitForSelector('.code-line.add');await page.click('.code-line.add');};
      const send=()=>page.$$eval('.code-actions button',nodes=>nodes.find(node=>node.textContent==='바로 전송').click());
      await openReply(page,origin);await open();const sending=page.waitForRequest(request=>request.url().endsWith('/messages'));await send();await sending;
      assert.equal(sends.length,1);
      const id=sends[0].headers()['x-desk-operation-id'];assert.ok(id);
      await page.click('[aria-label="코드 창 닫기"]');await open();await send();
      queue.add('q1');await pending.respond({status:200,contentType:'application/json',body:JSON.stringify({task_id:'t0',queued_id:'q1'})});
      await page.waitForFunction(()=>document.querySelector('.code-actions [role="status"]')?.textContent.includes('메시지 대기열'));
      assert.equal(sends.length,1);
      for(const [index,path,method] of [[2,'/api/tasks/t0/queue/q1','DELETE'],[3,'/api/tasks/t0/reset','POST']]){
        await page.evaluate(async(path,method)=>{await fetch(path,{method});},path,method);
        assert.equal(queue.size,0);
        if(index===2)await page.$$eval('.code-actions button',nodes=>nodes.find(node=>node.textContent==='같은 코드로 새 요청').click());
        else {await page.click('[aria-label="코드 창 닫기"]');await open();}
        const next=page.waitForRequest(request=>request.url().endsWith('/messages'));await send();await next;
        assert.equal(sends.length,index);
        assert.notEqual(sends.at(-1).headers()['x-desk-operation-id'],sends.at(-2).headers()['x-desk-operation-id']);
        queue.add('q'+index);await pending.respond({status:200,contentType:'application/json',body:JSON.stringify({task_id:'t0',queued_id:'q'+index})});
        await page.waitForFunction(()=>document.querySelector('.code-actions [role="status"]')?.textContent.includes('메시지 대기열'));
        assert.equal(queue.size,1);
      }
      // A slow reply for the first pick must not announce a successful send on the second.
      await page.$$eval('.code-actions button',nodes=>nodes.find(node=>node.textContent==='같은 코드로 새 요청').click());
      const last=page.waitForRequest(request=>request.url().endsWith('/messages'));await send();await last;
      await page.click('.code-line.add:last-child');
      await pending.respond({status:200,contentType:'application/json',body:JSON.stringify({task_id:'t0',queued_id:'last'})});
      await page.waitForFunction(()=>!document.querySelector('.code-actions .send-code')?.disabled);
      assert.equal(await page.$('.code-actions [role="status"]'),null,'the second pick has not been sent');

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

    await t.test('a replacement approval reopens the folded queue and survives subsequent thread messages', () => withPage(async page => {
      await page.setExtraHTTPHeaders({'x-desk-fixture':'queue-reorder'});
      await page.evaluateOnNewDocument(() => {
        window.EventSource = class extends EventSource {
          constructor(...args) { super(...args); window.deskTestStream = this; }
        };
      });
      await page.goto(origin,{waitUntil:'domcontentloaded'});
      await page.waitForSelector('.queue-row[data-queue-index="1"]');
      await page.click('[aria-label="응답 대기 접기"]');
      await page.evaluate(() => {
        const send = message => window.deskTestStream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({source:'',message})}));
        const common = {task_id:'t0',session_id:'s0',created_at:new Date().toISOString()};
        send({type:'approval',approval:{...common,id:'first',tool_name:'Bash',input:{},status:'allowed'}});
        send({type:'approval',approval:{...common,id:'next',tool_name:'desk_request',input:{to:'@target#1',description:'후속 문의\n둘째 줄\n\n- **확인할 항목**'},status:'pending'}});
        for (const [i,kind] of ['tool_result','assistant','status'].entries())
          send({type:'event',event:{id:90001+i,task_id:'t0',kind,ts:common.created_at,payload:kind==='status'?{state:'turn_done'}:{text:'후속 메시지'}}});
      });
      await page.waitForSelector('.queue-row .md p br');
      assert.equal(await page.$eval('.queue-row .md li strong', el=>el.textContent),'확인할 항목');
    }));

    await t.test('Desk request cards preserve the original message, document links and approval decisions', () => withPage(async page => {
      await page.setViewport({width: 1440, height: 900});
      await page.setExtraHTTPHeaders({'x-desk-fixture': 'request-markdown'});
      await page.goto(origin, {waitUntil: 'domcontentloaded'});
      const row = '.queue-row[data-queue-index="0"]';
      await page.waitForSelector(row);
      await page.click(`${row} [aria-label="스레드 열기"]`);
      for (const card of [row, '.thread-content [data-post="300"] .approve-card']) {
        const summary = `${card} details summary`;
        await page.waitForSelector(summary);
        assert.equal(await page.$eval(summary, el => el.textContent.trim()), '원문 보기');
        await page.click(summary);
        assert.equal(await page.$eval(`${card} details[open] pre`, el => el.textContent), requestDescription);
        await page.click(summary);
      }

      await page.evaluate(() => {
        window.openedRequestDocuments = [];
        window.addEventListener('desk-document-open', event => window.openedRequestDocuments.push(event.detail));
      });
      const link = `${row} .md a`;
      await page.click(link);
      await page.waitForFunction(() => document.querySelector('.reference-feed')?.innerText.includes('승인 링크 미리보기'));
      await page.focus(link);
      await page.keyboard.press('Enter');
      const expectedDocument = {taskId: 't0', href: 'docs/readme.md'};
      assert.deepEqual(await page.evaluate(() => window.openedRequestDocuments), [expectedDocument, expectedDocument]);

      const decision = id => page.waitForRequest(request => request.method() === 'POST'
        && new URL(request.url()).pathname === `/api/approvals/${id}`);
      const [allowed] = await Promise.all([decision('allow-request'), page.click(`${row} .yes`)]);
      assert.deepEqual(JSON.parse(allowed.postData()), {allow: true});
      await page.click('.queue-row[data-queue-index="1"] .no');
      await page.type('[role="dialog"] textarea', '다시 확인');
      const [denied] = await Promise.all([decision('deny-request'), page.click('[role="dialog"] .danger')]);
      assert.deepEqual(JSON.parse(denied.postData()), {allow: false, message: '다시 확인'});
    }));

    await t.test('each pending approval has a card until that approval is settled', () => withPage(async page => {
      await page.setViewport({width:390,height:480});
      await page.setExtraHTTPHeaders({'x-desk-fixture':'queue-many'});
      await page.goto(origin,{waitUntil:'domcontentloaded'});
      const labels = () => page.$$eval('.queue-row .mono',els=>els.map(el=>el.textContent));
      await page.waitForFunction(()=>document.querySelectorAll('.queue-row').length===6);
      assert.deepEqual(await labels(),['cmd0','cmd1','cmd2','cmd3','cmd4','cmd5']);
      await page.$eval('.queue-list',list=>{list.scrollTop=list.scrollHeight;});
      assert.ok(await page.$eval('.queue-list',list=>{
        const bottom=list.lastElementChild.getBoundingClientRect().bottom;
        return list.scrollTop>0 && bottom<=list.getBoundingClientRect().bottom+1 && bottom<=innerHeight;
      }));
      await page.click('.queue-row[data-queue-index="3"] .yes');
      await page.waitForFunction(()=>document.querySelectorAll('.queue-row').length===5);
      assert.deepEqual(await labels(),['cmd0','cmd1','cmd2','cmd4','cmd5']);
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

    await t.test('Emacs reply Escape returns to the selected post after suggestions and IME', () => withPage(async page => {
      await page.setExtraHTTPHeaders({ 'x-desk-fixture': 'emoji' });
      await openReply(page, origin);
      const selected = '.thread .selected[data-post]';
      await page.waitForSelector(selected);
      await page.keyboard.type('#au');
      await page.waitForSelector('.reply-box [role="listbox"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.reply-box [role="listbox"]', { hidden: true });
      assert.equal(await page.$eval(textarea, field => field === document.activeElement), true);
      await page.keyboard.type(' ');
      await page.$eval(textarea, field => field.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, cancelable: true,
      })));
      assert.equal(await page.$eval(textarea, field => field === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.thread-feed:focus');
      const newest = await page.$eval(selected, post => post.dataset.post);
      assert.equal(newest, await page.$eval('.thread [data-post]:last-of-type', post => post.dataset.post));
      await page.keyboard.press('k');
      await page.waitForFunction((selector, id) => document.querySelector(selector)?.dataset.post !== id, {}, selected, newest);
      const older = await page.$eval(selected, post => post.dataset.post);
      await page.keyboard.press('r');
      await page.waitForSelector(`${textarea}:focus`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.thread-feed:focus');
      assert.equal(await page.$eval(selected, post => post.dataset.post), older);
      assert.equal(await page.$eval(textarea, field => field.value), '#au ');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.thread-feed', { hidden: true });
    }, false, 'emacs'));

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
      await page.waitForSelector('.thread-feed:focus');
      await page.waitForSelector('.thread [data-post="300"].selected');
      assert.equal(await page.evaluate(() => window.backCalls), 0);
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
