// Shared by the local HTTP API and the runner-owned workspace. Synchronous so the
// result receipt and all engine commands can commit in one SQLite transaction.
import type { Hub } from './hub.ts';
import { HttpError } from './errors.ts';
import { feedEvent } from './db.ts';
import { parseFeedParams, type FeedFilter, type MessageReceipt } from '../../shared/api.ts';
export interface WorkspaceResult { status: number; body: any }
const reply = (status: number, body: unknown): WorkspaceResult => ({ status, body });
/** Question answers from a request body: string values keyed by question text, else none. */
function answersOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, a]) => typeof a === 'string'));
  return Object.keys(out).length ? out : undefined;
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


const routes = [
  'GET /settings',
  'PUT /settings',
  'POST /projects',
  'POST /tasks',
  'POST /compose',
  'GET /feed',
  'GET /feed/:id',
  'GET /tasks/:id/events',
  'POST /tasks/:id/messages',
  'DELETE /tasks/:id/queue/:id',
  'POST /tasks/:id/queue/:id/send',
  'PUT /tasks/:id/queue/:id',
  'POST /tasks/:id/handoff',
  'POST /tasks/:id/reset',
  'DELETE /tasks/:id',
  'DELETE /projects/:id',
  'POST /tasks/:id/interrupt',
  'POST /tasks/:id/close',
  'POST /approvals/:id',
  'POST /questions/:id',
];
export function workspaceRoute(method: string, pathname: string) {
  return routes.find(route => {
    const [m, path] = route.split(' ');
    return m === method && new RegExp('^' + path.replaceAll(':id', '[^/]+') + '$').test(pathname);
  });
}
export function workspaceApi(hub: Hub, method: string, url: URL, body: Record<string, any> = {}): WorkspaceResult {
  const parts = ['api', ...url.pathname.split('/').filter(Boolean)];
  const id = parts[2];
  const route = workspaceRoute(method, url.pathname);
  const required = route === 'POST /compose' || route === 'POST /tasks/:id/messages' || route === 'POST /tasks/:id/reset' ? ['text']
    : route === 'POST /projects' ? ['name','root_path'] : route === 'POST /tasks' ? ['project_id','prompt']
    : route === 'POST /questions/:id' ? ['answer'] : [];
  if (required.some(key=>typeof body[key] !== 'string')) throw new HttpError(400,'필수 입력은 문자열이어야 합니다');
  if (body.title !== undefined && typeof body.title !== 'string') throw new HttpError(400,'제목은 문자열이어야 합니다');
  if (route === 'POST /approvals/:id' && (typeof body.allow !== 'boolean' || (body.message !== undefined && typeof body.message !== 'string'))) throw new HttpError(400,'승인 응답 형식이 잘못되었습니다');
  if (body.permission_mode !== undefined && !['auto','default'].includes(body.permission_mode)) throw new HttpError(400,'승인 모드가 잘못되었습니다');
  switch (route) {
        case 'GET /settings':
          return reply(200, hub.settings());
        case 'PUT /settings':
          return reply(200, hub.setSettings(body));
        case 'POST /projects': {
          const b = body;
          return reply(201, hub.createProject(b.name, b.root_path));
        }
        case 'POST /tasks': {
          const b = body;
          return reply(201, hub.createTask(b.project_id, b.title, b.prompt, b.permission_mode));
        }
        case 'POST /compose': {
          const b = body;
          return reply(201, hub.compose(b.text));
        }
        case 'GET /feed': {
          // A column's events (feedFilter); tool payloads come cut (feedEvent).
          return reply(200, hub.store.listFeed(intParam(url, 'limit', 1000, 5000)!, intParam(url, 'before', undefined), feedFilter(url)).map(feedEvent));
        }
        case 'GET /feed/:id': {
          // `/feed/count`: how many posts the column has in all, for its "loaded / total".
          if (id !== 'count') throw new HttpError(404, `no route for ${route}`);
          return reply(200, hub.store.countFeed(feedFilter(url)));
        }
        case 'GET /tasks/:id/events': {
          // `since`: a thread opened at an older post loads from that post on. `before`: the page of
          // history before a client's oldest event; `more`: still older events exist. `ids`: just
          // those events, whole (live events come cut, like the feed's).
          const ids = url.searchParams.get('ids');
          if (ids) {
            const list = ids.split(',').map(Number).filter(Number.isInteger).slice(0, 500);
            return reply(200, { events: hub.store.eventsByIds(id, list), more: false });
          }
          const events = hub.store.listEvents(id, 500, intParam(url, 'since', undefined), intParam(url, 'before', undefined));
          return reply(200, { events, more: events.length > 0 && hub.store.hasEventsBefore(id, events[0].id) });
        }
        case 'POST /tasks/:id/messages': {
          const b = body;
          const receipt: MessageReceipt = {};
          const task_id = hub.sendMessage(id, b.text, false, receipt);
          return reply(202, { ok: true, task_id, ...receipt });
        }
        case 'DELETE /tasks/:id/queue/:id':
          hub.cancelQueued(id, parts[4]);
          return reply(200, { ok: true });
        case 'POST /tasks/:id/queue/:id/send':
          hub.sendQueuedNow(id, parts[4]);
          return reply(202, { ok: true });
        case 'PUT /tasks/:id/queue/:id': {
          const b = body;
          hub.moveQueued(id, parts[4], Number(b.index));
          return reply(200, { ok: true });
        }
        case 'POST /tasks/:id/handoff': {
          const b = body;
          return reply(202, hub.requestHandoff(id, {
            picked: Array.isArray(b.picked) ? b.picked.map(Number) : [],
            feedback: typeof b.feedback === 'string' ? b.feedback : undefined,
            current: typeof b.current === 'string' ? b.current : undefined,
          }));
        }
        case 'POST /tasks/:id/reset': {
          const b = body;
          return reply(202, hub.resetContext(id, typeof b.text === 'string' ? b.text : ''));
        }
        case 'DELETE /tasks/:id':
          hub.deleteTask(id);
          return reply(200, { ok: true });
        case 'DELETE /projects/:id':
          hub.deleteProject(id);
          return reply(200, { ok: true });
        case 'POST /tasks/:id/interrupt':
          hub.interrupt(id);
          return reply(202, { ok: true });
        case 'POST /tasks/:id/close':
          hub.closeSession(id);
          return reply(202, { ok: true });
        case 'POST /approvals/:id': {
          const b = body;
          hub.resolveApproval(id, b.allow === true, b.message, answersOf(b.answers));
          return reply(200, { ok: true });
        }
        case 'POST /questions/:id': {
          const b = body;
          hub.external.answerQuestion(id, b.answer);
          return reply(200, { ok: true });
        }

    default: throw new HttpError(404, '공유 작업공간에서 지원하지 않는 요청입니다');
  }
}
