// 실행: node perf-bench/run.mjs [--count=500] [--runs=3] [--cpu=4]
// 결과는 stdout의 JSON으로 제공한다. 필요할 때 > /tmp/desk-perf.json으로 보관한다.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePerformance } from './compare.mts';
import { events } from './data.mjs';
import { interactionData } from './interaction-data.mjs';

async function verifyLive(page, sent, count) {
  if (sent < 1) throw new Error('실시간 이벤트가 발생하지 않았습니다.');
  const updated = await page.$$eval('.deck [data-post]', (nodes, floor) => nodes.some(el => Number(el.getAttribute('data-post')) > floor), count * 10);
  if (!updated) throw new Error('실시간 이벤트가 실제 화면에 반영되지 않았습니다.');
}
function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n.callFrame]));
  const totals = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const frame = nodes.get(profile.samples[i]);
    const key = `${frame?.functionName || '(anonymous)'} @ ${frame?.url?.split('/').at(-1) || 'runtime'}`;
    totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  return [...totals].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([functionName, selfMs])=>({functionName,selfMs}));
}
const root = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const scenario = process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1] ?? 'thread';
if (!['thread', 'columns', 'wheel', 'typing'].includes(scenario)) throw new Error('scenario는 thread, columns, wheel 또는 typing입니다.');
const text = process.argv.find(a => a.startsWith('--text='))?.split('=')[1] ?? 'long';
if (!['long', 'short'].includes(text)) throw new Error('text는 long 또는 short입니다.');
const liveText = process.argv.find(a => a.startsWith('--live-text='))?.split('=')[1] ?? 'repeat';
if (!['repeat', 'unique'].includes(liveText)) throw new Error('live-text는 repeat 또는 unique입니다.');
const profile = process.argv.includes('--profile');
const liveTasks = arg('live-tasks', 10);
if (!Number.isInteger(liveTasks) || liveTasks < 1 || liveTasks > 10) throw new Error('live-tasks는 1..10 정수입니다.');
const live = arg('live', 0);
if (!Number.isInteger(live) || live < 0 || live > 50 || (live && (scenario === 'thread' || process.argv.includes('--verify-feed')))) throw new Error('live=0..50; thread/verify-feed와 live는 함께 사용할 수 없습니다.');
const count = arg('count', scenario !== 'thread' ? 40 : 500), runs = arg('runs', 3), cpu = arg('cpu', 4);
if (![count, runs, cpu].every(Number.isInteger) || count < 24 || count > 5000 || runs < 1 || runs > 20 || cpu < 1 || cpu > 10)
  throw new Error('count=24..5000, runs=1..20, cpu=1..10 정수가 필요합니다.');
