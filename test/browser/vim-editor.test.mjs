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
        const body = url.pathname === '/api/tasks/t0/events' ? { events: [], more: false } : fixture(url);
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

async function text(page) {
  return page.$eval(input, element => [...element.querySelectorAll('.cm-line')].map(line => {
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
    const withPage = async (callback, emulateWebKit = false) => {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.evaluateOnNewDocument(emulateWebKit => {
          localStorage.setItem('agent-desk.editor-mode', 'vim');
          if (emulateWebKit) Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
        }, emulateWebKit);
        await callback(page);
      } finally { await context.close(); }
    };

    await t.test('cold loading does not edit the draft and remembers Escape', () => withPage(async page => {
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
        assert.equal(await page.$eval(textarea, element => element.readOnly), true);
        await page.keyboard.type('unwanted');
        assert.equal(await page.$eval(textarea, element => element.value), '');
        await page.keyboard.press('Escape');
      } finally { await request.continue(); }
      await expectMode(page, '일반');
      assert.equal(await page.$eval(input, element => element === document.activeElement), true);
      assert.equal(await text(page), '');
    }));

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
