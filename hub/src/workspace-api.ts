import { readPromptTemplates, savePromptTemplates } from './prompt-templates.ts';
// Shared by the local HTTP API and the runner-owned workspace. Synchronous so the
// result receipt and all engine commands can commit in one SQLite transaction.
import type { Hub } from './hub.ts';
import { HttpError } from './errors.ts';
import { feedEvent } from './db.ts';
import { parseFeedParams, type FeedFilter, type MessageReceipt, type NoteContext } from '../../shared/api.ts';
import { parseCompose, parseNoteCompose } from '../../shared/compose.ts';
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

function noteContext(raw: unknown): { note_context?: NoteContext } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length > 20 || raw.some(note => !note || typeof note.title !== 'string' || !note.title.trim()
      || typeof note.text !== 'string' || !note.text.trim()))
    throw new HttpError(400, '메모 자료는 제목과 본문을 갖춘 게시글 최대 20개까지 첨부할 수 있습니다');
  const notes: NoteContext = raw.map(({ title, text }) => ({ title, text }));
  if (Buffer.byteLength(JSON.stringify(notes)) > 256 * 1024)
    throw new HttpError(400, '첨부한 메모 자료가 너무 큽니다 (최대 256 KiB)');
  return notes.length ? { note_context: notes } : {};
}

function noteEventId(input: string): number {
  const id = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(id) || id < 1) throw new HttpError(400, '메모 게시글 ID가 잘못되었습니다');
  return id;
}

export const NOTE_CUT_ROUTE = 'POST /tasks/:id/notes/:id/cut';

