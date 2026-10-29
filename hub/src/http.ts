import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { Access } from './access.ts';
import { readBody, sameOrigin } from './body.ts';
import { parseFeedParams, type FeedFilter, type HubMessage } from '../../shared/api.ts';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import { handleMcp } from './mcp.ts';
import { linkTarget, localOrigin, openTarget } from './open.ts';
import { feedEvent } from './db.ts';
import { saveFromUrl, saveUpload } from './uploads.ts';
import { readEngineUsage, readUsage } from './usage.ts';
import { ENGINES, type EngineName } from '../../shared/compose.ts';

const WEB_DIST = config.webDist;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

/** Serves the built web UI, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string, res: ServerResponse) {
  const file = normalize(join(WEB_DIST, pathname));
  const target = file.startsWith(WEB_DIST) && extname(file) ? file : join(WEB_DIST, 'index.html');
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'web UI not built: run `npm --workspace web run build`, or use the Vite dev server' });
  }
}

/** Question answers from a request body: string values keyed by question text, else none. */
function answersOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, a]) => typeof a === 'string'));
  return Object.keys(out).length ? out : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const b = await readBody(req);
  if (b === undefined) return {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'JSON 객체가 필요합니다');
  return b as Record<string, any>;
}

/** A positive integer query parameter at most `max`, else `fallback` when absent; anything else is a 400. */
function intParam(url: URL, name: string, fallback: number | undefined, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new HttpError(400, `${name}는 1 이상 ${max} 이하의 정수여야 합니다`);
  return n;
}

