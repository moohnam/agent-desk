import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Browser, CDPSession } from 'puppeteer-core';
import { HttpError } from './errors.ts';

const ORIGIN = 'http://127.0.0.1:50917';
const URL = ORIGIN + '/document';
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
type Session = { cdp: CDPSession; owner: string; allowed: () => boolean; width: number; height: number; queued: number; input: Promise<void> };

/** The application receives raster frames only. Document code runs in a disposable Chromium process. */
export class InteractivePreview {
  private processes = new Set<AbortController>();
  private sessions = new Map<string, Session>();
  private stopped = false;
  private executable?: string;
  constructor(executable?: string) { this.executable = executable; }

  async stream(response: ServerResponse, owner: string,
    { html, allowed }: { html: string; allowed: () => boolean }, width: number, height: number) {
    if (this.stopped || response.destroyed) return;
    if (this.processes.size >= 2) throw new HttpError(429, '다른 HTML 미리보기의 JS를 먼저 끄세요.');
    width = Math.round(Math.max(280, Math.min(1440, width)));
    height = Math.round(Math.max(280, Math.min(1000, height)));
    const controller = new AbortController(), id = randomUUID();
    const { signal } = controller;
    this.processes.add(controller);
    const stop = () => controller.abort();
    response.once('close', stop);
    const startup = setTimeout(stop, 15_000);
    const lease = setInterval(() => {
      if (!allowed()) stop();
      else if (response.headersSent && !response.writableNeedDrain) response.write('\n');
    }, 2000);
    let browser: Browser | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const paths = this.executable ? [this.executable] : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      ];
      let executablePath: string | undefined;
      for (const path of paths) {
        try { await access(path); executablePath = path; break; } catch { /* Try the next installed browser. */ }
      }
      if (!executablePath) throw new HttpError(503, 'JS 미리보기에는 허브에 Chrome 152 이상이 필요합니다.');
      const { default: puppeteer } = await import('puppeteer-core');
      signal.throwIfAborted();
      browser = await puppeteer.launch({
        executablePath, headless: true, pipe: true, signal, timeout: 9000, protocolTimeout: 6000,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        defaultViewport: { width, height, deviceScaleFactor: 1 },
        env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
        args: ['--disable-background-networking', '--disable-extensions', '--hide-scrollbars', '--disable-dev-shm-usage'],
      });
      if (!(Number((await browser.version()).match(/\/(\d+)\./)?.[1]) >= 152))
        throw new HttpError(503, 'JS 미리보기에는 허브에 Chrome 152 이상이 필요합니다.');
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.bringToFront();
      await page.setRequestInterception(true);
      let phase: 'probe' | 'restricted' | 'document' = 'probe';
      let receivedDocument = false;
      page.on('request', request => {
        const location = request.url();
        if (phase !== 'document' && location === ORIGIN + '/check')
          return void request.respond({ status: 200, body: 'probe' }).catch(() => {});
        if (location !== URL || !request.isNavigationRequest() || request.frame() !== page.mainFrame() || receivedDocument)
          return void request.abort().catch(() => {});
        if (phase === 'document') receivedDocument = true;
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8',
          body: phase === 'document' ? html : '<!doctype html><title>네트워크 격리 확인</title>',
          headers: { 'content-security-policy': (phase === 'document' ? CSP : CSP.replace("default-src 'none'", "default-src 'none'; connect-src " + ORIGIN)),
            'x-dns-prefetch-control': 'off', 'cache-control': 'no-store', ...(phase !== 'probe' ? { 'connection-allowlist': '()' } : {}) },
        }).catch(() => {});
      });
      const canConnect = () => page.evaluate(url => fetch(url, { mode: 'no-cors', credentials: 'omit' }).then(() => true, () => false), ORIGIN + '/check');
      await page.goto(URL, { timeout: 4000 });
      if (!await canConnect()) throw new HttpError(503, 'JS 미리보기의 네트워크 격리를 확인하지 못했습니다.');
      phase = 'restricted';
      await page.goto(URL, { timeout: 4000 });
      if (await canConnect()) throw new HttpError(503, 'JS 미리보기의 네트워크 격리를 확인하지 못했습니다.');
      phase = 'document';
      if (!allowed()) throw new HttpError(403, '문서 접근 권한이 취소되었습니다.');
      const cdp = await page.createCDPSession();
      await page.goto(URL, { timeout: 5000, waitUntil: 'domcontentloaded' });
      signal.throwIfAborted();
      if (!allowed()) throw new HttpError(403, '문서 접근 권한이 취소되었습니다.');
      this.sessions.set(id, { cdp, owner, allowed, width, height, queued: 0, input: Promise.resolve() });
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.write(JSON.stringify({ id, width, height }) + '\n');
      let measuring = false, lastFrame = 0, latest: string | undefined;
      const flush = () => {
        if (!latest || measuring || signal.aborted || !allowed() || response.writableNeedDrain || frameTimer) return;
        const delay = 83 - (Date.now() - lastFrame);
        if (delay > 0) { frameTimer = setTimeout(() => { frameTimer = undefined; flush(); }, delay); return; }
        let data = latest; latest = undefined;
        measuring = true;
        void cdp.send('Page.getLayoutMetrics').then(({ cssContentSize, cssLayoutViewport }) => {
          if (signal.aborted || !allowed()) return;
          if (response.writableNeedDrain) { latest ??= data; return; }
          // Pair metrics with the most recent browser frame available when the measurement finishes.
          if (latest) { data = latest; latest = undefined; }
          lastFrame = Date.now();
          response.write(JSON.stringify({ data, scroll: { top: cssLayoutViewport.pageY, total: cssContentSize.height } }) + '\n');
        }).catch(stop).finally(() => { measuring = false; flush(); });
      };
      response.on('drain', flush);
      response.once('close', () => response.off('drain', flush));
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(stop);
        latest = data;
        flush();
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 64, maxWidth: width, maxHeight: height });
      clearTimeout(startup);
      // Bound the lifetime even if a client leaves this panel open indefinitely.
      const duration = setTimeout(stop, 30 * 60_000);
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else { signal.addEventListener('abort', () => resolve(), { once: true }); browser!.once('disconnected', () => resolve()); }
      });
      clearTimeout(duration);
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        throw error instanceof HttpError ? error : new HttpError(503, '격리된 JS 미리보기를 시작하지 못했습니다.');
    } finally {
      clearTimeout(startup); clearTimeout(frameTimer); clearInterval(lease);
      this.sessions.delete(id);
      stop();
      response.off('close', stop);
      if (response.headersSent && !response.destroyed) response.end();
      await browser?.close().catch(() => {});
      this.processes.delete(controller);
    }
  }

  async input(owner: string, body: Record<string, unknown>) {
    const session = typeof body.id === 'string' ? this.sessions.get(body.id) : undefined;
    if (!session || session.owner !== owner || !session.allowed()) throw new HttpError(404, '열린 JS 미리보기가 없습니다.');
    if (!finite(body.x) || !finite(body.y) || body.x < 0 || body.y < 0 || body.x > session.width || body.y > session.height)
      throw new HttpError(400, '잘못된 문서 입력 위치입니다.');
    const { x, y, type, dy } = body;
    if (type !== 'click' && (type !== 'scroll' || !finite(dy))) throw new HttpError(400, '지원하지 않는 문서 입력입니다.');
    if (session.queued >= 8) throw new HttpError(429, '문서 입력을 처리 중입니다.');
    session.queued++;
    const operation = session.input.then(async () => {
      if (this.sessions.get(body.id as string) !== session || !session.allowed()) throw new HttpError(404, '열린 JS 미리보기가 없습니다.');
      if (type === 'scroll' && finite(dy)) {
        await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.max(-2000, Math.min(2000, dy)) });
      } else {
        await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    });
    session.input = operation.catch(() => {});
    try { await operation; } finally { session.queued--; }
  }

  close() { this.stopped = true; for (const running of this.processes) running.abort(); }
}