const routes = [
  'GET /prompt-templates',
  'PUT /prompt-templates',
  'GET /settings',
  'GET /models',
  'PUT /settings',
  'POST /projects',
  'POST /tasks',
  'POST /compose',
  'GET /feed',
  'GET /feed/:id',
  'GET /tasks/:id/events',
  'GET /tasks/:id/subagents',
  'GET /tasks/:id/subagents/history',
  'GET /tasks/:id/subagents/:id/events',
  'PATCH /tasks/:id',
  'POST /tasks/:id/messages',
  'POST /tasks/:id/scheduled-replies',
  'PATCH /tasks/:id/notes/:id',
  'DELETE /tasks/:id/notes/:id',
  NOTE_CUT_ROUTE,
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
  'GET /runners',
  'POST /runners',
  'POST /runners/:id/token',
  'GET /channels',
  'POST /channels',
  'PATCH /channels/:id',
  'DELETE /channels/:id',
  'POST /channels/:id/token',
  'GET /channels/:id/entries',
  'POST /channels/:id/read',
  'POST /channels/:id/messages',
  'GET /skills',
  'POST /skills',
  'GET /skills/:id',
  'DELETE /skills/:id',
  'GET /skills/:id/file',
  'PUT /skills/:id/file',
  'DELETE /skills/:id/file',
];
export function workspaceRoute(method: string, pathname: string) {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return undefined;
  const url=new URL(pathname,'http://workspace');
  if(url.origin!=='http://workspace')return undefined;
  pathname = url.pathname;
  return routes.find(route => {
    const [m, path] = route.split(' ');
    return m === method && new RegExp('^' + path.replaceAll(':id', '[^/]+') + '$').test(pathname);
  });
}
const localAuthorityRoutes = new Set([
  'POST /runners','POST /runners/:id/token',
  'POST /channels','PATCH /channels/:id','DELETE /channels/:id','POST /channels/:id/token',
  'GET /channels/:id/entries','POST /channels/:id/read','POST /channels/:id/messages',
  'POST /skills','GET /skills/:id','DELETE /skills/:id',
  'GET /skills/:id/file','PUT /skills/:id/file','DELETE /skills/:id/file',
]);
export function localAuthorityRoute(method:string,pathname:string) {
  return localAuthorityRoutes.has(workspaceRoute(method,pathname) ?? '');
}
/** Note writes do not participate in connector, skill snapshot or instruction selection. */
export function isNoteInput(method: string, path: string, body: Record<string, unknown>, hub?: Hub): boolean {
  const route = workspaceRoute(method, path);
  if (route === 'PATCH /tasks/:id/notes/:id' || route === 'DELETE /tasks/:id/notes/:id' || route === NOTE_CUT_ROUTE) return true;
  if (typeof body.text !== 'string') return false;
  if (route === 'POST /compose') return body.note_only === true || !!parseNoteCompose(body.text) || !!hub?.noteReplyTarget(body.text);
  return route === 'POST /tasks/:id/messages' && (body.note_only === true || hub?.store.getTask(path.split('/')[2])?.kind === 'note');
}
/** Existing-session controls must work even if the defaults file or a new runner feature is unavailable. */
export function needsDefaultInstructions(method: string, path: string, body: Record<string, unknown>): boolean {
  const route = workspaceRoute(method, path);
  if (route === 'POST /tasks' || route === 'POST /channels/:id/messages') return true;
  if (route !== 'POST /compose' && route !== 'POST /tasks/:id/messages') return false;
  if (typeof body.text !== 'string' || isNoteInput(method, path, body)) return false;
  const composed = parseCompose(body.text, [], route === 'POST /compose');
  if (composed.delivery === 'new' || composed.delivery === 'fork') return true;
  // A project-only mention or channel can create its first conversation; the remote store decides.
  return route === 'POST /compose' && !composed.mention?.no;
}
export function workspaceApi(hub: Hub, method: string, url: URL, body: Record<string, any> = {}, scheduleAcceptedAt?: number): WorkspaceResult {
  const parts = ['api', ...url.pathname.split('/').filter(Boolean)];
  const id = parts[2];
  const route = workspaceRoute(method, url.pathname);
  const required = route === 'POST /compose' || route === 'POST /tasks/:id/messages' || route === 'POST /tasks/:id/scheduled-replies' || route === 'POST /tasks/:id/reset' || route === 'PATCH /tasks/:id/notes/:id' ? ['text']
    : route === 'POST /projects' ? ['name','root_path'] : route === 'POST /tasks' ? ['project_id','prompt']
    : route === 'POST /questions/:id' ? ['answer'] : [];
  if (required.some(key=>typeof body[key] !== 'string')) throw new HttpError(400,'필수 입력은 문자열이어야 합니다');
  if (body.title !== undefined && typeof body.title !== 'string') throw new HttpError(400,'제목은 문자열이어야 합니다');
  if (route === 'POST /approvals/:id' && (typeof body.allow !== 'boolean' || (body.message !== undefined && typeof body.message !== 'string'))) throw new HttpError(400,'승인 응답 형식이 잘못되었습니다');
  if (body.permission_mode !== undefined && !['auto','default'].includes(body.permission_mode)) throw new HttpError(400,'승인 모드가 잘못되었습니다');
  switch (route) {
        case 'GET /models':
          return reply(200, hub.refreshModelCatalogs(url.searchParams.get('refresh') === '1'));
        case 'GET /prompt-templates': return reply(200,readPromptTemplates(hub.store));
        case 'PUT /prompt-templates': return reply(200,savePromptTemplates(hub.store,body));
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
          return reply(201, hub.compose(b.text, noteContext(b.note_context), b.note_only === true));
        }
        case 'GET /feed': {
          // A column's events (feedFilter); tool payloads come cut (feedEvent).
          const ts = url.searchParams.get('before_ts');
          if (ts !== null && (ts.length > 40 || !Number.isFinite(Date.parse(ts)))) throw new HttpError(400,'before_ts 형식이 잘못되었습니다');
          const cursorId = url.searchParams.get('cursor_id');
          if (cursorId !== null && (!Number.isSafeInteger(Number(cursorId)) || Number(cursorId) < 0)) throw new HttpError(400,'cursor_id 형식이 잘못되었습니다');
          return reply(200, hub.store.listFeed(intParam(url, 'limit', 1000, 5000)!, intParam(url, 'before', undefined), feedFilter(url),
            ts ? {ts,id:cursorId === null ? Number.MAX_SAFE_INTEGER : Number(cursorId),
              editedOrder: url.searchParams.get('edited_order') === '1'} : undefined).map(feedEvent));
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
          const after = intParam(url, 'after', undefined);
          if (after !== undefined) {
            const events = hub.store.eventsAfter(id, after, 501);
            return reply(200, { events: events.slice(0, 500), more: events.length > 500, incremental: true });
          }
          const before = intParam(url, 'before', undefined);
          const events = hub.store.listEvents(id, 500, intParam(url, 'since', undefined), before);
          const more = events.length > 0 && hub.store.hasEventsBefore(id, events[0].id);
          const moved = more && before === undefined && hub.store.getTask(id)?.kind === 'note'
            ? hub.store.movedNotes(id, events[0].id, events.reduce((oldest, e) => {
              const ts = e.edited_at ?? e.ts;
              return ts < oldest ? ts : oldest;
            }, events[0].edited_at ?? events[0].ts))
            : [];
          return reply(200, { events, more, ...(moved.length ? { moved } : {}) });
        }
        case 'GET /tasks/:id/subagents':
          return reply(200, hub.subagents.list(id));
        case 'GET /tasks/:id/subagents/history':
          return reply(200, hub.subagents.history(id, 500, intParam(url, 'before', undefined)));
        case 'GET /tasks/:id/subagents/:id/events': {
          // A subagent's steps, newest page first like a thread's; `session` names its session.
          const session = url.searchParams.get('session');
          if (!session) throw new HttpError(400, 'session이 필요합니다');
          let subagent: string;
          try { subagent = decodeURIComponent(parts[4]); } catch { throw new HttpError(400, '서브 에이전트 ID가 잘못되었습니다'); }
          return reply(200, hub.subagents.events(id, session, subagent, 500, intParam(url, 'before', undefined)));
        }
        case 'PATCH /tasks/:id':
          return reply(200, hub.renameTask(id, body.title));
        case 'POST /tasks/:id/messages': {
          const b = body;
          const receipt: MessageReceipt = {};
          const task_id = hub.sendMessage(id, b.text, false, receipt, noteContext(b.note_context), {
            noteOnly: b.note_only === true, codeReview: b.code_review === true,
          });
          return reply(202, { ok: true, task_id, ...receipt });
        }
        case 'POST /tasks/:id/scheduled-replies':
          return reply(202, hub.scheduleReply(id, body.text, body.scheduled_at, scheduleAcceptedAt, body.session_id));
        case 'PATCH /tasks/:id/notes/:id':
          return reply(200, hub.updateNote(id, noteEventId(parts[4]), body.text));
        case NOTE_CUT_ROUTE:
          if (!Number.isSafeInteger(body.revision) || body.revision < 0)
            throw new HttpError(400, '복사한 메모 글의 버전이 필요합니다');
          hub.deleteNote(id, noteEventId(parts[4]), body.revision);
          return reply(200, { ok: true });
        case 'DELETE /tasks/:id/notes/:id':
          hub.deleteNote(id, noteEventId(parts[4]));
          return reply(200, { ok: true });
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
        case 'GET /runners': return reply(200, hub.remotes.list());
        case 'POST /runners': return reply(201, hub.remotes.register(body.address));
        case 'POST /runners/:id/token': return reply(200, hub.remotes.rotate(id));
        case 'GET /channels': return reply(200, hub.channels.list());
        case 'POST /channels': return reply(201, hub.channels.create(body as any));
        case 'PATCH /channels/:id': return reply(200, hub.channels.update(id, body));
        case 'DELETE /channels/:id': hub.channels.remove(id); return reply(200, {ok:true});
        case 'POST /channels/:id/token': return reply(200, hub.channels.rotateToken(id));
        case 'GET /channels/:id/entries': return reply(200, hub.channels.entries(id,
          intParam(url,'limit',60,200), intParam(url,'before',undefined), url.searchParams.get('q') ?? ''));
        case 'POST /channels/:id/read': return reply(200, hub.channels.read(id,body.through_id));
        case 'POST /channels/:id/messages': return reply(200, hub.sendChannelMessage(id,body as any));
        case 'GET /skills': return reply(200, hub.skills.list());
        case 'POST /skills': return reply(201, body.content !== undefined ? hub.skills.createFromContent(body.content) : hub.skills.create(String(body.name ?? ''),body.description ?? ''));
        case 'GET /skills/:id': return reply(200, hub.skills.get(id));
        case 'DELETE /skills/:id': hub.skills.remove(id); return reply(200, {ok:true});
        case 'GET /skills/:id/file': return reply(200, hub.skills.readFile(id,url.searchParams.get('path') ?? ''));
        case 'PUT /skills/:id/file': return reply(200, hub.skills.writeFile(id,url.searchParams.get('path') ?? '',body.content,body.executable));
        case 'DELETE /skills/:id/file': return reply(200, hub.skills.deleteFile(id,url.searchParams.get('path') ?? ''));

    default: throw new HttpError(404, '공유 작업공간에서 지원하지 않는 요청입니다');
  }
}