/** A feed column's filter from `/feed` parameters: comma lists of tasks, projects, statuses, kinds; `q` a search. */
function feedFilter(url: URL): FeedFilter {
  return parseFeedParams((name) => url.searchParams.get(name));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const DENIED_PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Desk</title>
<body style="font: 16px/1.6 system-ui, sans-serif; max-width: 30em; margin: 20vh auto; padding: 0 20px">
<h1 style="font-size: 20px">접속 토큰이 필요합니다</h1>
<p>Mac에서 Agent Desk를 열고 상단의 <b>폰에서 열기</b>를 눌러 QR 코드를 스캔하세요.</p></body></html>`;

/** `uploadsDir`: where files sent from other devices (a phone) are saved. */
export function createHttpServer(hub: Hub, access: Access, uploadsDir: string) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const route = `${req.method} /${parts.slice(1).map((p, i) => (i % 2 === 1 ? ':id' : p)).join('/')}`;
    const id = parts[2];

    // The QR link: remember the device, then drop the token from the address bar.
    if (access.matches(url.searchParams.get('token'))) {
      url.searchParams.delete('token');
      res.writeHead(302, { 'set-cookie': access.cookie(), location: url.pathname + url.search });
      return res.end();
    }
    if (!access.allowed(req)) {
      if (parts[0] === 'api' || url.pathname === '/mcp') return send(res, 401, { error: '접속 토큰이 필요합니다' });
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(DENIED_PAGE);
    }
    const local = access.isLocal(req);

    try {
      if ((parts[0] === 'api' || url.pathname === '/mcp') && !sameOrigin(req)) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
      if (url.pathname === '/mcp') return await handleMcp(hub, req, res);
      if (parts[0] !== 'api') return await serveStatic(url.pathname, res);
      switch (route) {
        case 'GET /state':
          return send(res, 200, { ...hub.state(), client: { local } });
        case 'GET /access': {
          if (!local) throw new HttpError(403, '이 Mac에서만 볼 수 있습니다');
          const urls = access.urls();
          return send(res, 200, { urls: await Promise.all(urls.map(async (u) => ({ url: u, qr: await access.qrSvg(u) }))) });
        }
        case 'GET /stream': {
          res.writeHead(200, {
            'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
          });
          res.write(': connected\n\n');
          const onMessage = (m: HubMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          hub.bus.on('message', onMessage);
          req.on('close', () => { clearInterval(ping); hub.bus.off('message', onMessage); });
          return;
        }
        case 'GET /usage':
          // `refresh=1`: read again now instead of reusing the last minute's reading.
          // `engine`: that engine only, so a client can show each as it arrives.
          {
            const refresh = url.searchParams.get('refresh') === '1';
            const engine = url.searchParams.get('engine');
            if (!engine) return send(res, 200, await readUsage(refresh));
            if (!(ENGINES as string[]).includes(engine)) throw new HttpError(400, `알 수 없는 엔진입니다: ${engine}`);
            return send(res, 200, await readEngineUsage(engine as EngineName, refresh));
          }
        case 'GET /settings':
          return send(res, 200, hub.settings());
        case 'PUT /settings':
          return send(res, 200, hub.setSettings(await readJson(req)));
        case 'POST /projects': {
          const b = await readJson(req);
          return send(res, 201, hub.createProject(b.name, b.root_path));
        }
        case 'POST /tasks': {
          const b = await readJson(req);
          return send(res, 201, hub.createTask(b.project_id, b.title, b.prompt, b.permission_mode));
        }
        case 'POST /compose': {
          const b = await readJson(req);
          return send(res, 201, hub.compose(b.text));
        }
        case 'POST /uploads': {
          // `{url}`: a file on the web (an image dragged in from a web page), downloaded here.
          if (/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
            return send(res, 201, { path: await saveFromUrl((await readJson(req)).url, uploadsDir) });
          }
          // Else the raw file, not a form: its content type needs a CORS preflight, which a page on
          // another site never gets past.
          if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'application/octet-stream 본문만 받습니다');
          const name = url.searchParams.get('name') ?? '';
          return send(res, 201, { path: await saveUpload(req, uploadsDir, name) });
        }
        case 'GET /feed': {
          // A column's events (feedFilter); tool payloads come cut (feedEvent).
          return send(res, 200, hub.store.listFeed(intParam(url, 'limit', 1000, 5000)!, intParam(url, 'before', undefined), feedFilter(url)).map(feedEvent));
        }
        case 'GET /feed/:id': {
          // `/feed/count`: how many posts the column has in all, for its "loaded / total".
          if (id !== 'count') throw new HttpError(404, `no route for ${route}`);
          return send(res, 200, hub.store.countFeed(feedFilter(url)));
        }
        case 'GET /tasks/:id/events': {
          // `since`: a thread opened at an older post loads from that post on. `before`: the page of
          // history before a client's oldest event; `more`: still older events exist. `ids`: just
          // those events, whole (live events come cut, like the feed's).
          const ids = url.searchParams.get('ids');
          if (ids) {
            const list = ids.split(',').map(Number).filter(Number.isInteger).slice(0, 500);
            return send(res, 200, { events: hub.store.eventsByIds(id, list), more: false });
          }
          const events = hub.store.listEvents(id, 500, intParam(url, 'since', undefined), intParam(url, 'before', undefined));
          return send(res, 200, { events, more: events.length > 0 && hub.store.hasEventsBefore(id, events[0].id) });
        }
        case 'POST /tasks/:id/messages': {
          const b = await readJson(req);
          return send(res, 202, { ok: true, task_id: hub.sendMessage(id, b.text) });
        }
        case 'DELETE /tasks/:id/queue/:id':
          hub.cancelQueued(id, parts[4]);
          return send(res, 200, { ok: true });
        case 'POST /tasks/:id/queue/:id/send':
          hub.sendQueuedNow(id, parts[4]);
          return send(res, 202, { ok: true });
        case 'PUT /tasks/:id/queue/:id': {
          const b = await readJson(req);
          hub.moveQueued(id, parts[4], Number(b.index));
          return send(res, 200, { ok: true });
        }
        case 'POST /tasks/:id/handoff': {
          const b = await readJson(req);
          return send(res, 202, hub.requestHandoff(id, {
            picked: Array.isArray(b.picked) ? b.picked.map(Number) : [],
            feedback: typeof b.feedback === 'string' ? b.feedback : undefined,
            current: typeof b.current === 'string' ? b.current : undefined,
          }));
        }
        case 'POST /tasks/:id/reset': {
          const b = await readJson(req);
          return send(res, 202, hub.resetContext(id, typeof b.text === 'string' ? b.text : ''));
        }
        case 'DELETE /tasks/:id':
          hub.deleteTask(id);
          return send(res, 200, { ok: true });
        case 'DELETE /projects/:id':
          hub.deleteProject(id);
          return send(res, 200, { ok: true });
        case 'POST /tasks/:id/interrupt':
          hub.interrupt(id);
          return send(res, 202, { ok: true });
        case 'POST /tasks/:id/close':
          hub.closeSession(id);
          return send(res, 202, { ok: true });
        case 'POST /approvals/:id': {
          const b = await readJson(req);
          hub.resolveApproval(id, b.allow === true, b.message, answersOf(b.answers));
          return send(res, 200, { ok: true });
        }
        case 'POST /questions/:id': {
          const b = await readJson(req);
          hub.answerQuestion(id, b.answer);
          return send(res, 200, { ok: true });
        }
        case 'POST /open': {
          if (!local) throw new HttpError(403, '이 기기에서는 열 수 없습니다. Mac에서 열어 주세요.');
          if (!localOrigin(req.headers.origin)) throw new HttpError(403, 'forbidden');
          const b = await readJson(req);
          if (typeof b.href !== 'string' || !b.href) throw new HttpError(400, 'href is required');
          const target = linkTarget(b.href, typeof b.task_id === 'string' ? hub.cwdOf(b.task_id) : undefined);
          await openTarget(target);
          return send(res, 200, { ok: true, ...target });
        }
        case 'GET /skills':
          return send(res, 200, hub.skills.list());
        case 'POST /skills': {
          const b = await readJson(req);
          return send(res, 201, hub.skills.create(String(b.name ?? ''), b.description ?? ''));
        }
        case 'GET /skills/:id':
          return send(res, 200, hub.skills.get(id));
        case 'DELETE /skills/:id':
          hub.skills.remove(id);
          return send(res, 200, { ok: true });
        // A file inside a skill: ?path=SKILL.md, ?path=scripts/run.sh, …
        case 'GET /skills/:id/file':
          return send(res, 200, hub.skills.readFile(id, url.searchParams.get('path') ?? ''));
        case 'PUT /skills/:id/file': {
          const b = await readJson(req);
          return send(res, 200, hub.skills.writeFile(id, url.searchParams.get('path') ?? '', b.content, b.executable));
        }
        case 'DELETE /skills/:id/file':
          return send(res, 200, hub.skills.deleteFile(id, url.searchParams.get('path') ?? ''));
        default:
          throw new HttpError(404, `no route for ${route}`);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
