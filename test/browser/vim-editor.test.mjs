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
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/streams') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"source":"","connected":true}\n\n');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const layout = request.headers['x-desk-fixture'];
        const note = layout === 'note';
        const route = /^\/api\/tasks\/([^/]+)\/(events|messages)$/.exec(url.pathname);
        let body = fixture(url);
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
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval(textarea, element => element.readOnly), true);
        await page.keyboard.type('unwanted');
        assert.equal(await page.$eval(textarea, element => element.value), 'initial');
      } finally { await request.continue(); }
      await expectMode(page, '일반');
      assert.equal(await page.$eval(input, element => element === document.activeElement), true);
      assert.equal(await text(page), 'initial');
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