const baselinePath = process.argv.find(a => a.startsWith('--baseline='))?.slice('--baseline='.length);
const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
const directory = await mkdtemp(resolve(tmpdir(), 'desk-perf-'));
let browser, server;
const liveTimers = new Set();
try {
  await build({ configFile: false, root, plugins: [react()], logLevel: 'error',
    build: { minify: !profile, outDir: directory, emptyOutDir: true, chunkSizeWarningLimit: 10000, ...(scenario !== 'thread' ? { rolldownOptions: { input: resolve(root, 'interactions.html') } } : {}) } });
  const fixture = events(count, text);
  let mock = interactionData(count, text, liveText, liveTasks), streamedEvents = 0;
  const unexpected = [];
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (scenario !== 'thread' && url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/streams') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write('data: {"source":"","connected":true}\n\n');
          if (live) {
            const streamMock = mock;
            const timer = setInterval(() => {
              if (res.destroyed) { clearInterval(timer); liveTimers.delete(timer); return; }
              for (const message of streamMock.next()) res.write(`data: ${JSON.stringify({ source: '', message })}\n\n`);
              streamedEvents++;
            }, 1000 / live);
            liveTimers.add(timer);
            res.on('close', () => { clearInterval(timer); liveTimers.delete(timer); });
          }
          return;
        }
        const body = mock(url);
        if (req.method !== 'GET' || body === undefined) {
          unexpected.push(`${req.method} ${url.pathname}`); res.writeHead(501); res.end('{}'); return;
        }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return;
      }
      if (url.pathname === '/fixture') {
        const payload = JSON.stringify(url.searchParams.get('mode') === 'window' ? fixture.slice(-24) : fixture);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(payload); return;
      }
      const path = resolve(directory, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(directory + sep) || !(await stat(path)).isFile()) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const executablePath = process.env.PERF_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true,
    userDataDir: resolve(directory, 'browser-profile'), args: ['--no-first-run', '--disable-background-networking'] });
  const results = [];
  // 같은 브라우저 안에서 순서를 번갈아 실행해 순서 효과를 줄인다. 첫 쌍은 준비 실행이다.
  for (let run = -1; run < runs; run++) {
    for (const mode of scenario !== 'thread' ? ['current'] : run % 2 === 0 ? ['window', 'current'] : ['current', 'window']) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1280, height: 900 });
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        if (scenario !== 'thread') {
          mock = interactionData(count, text, liveText, liveTasks); streamedEvents = 0;
          await page.goto(`http://127.0.0.1:${server.address().port}/interactions.html`);
          await page.waitForFunction(() => document.querySelectorAll('.deck section[data-col]').length === 10 && document.querySelectorAll('.deck [data-post]').length >= 80, { timeout: 30000 }).catch(e => { throw new Error(`${e.message}: ${[...errors,...unexpected].join('; ')}`); });
          await new Promise(ok => setTimeout(ok, 700));
          if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
          if (scenario === 'typing') {
            await page.keyboard.press('i');
            await page.waitForSelector('.compose textarea', { visible: true });
            await page.click('.compose textarea');
            await page.evaluate(() => window.armTyping());
            const input = 'Performance typing check 0123456789 '.repeat(3);
            await page.keyboard.type(input, { delay: 20 });
            const sample = await page.evaluate(() => window.finishTyping());
            const value = await page.$eval('.compose textarea', el => el.value);
            if (value !== input || sample.feedback.length !== input.length) throw new Error(`입력 문자 누락 또는 관측 누락: 입력값 ${value.length}, 관측 ${sample.feedback.length}, 예상 ${input.length}`);
            if (errors.length || unexpected.length) throw new Error([...errors, ...unexpected].join('; '));
            if (live) await verifyLive(page, streamedEvents, count);
            if (run >= 0) results.push({ run, mode, sample, streamedEvents, cache: await page.evaluate(() => window.cacheStats()), ...(profile ? { cpuProfile: summarizeProfile((await cdp.send('Profiler.stop')).profile) } : {}) });
            process.stderr.write(`${run < 0 ? '준비' : run + 1} typing: ${input.length}자 검증, 이벤트 ${streamedEvents}개\n`);
            continue;
          }
          const samples = [];
          // 첫 횡단은 처음 보이는 컬럼, 복귀는 이미 그린 컬럼이다. 순서 변경도 따로 확인한다.
          const steps = scenario === 'wheel' ? [...Array(6).fill(['wheel', 'right', 'first-pass']), ...Array(6).fill(['wheel', 'left', 'return'])] : [...Array(8).fill(['focus', 'ArrowRight', 'first-pass']), ...Array(4).fill(['focus', 'ArrowLeft', 'return']), ['reorder', 'L', 'reorder'], ['reorder', 'H', 'reorder']];
          for (const [kind, key, phase] of steps) {
            await page.evaluate(kind => window.armInteraction(kind), kind);
            if (kind === 'wheel') {
              const box = await page.$eval('.deck', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(150, r.height / 2) }; });
              await page.mouse.move(box.x, box.y);
              // 8개의 작은 수평 입력으로 트랙패드 형태의 연속 입력을 모사한다.
              for (let pulse = 0; pulse < 8; pulse++) {
                await page.mouse.wheel({ deltaX: key === 'right' ? 48 : -48, deltaY: 0 });
                await new Promise(ok => setTimeout(ok, 16));
              }
              await page.evaluate(() => window.endWheelInput());
            } else if (kind === 'reorder') { await page.keyboard.down('Shift'); await page.keyboard.press(key === 'L' ? 'KeyL' : 'KeyH'); await page.keyboard.up('Shift'); }
            else await page.keyboard.press(key);
            await page.waitForFunction(() => window.interaction?.done, { timeout: 15000 });
            const sample = await page.evaluate(() => window.interaction);
            if (sample.error) throw new Error(sample.error);
            if (kind === 'wheel') {
              const distance = sample.after.scroll - sample.before.scroll;
              if ((key === 'right' ? distance : -distance) < 300) throw new Error(`가로 휠 이동이 충분히 반영되지 않았습니다: ${distance}px`);
              if (sample.before.order !== sample.after.order) throw new Error('휠 입력으로 컬럼 순서가 바뀌었습니다.');
              samples.push({ ...sample, phase, key, distance }); continue;
            }
            const order = sample.before.order.split(',');
            const index = order.indexOf(sample.before.focus);
            const direction = ['ArrowRight', 'L'].includes(key) ? 1 : -1;
            if (index < 0 || !order[index + direction]) throw new Error('측정 대상 컬럼이 없습니다.');
            if (kind === 'reorder') {
              [order[index], order[index + direction]] = [order[index + direction], order[index]];
              if (sample.after.order !== order.join(',') || sample.after.focus !== sample.before.focus)
                throw new Error('컬럼 순서 또는 선택 유지 동작이 예상과 다릅니다.');
            } else if (sample.after.focus !== order[index + direction]) throw new Error('컬럼 이동 방향이 예상과 다릅니다.');
            samples.push({ ...sample, phase, key });
          }
          if (process.argv.includes('--verify-feed')) {
            // 측정 종료 후 기능 검증: 초기 글 수를 줄여도 과거 글에 도달해야 한다.
            await page.click('section[data-col="c0"] .col-head h2');
            for (let attempt = 0; attempt < count; attempt++) {
              const loaded = await page.$$eval('section[data-col="c0"] [data-post]', els => els.length);
              if (loaded >= count) break;
              await page.$eval('section[data-col="c0"] .feed', el => { el.scrollTop = el.scrollHeight; });
              await page.waitForFunction(previous => document.querySelectorAll('section[data-col="c0"] [data-post]').length > previous,
                { timeout: 5000 }, loaded).catch(async e => {
                  const info = await page.$eval('section[data-col="c0"] .feed', el => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, posts: el.querySelectorAll('[data-post]').length, text: el.querySelector('.older-posts')?.textContent }));
                  throw new Error(`${e.message}: ${JSON.stringify(info)}`);
                });
            }
            const loaded = await page.$$eval('section[data-col="c0"] [data-post]', els => els.length);
            if (loaded !== count) throw new Error('세로 스크롤로 전체 글을 불러오지 못했습니다.');
            await page.keyboard.down('Shift'); await page.keyboard.press('KeyG'); await page.keyboard.up('Shift');
            await page.waitForFunction(() => document.querySelector('section[data-col="c0"] .post.selected')?.getAttribute('data-post') === '1');
            await page.keyboard.press('g'); await page.keyboard.press('g');
            await page.waitForFunction(newest => document.querySelector('section[data-col="c0"] .post.selected')?.getAttribute('data-post') === String(newest), {}, count);
            process.stderr.write('세로 추가 표시 및 G/gg 원문 이동 검증 통과\n');
          }
          if (errors.length || unexpected.length) throw new Error([...errors, ...unexpected].join('; '));
          if (live) await verifyLive(page, streamedEvents, count);
          if (run >= 0) results.push({ run, mode, samples, streamedEvents, cache: await page.evaluate(() => window.cacheStats()), ...(profile ? { cpuProfile: summarizeProfile((await cdp.send('Profiler.stop')).profile) } : {}) });
          process.stderr.write(`${run < 0 ? '준비' : run + 1} ${scenario}: ${samples.length}회 이동 검증 완료\n`);
          continue;
        }
        await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&count=${count}`);
        await page.waitForFunction(() => window.bench?.done, { timeout: 120000 }).catch(e => { throw new Error(`${e.message}: ${errors.join('; ')}`); });
        if (errors.length) throw new Error(errors.join('; '));
        const result = await page.evaluate(() => window.bench);
        if (result.postNodes !== (mode === 'current' ? count : 24)) throw new Error('예상한 글 수와 렌더링 결과가 다릅니다.');
        if (run >= 0) results.push({ run, ...result });
        process.stderr.write(`${run < 0 ? '준비' : run + 1} ${mode}: ${Math.round(result.settledMs)}ms, 글 ${result.postNodes}개\n`);
      } finally { await page.close(); }
    }
  }
  const median = values => { const s = values.toSorted((a,b) => a-b); return s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2; };
  let summary = Object.fromEntries((scenario !== 'thread' ? [] : ['current', 'window']).map(mode => {
    const rows = results.filter(r => r.mode === mode);
    return [mode, Object.fromEntries(['firstPaintMs', 'settledMs', 'responseBytes', 'fetchMs', 'parseMs', 'deriveMs', 'postNodes', 'domNodes', 'longTaskMs', 'maxFrameGapMs'].map(key =>
      [key, median(rows.map(r => key === 'longTaskMs' ? r.longTasks.reduce((a,b)=>a+b,0) : key === 'maxFrameGapMs' ? Math.max(0,...r.frameGaps) : r[key]))]))];
  }));
  if (scenario !== 'thread' && scenario !== 'typing') {
    const samples = results.flatMap(r => r.samples);
    const p95 = xs => xs.toSorted((a,b)=>a-b)[Math.ceil(xs.length * .95)-1];
    const summarize = xs => ({ samples: xs.length, feedbackMs: median(xs.map(s=>s.feedbackMs)),
      p95FeedbackMs: p95(xs.map(s=>s.feedbackMs)), motionMs: median(xs.map(s=>s.motionMs)),
      maxFrameGapMs: Math.max(...xs.map(s=>s.maxFrameGapMs)), framesOver50ms: xs.reduce((a,s)=>a+s.framesOver50ms,0),
      longTaskMs: xs.reduce((a,s)=>a+s.longTaskMs,0), mountedPosts: xs.reduce((a,s)=>a+s.mountedPosts,0), removedPosts: xs.reduce((a,s)=>a+s.removedPosts,0) });
    summary = { current: summarize(samples), phases: Object.fromEntries((scenario === 'wheel' ? ['first-pass','return'] : ['first-pass','return','reorder']).map(phase=>[phase,summarize(samples.filter(s=>s.phase===phase))])) };
  }
  if (scenario === 'typing') {
    const samples = results.map(r=>r.sample), feedback = samples.flatMap(s=>s.feedback).toSorted((a,b)=>a-b);
    summary = { current: { samples: feedback.length, feedbackMs: median(feedback), p95FeedbackMs: feedback[Math.ceil(feedback.length*.95)-1],
      maxFrameGapMs: Math.max(...samples.flatMap(s=>s.frames)), framesOver50ms: samples.flatMap(s=>s.frames).filter(n=>n>50).length,
      longTaskMs: samples.reduce((n,s)=>n+s.longTaskMs,0) } };
  }
  const report = { schema: 6, environment: { platform: platform(), arch: arch(), processor: cpus()[0]?.model,
    node: process.version, browser: await browser.version(), cpuThrottle: cpu, scenario, text, live, liveText, liveTasks, profile, count, runs, build: 'production' },
    scope: scenario === 'typing' ? '실제 App 작성창에 ASCII 108자를 입력한다. beforeinput부터 input 후 이중 rAF까지의 근삿값이며 INP나 한글 IME 측정이 아님. live는 초당 새 assistant 글+작업상태 쌍의 모의 SSE 빈도이며 토큰 스트리밍과 같지 않음.' : scenario === 'wheel' ? '실제 App에서 CDP 가로 휠 입력으로 컬럼 간 이동. 8회 x 48px 입력을 16ms 대기와 함께 전달하는 동작을 오른쪽 6회·복귀 6회 반복. 실제 macOS 트랙패드 관성·물리 화면은 미측정. feedbackMs는 wheel 이벤트부터 scrollLeft 변경 뒤 rAF까지의 주 스레드 관측 근삿값으로 INP나 컴포지터 표시 지연이 아님. 고정 API, 10개 컬럼. environment.live가 0보다 크면 지정 빈도로 새 글과 작업 상태를 보낸다.' : scenario !== 'thread' ? '실제 App의 키보드 좌우 이동 12회와 H/L 순서 변경 2회. 격리된 고정 API와 10개 컬럼. feedbackMs는 실제 keydown 시각부터 상태 변경 뒤 rAF까지의 표시 근삿값이며 INP가 아님. motionMs는 마지막 스크롤 변경까지. 각 이동은 최소 400ms 및 120ms 정지 후 종료. 실제 네트워크·모델 실행·포인터 드래그 미포함. environment.live가 모의 새 글/상태 갱신 빈도다.' : '실제 ThreadPosts와 buildPosts. 고정 Markdown 데이터. window는 마지막 24개만 조회·렌더링하는 실험이며 완성된 가상 스크롤이 아님. 전송 시간은 루프백이며 실제 원격망 개선 폭을 뜻하지 않음. firstPaintMs는 이중 rAF 근삿값이며 INP가 아님.',
    summary, results };
  if (baseline) {
    const keys = ['platform', 'arch', 'processor', 'node', 'browser', 'cpuThrottle', 'scenario', 'text', 'live', 'liveText', 'liveTasks', 'profile', 'count', 'runs', 'build'];
    if (baseline.schema !== report.schema || keys.some(k => baseline.environment?.[k] !== report.environment[k]))
      throw new Error('기준 결과의 실행 환경·횟수·데이터 조건이 다릅니다. 같은 조건으로 다시 측정하세요.');
    report.comparison = comparePerformance(scenario, baseline.summary.current, summary.current);
    if (!report.comparison.passed) process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const timer of liveTimers) clearInterval(timer);
  liveTimers.clear();
  await browser?.close();
  if (server?.listening) await new Promise(ok => { server.close(ok); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
