import { feedParams, type FeedFilter } from '../../shared/api.ts';
import type { AccessView, ChannelMessageInput, MessageReceipt, NoteContext, Subagent } from '../../shared/api.ts';
import type { UpdateView } from '../../shared/update.ts';
import type { Channel, ChannelEntryPage, ChannelInput, ChannelTokenReceipt, DeskState, EngineUsage, HubEvent, HubMessage, Project, Settings, Skill, TaskView } from './types.ts';
import { workspaceId, SharedPending } from './workspace.ts';
import { composeSource, compareEvents, discoverSources, eventSourceIndex, getSources, mapEvent, mapState, mapSubagent, mapTask, nativeEventId, scopeId, sourceBase, sourceConnected, sourceFilter, sourceIndex, splitId } from './federation.ts';
import { noteRevision, onNoteChange, reportNoteChange } from './noteEvents.ts';

const noteWrites = new Set<number>();
async function writeNotePost<T>(eventId: number, write: () => Promise<T>): Promise<T> {
  if (noteWrites.has(eventId)) throw new Error('이 메모 글을 처리 중입니다. 잠시 뒤 다시 시도해 주세요.');
  noteWrites.add(eventId);
  try { return await write(); }
  finally { noteWrites.delete(eventId); }
}

// getRandomValues works on phones using an HTTP LAN address.
export const workspaceOperationId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export class CodeSendRejected extends Error {}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, target?:string, operationId?: string): Promise<T> {
  let source=target??'';
  const url=new URL(path,'http://desk');
  const route=url.pathname;
  url.pathname=url.pathname.split('/').map(part=>{
    const [owner,id]=splitId(decodeURIComponent(part));
    if(owner){if(source&&source!==owner)throw new Error('서로 다른 작업공간의 요청입니다');source=owner;}
    return encodeURIComponent(id);
  }).join('/');
  let input=body as Record<string,unknown>|undefined;
  if(input) {
    input={...input};
    for(const key of ['project_id','task_id']) if(typeof input[key]==='string') {
      const [owner,id]=splitId(input[key] as string);
      if(owner){if(source&&source!==owner)throw new Error('서로 다른 작업공간의 요청입니다');source=owner;input[key]=id;}
    }
    if(Array.isArray(input.picked))input.picked=input.picked.map(id=>nativeEventId(Number(id)));
  }
  if(source) {
    await discoverSources();
    sourceIndex(source);
    for(const key of ['before','since','after','ids']) {
      const value=url.searchParams.get(key);if(value)url.searchParams.set(key,value.split(',').map(v=>String(nativeEventId(Number(v)))).join(','));
    }
  }
  if(source&&route.startsWith('/channels/'))throw new Error('채널 대화는 같은 허브의 프로젝트를 선택하세요');
  path=url.pathname+url.search;
  const scheduling = method === 'POST' && route.endsWith('/scheduled-replies');
  const codeReview = method === 'POST' && route.endsWith('/messages') && input?.code_review === true;
  const requestId = operationId ?? (source && method !== 'GET' && route !== '/open' ? workspaceOperationId() : undefined);
  const init:RequestInit = {
    method,
    headers: { ...(input ? { 'content-type': 'application/json' } : {}), ...(requestId ? {'x-desk-operation-id':requestId} : {}) },
    body: input ? JSON.stringify(input) : undefined,
    signal,
  };
  const send = async () => {
    const res = await fetch(`${sourceBase(source)}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (scheduling && res.ok && data?.shared_pending !== true &&
        (typeof data?.task_id !== 'string' || typeof data?.queued_id !== 'string'))
      throw new Error('예약 접수 결과를 확인하지 못했습니다. 입력을 그대로 두고 다시 시도해 주세요');
    if (codeReview && res.ok && data?.shared_pending !== true && (typeof data?.task_id !== 'string' || !data.task_id))
      throw new Error('코드 전송 결과를 확인하지 못했습니다. 다시 시도해 주세요');
    return { res, data };
  };
  const { res, data } = await send().catch(e=>{if(requestId&&!signal?.aborted)return send();throw e;});
  if (!res.ok) {
    if (codeReview && res.status >= 400 && res.status < 500 && ![408,425,429].includes(res.status) && typeof data.error === 'string')
      throw new CodeSendRejected(data.error);
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  if (data.shared_pending) throw new SharedPending(data.operation_id);
  if(!source)return data as T;
  const index=sourceIndex(source);
  if(route==='/compose'||route==='/tasks'&&method==='POST'||method==='PATCH'&&/^\/tasks\/[^/]+$/.test(route))return mapTask(source,index,data) as T;
  if(route==='/projects'&&method==='POST')return {...data,id:scopeId(source,data.id)} as T;
  if(method==='PATCH'&&/^\/tasks\/[^/]+\/notes\/\d+$/.test(route))return mapEvent(source,index,data) as T;
  if(route.endsWith('/events')) {
    if(Array.isArray(data))return data.map(e=>mapEvent(source,index,e)) as T;
    const mapped = (e: HubEvent) => mapEvent(source, index, e);
    return {...data,events:data.events.map(mapped), ...(Array.isArray(data.moved) && { moved: data.moved.map(mapped) }) } as T;
  }
  if(data.task_id)data.task_id=scopeId(source,data.task_id);
  if(data.queued_id)data.queued_id=scopeId(source,data.queued_id);
  return data as T;
}

/** A feed column's filter as the hub applies it (see feedQuery in useHub.ts); `members` stays on the client. */
export interface FeedQuery extends FeedFilter { members?: string[] }

const feedSearch = (q: FeedQuery) => new URLSearchParams(feedParams(q));
const snapshots=new Map<string,DeskState>();
class LocalUnavailable extends Error {}
const removedProjects=new Set<string>();
/** Keep the last remote snapshot current so a disconnect cannot erase SSE-only tasks/answers. */
const refreshing=new Map<string,Set<HubMessage[]>>();
function applyMessage(s:DeskState,m:HubMessage) {
  if(m.type==='task')s.tasks=[...s.tasks.filter(t=>t.id!==m.task.id),m.task];
  if(m.type==='approval')s.approvals=[...s.approvals.filter(a=>a.id!==m.approval.id),...(m.approval.status==='pending'?[m.approval]:[])];
  if(m.type==='question')s.questions=[...s.questions.filter(q=>q.id!==m.question.id),...(m.question.status==='pending'?[m.question]:[])];
  if(m.type==='removed'){
    s.tasks=s.tasks.filter(t=>!m.taskIds.includes(t.id));s.projects=s.projects.filter(p=>!m.projectIds.includes(p.id));
    s.approvals=s.approvals.filter(a=>!m.taskIds.includes(a.task_id));s.questions=s.questions.filter(q=>!m.taskIds.includes(q.task_id));
  }
}
function remember(source:string,m:HubMessage) {
  if(!['task','approval','question','removed'].includes(m.type))return;
  const s=snapshots.get(source);if(s)applyMessage(s,m);
  if(m.type==='removed'){
    for(const id of m.projectIds)removedProjects.add(id);
    projects=projects.filter(p=>!removedProjects.has(p.id));
  }
  for(const updates of refreshing.get(source)??[])updates.push(m);
}
let projects:Project[]=[];
/** Publish each workspace as it arrives; pending/offline workspaces retain their last snapshot. */
async function state(onProgress?: (value: DeskState) => void, scope?: string): Promise<DeskState> {
  if (scope === undefined) await discoverSources();
  const sources = [{ id: '', view_index: 0 }, ...getSources()].filter(source => scope === undefined || source.id === scope);
  const available = new Set<string>();
  const unavailable = new Set<string>();
  const values = new Map(sources.flatMap(source => {
    const held = snapshots.get(source.id);
    return held ? [[source.id, held] as const] : [];
  }));
  let failed = false;
  const combined = (): DeskState => {
    const local = values.get('') ?? { projects: [], tasks: [], approvals: [], questions: [], channels: [], runner: { connected: false } };
    const current = sources.filter(source => !source.id || getSources().some(s => s.id === source.id));
    const all = current.flatMap(source => values.get(source.id) ?? []);
    const fetchedProjects = all.flatMap(s => s.projects).filter(p => !removedProjects.has(p.id));
    projects = scope === undefined ? fetchedProjects
      : [...projects.filter(p => splitId(p.id)[0] !== scope), ...fetchedProjects];
    return { ...local, projects: fetchedProjects, tasks: all.flatMap(s => s.tasks), approvals: all.flatMap(s => s.approvals),
      questions: all.flatMap(s => s.questions), availableSources: current.filter(s => available.has(s.id)).map(s => s.id),
      unavailableSources: current.filter(s => unavailable.has(s.id)).map(s => s.id) };
  };
  await Promise.all(sources.map(async source => {
    const updates: HubMessage[] = [];
    let active = refreshing.get(source.id);
    if (!active) refreshing.set(source.id, active = new Set());
    active.add(updates);
    try {
      let response: Response;
      try { response = await fetch(sourceBase(source.id) + '/state'); }
      catch { throw new LocalUnavailable(); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!source.id && response.status < 500) { failed = true; throw new Error(data.error ?? `HTTP ${response.status}`); }
        throw new LocalUnavailable();
      }
      const value = source.id ? mapState(source.id, source.view_index, data) : data as DeskState;
      for (const update of updates) applyMessage(value, update);
      values.set(source.id, value); snapshots.set(source.id, value); available.add(source.id);
      if (source.id) sourceConnected(source.id, true);
    } catch (error) {
      if (failed) throw error;
      unavailable.add(source.id);
      if (source.id) sourceConnected(source.id, false);
      const held = snapshots.get(source.id);
      if (held) values.set(source.id, { ...held, runner: { connected: false }, tasks: held.tasks.map(t => ({ ...t, runner_connected: false })) });
    } finally {
      active.delete(updates);
      if (!active.size) refreshing.delete(source.id);
    }
    if (!failed && available.size + unavailable.size < sources.length) onProgress?.(combined());
  }));
  for (const id of snapshots.keys()) if (id && !getSources().some(s => s.id === id)) snapshots.delete(id);
  return combined();
}
export interface FeedPage { events: HubEvent[]; complete: boolean; incompleteSources?: string[] }
async function feeds(limit:number,before:HubEvent|undefined,q:FeedQuery,signal?:AbortSignal,onProgress?: (page: FeedPage) => void,scope?: string) {
  if (scope === undefined) await discoverSources();
  signal?.throwIfAborted();
  const all=[{id:'',view_index:0},...getSources()].filter(source => scope === undefined || source.id === scope);
  const pages = new Map<string, FeedPage>();
  let failed = false;
  const combined = (): FeedPage => ({ events: [...pages.values()].flatMap(page => page.events).sort(compareEvents).slice(-limit),
    complete: pages.size === all.length && [...pages.values()].every(page => page.complete),
    ...([...pages].some(([,page]) => !page.complete) && { incompleteSources: [...pages].filter(([,page]) => !page.complete).map(([id]) => id) }) });
  await Promise.all(all.map(async source=>{
    const filter=sourceFilter(source.id,q);
    if(!filter) { pages.set(source.id, {events:[],complete:true}); return; }
    const p=feedSearch(filter);p.set('limit',String(limit));
    // A stable timestamp + source index + native ID cursor prevents cross-store gaps/ties.
    p.set('before_ts',before?.edited_at??before?.ts??'9999-12-31T23:59:59.999Z');
    p.set('edited_order','1');
    const index=before?eventSourceIndex(before.id):0;
    p.set('cursor_id',String(!before||source.view_index<index?Number.MAX_SAFE_INTEGER:source.view_index>index?0:nativeEventId(before.id)));
    let page: FeedPage;
    try {
      const r=await fetch(sourceBase(source.id)+'/feed?'+p,{signal});
      if(!r.ok){if(!source.id&&!before&&r.status>=500)page={events:[],complete:false};else throw Error('글을 불러오지 못했습니다');}
      else page={events:(await r.json() as HubEvent[]).map(e=>mapEvent(source.id,source.view_index,e)),complete:true};
    }catch(e){
      if(before||signal?.aborted||(!source.id&&!(e instanceof TypeError))){failed=true;throw e;}
      page={events:[],complete:false};
    }
    pages.set(source.id,page);
    if(!failed&&!signal?.aborted)onProgress?.(combined());
  }));
  signal?.throwIfAborted();
  return combined();
}
export interface FeedTotal { posts: number; tasks: number }
function sumCounts(counts: Iterable<FeedTotal>): FeedTotal {
  let posts = 0, tasks = 0;
  for (const count of counts) { posts += count.posts; tasks += count.tasks; }
  return { posts, tasks };
}
async function feedCount(q:FeedQuery,signal?:AbortSignal,scope?:string,details=false): Promise<FeedTotal & { bySource?: Map<string, FeedTotal> }> {
  if (scope === undefined) await discoverSources();
  const counts=await Promise.all([{id:''},...getSources()].filter(source => scope === undefined || scope === source.id).map(async source=>{
    const empty = [source.id, {posts:0,tasks:0}] as const;
    const filter=sourceFilter(source.id,q);if(!filter)return empty;
    let r:Response;
    try {r=await fetch(sourceBase(source.id)+'/feed/count?'+feedSearch(filter),{signal});}
    catch(error){
      if (details && scope === undefined && source.id && !signal?.aborted) return;
      if (!source.id && scope === undefined && !signal?.aborted) return empty;
      throw error;
    }
    if(!r.ok){
      if (scope===undefined && r.status>=500) {
        if (!source.id) return empty;
        if (details) return;
      }
      throw Error('글 수를 불러오지 못했습니다');
    }
    return [source.id, await r.json() as FeedTotal] as const;
  }));
  const bySource=new Map(counts.filter(count=>count!==undefined));
  return { ...sumCounts(bySource.values()), ...(details && {bySource}) };
}

/** Events per feed page: a full page means older ones may exist. */
export const FEED_PAGE = 1000;

export const api = {
  promptTemplates: (source='',input?:import('../../shared/prompt-templates.ts').PromptTemplates,signal?:AbortSignal,operationId?:string)=>call<import('../../shared/prompt-templates.ts').PromptTemplates>(input?'PUT':'GET','/prompt-templates',input,signal,source,operationId),
  codeView: (taskId: string, path?: string, signal?: AbortSignal, kind?: 'tracked' | 'untracked', commit?: string, comparison?: {base?:string;target?:string;worktree?:string|null}) => {
    const [source, task_id] = splitId(taskId);
    return call<import('../../shared/code-view.ts').CodeViewResult>('POST', '/code-view', {source,task_id,path,kind,commit,...comparison}, signal, '');
  },
  remember,
  updates: (signal?: AbortSignal, refreshLatest = false) => call<UpdateView>('GET', refreshLatest ? '/updates?refresh=1' : '/updates', undefined, signal),
  checkUpdates: (signal?: AbortSignal) => call<UpdateView>('POST', '/updates/check', {}, signal),
  approveUpdate: (commit: string, mode: 'immediate' | 'when-idle', signal?: AbortSignal) => call<UpdateView>('POST', '/updates/approve', { commit, mode }, signal),
  cancelUpdate: (commit: string, signal?: AbortSignal) => call<UpdateView>('POST', '/updates/cancel', { commit }, signal),
  runners: () => call<import('../../shared/remote.ts').RemoteRunnerView[]>('GET', '/runners'),
  rotateRunner: (id: string) => call<{runner: import('../../shared/remote.ts').RemoteRunnerView; token: string}>('POST', `/runners/${encodeURIComponent(id)}/token`),
  registerRunner: (address: string) => call<{runner: import('../../shared/remote.ts').RemoteRunnerView; token: string}>('POST', '/runners', {address}),
  channels: () => call<Channel[]>('GET', '/channels'),
  createChannel: (input: ChannelInput) => call<ChannelTokenReceipt>('POST', '/channels', input),
  updateChannel: (id: string, input: Partial<Pick<ChannelInput, 'name' | 'feed_url' | 'enabled'>>) => call<Channel>('PATCH', `/channels/${encodeURIComponent(id)}`, input),
  deleteChannel: (id: string) => call('DELETE', `/channels/${encodeURIComponent(id)}`),
  rotateChannelToken: (id: string) => call<ChannelTokenReceipt>('POST', `/channels/${encodeURIComponent(id)}/token`),
  refreshChannel: (id: string) => call<Channel>('POST', `/channels/${encodeURIComponent(id)}/refresh`),
  readChannel: (id: string, through_id: number) => call<Channel>('POST', `/channels/${encodeURIComponent(id)}/read`, { through_id }),
  sendChannel: (id: string, input: ChannelMessageInput) => call<{ task: TaskView } & MessageReceipt>('POST', `/channels/${encodeURIComponent(id)}/messages`, input),
  channelEntries: (id: string, at: { before?: number; q?: string } = {}) => {
    const query = new URLSearchParams({ limit: '100' });
    if (at.before != null) query.set('before', String(at.before));
    if (at.q?.trim()) query.set('q', at.q.trim());
    return call<ChannelEntryPage>('GET', `/channels/${encodeURIComponent(id)}/entries?${query}`);
  },
  state,
  /**
   * The newest `limit` events, oldest first; `before`: those before that event id; `q`: only those a
   * column shows. Tool calls and results come cut (`clipped`); a task's own events are whole.
   */
  feed: (limit = FEED_PAGE, before?: HubEvent, q: FeedQuery = {}, signal?: AbortSignal) => feeds(limit,before,q,signal).then(page=>page.events),
  feedPage: (limit = FEED_PAGE, before?: HubEvent, q: FeedQuery = {}, signal?: AbortSignal, onProgress?: (page: FeedPage) => void, scope?: string) => feeds(limit,before,q,signal,onProgress,scope),
  feedCount,
  /** The task's subagents and background commands, oldest first. */
  subagents: async (taskId: string) => {
    const list = await call<Subagent[]>('GET', `/tasks/${taskId}/subagents`);
    const [source] = splitId(taskId);
    return source ? list.map(s => mapSubagent(source, s)) : list;
  },
  /** A page of a subagent's conversation (events with `subagent_id`), oldest first; `before` pages back. */
  subagentEvents: (s: Subagent, before?: number) => {
    const q = new URLSearchParams({ session: splitId(s.session_id)[1] });
    if (before) q.set('before', String(before));
    return call<{ events: HubEvent[]; more: boolean }>('GET', `/tasks/${s.task_id}/subagents/${encodeURIComponent(s.id)}/events?${q}`);
  },
  /**
   * A page of a task's history, oldest first: its newest events (below `before`, when given), and
   * every event from `since` on. `more`: older events exist before the page.
   */
  events: (taskId: string, at: { since?: number; before?: number; after?: number; ids?: number[] } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (at.ids?.length) q.set('ids', at.ids.join(','));
    if (at.since) q.set('since', String(at.since));
    if (at.before) q.set('before', String(at.before));
    if (at.after) { q.set('after', String(at.after)); q.set('since', String(at.after)); }
    const qs = q.toString();
    const edits = new Map<number, HubEvent>();
    const offNotes = onNoteChange(change => {
      if (change.type === 'event_updated' && change.event.task_id === taskId) edits.set(change.event.id, change.event);
    });
    // A hub not yet restarted answers with the bare array (newest 500, no paging).
    return call<{ events: HubEvent[]; more: boolean; incremental?: true; moved?: HubEvent[] } | HubEvent[]>('GET', `/tasks/${taskId}/events${qs ? `?${qs}` : ''}`, undefined, signal)
      .then((r) => {
        const page = Array.isArray(r) ? { events: r, more: false } : r;
        if (!edits.size) return page;
        const latest = (event: HubEvent) => {
          const edited = edits.get(event.id);
          return edited && (noteRevision(edited) ?? 0) > (noteRevision(event) ?? 0) ? edited : event;
        };
        return { ...page, events: page.events.map(latest), ...(page.moved && { moved: page.moved.map(latest) }) };
      }).finally(offNotes);
  },
  /** Saves a file on the hub's machine (for a device without it); returns the saved path. */
  upload: async (file: File) => {
    if (workspaceId) throw new Error('공유 러너에 파일을 먼저 옮긴 뒤 원격 경로를 입력하세요');
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as { path: string };
  },
  createProject: (name: string, root_path: string) => call<Project>('POST', '/projects', { name, root_path }),
  compose: (text: string, source?: string, noteContext?: NoteContext, noteOnly?: boolean) =>
    call<TaskView>('POST', '/compose', { text, note_context: noteContext, note_only: noteOnly }, undefined, composeSource(text, projects, source)),
  createTask: (project_id: string, title: string, prompt: string) =>
    call<TaskView>('POST', '/tasks', { project_id, title, prompt }),
  /** Returns the task that got the message: a new one for #new or #fork. */
  send: (taskId: string, text: string) => call<{ task_id: string } & MessageReceipt>('POST', `/tasks/${taskId}/messages`, { text }),
  sendCode: (taskId: string, text: string, operationId: string) => call<{ task_id: string } & MessageReceipt>('POST', `/tasks/${taskId}/messages`, { text, code_review: true },undefined,undefined,operationId),
  scheduleReply: (taskId: string, text: string, at: string, operationId: string, sessionId?: string) =>
    call<{ task_id: string; queued_id: string }>('POST', `/tasks/${taskId}/scheduled-replies`, { text, scheduled_at: at, session_id: sessionId }, undefined, undefined, operationId),
  writeNote: (taskId: string, text: string) => call('POST', `/tasks/${taskId}/messages`, { text, note_only: true }),
  editNote: (taskId: string, eventId: number, text: string) =>
    writeNotePost(eventId, async () => {
      const event = await call<HubEvent>('PATCH', `/tasks/${taskId}/notes/${nativeEventId(eventId)}`, { text });
      reportNoteChange({ type: 'event_updated', event });
    }),
  cutNote: (taskId: string, eventId: number, revision: number, copy: () => Promise<boolean>) =>
    writeNotePost(eventId, async () => {
      if (!await copy()) return false;
      await call<{ ok: true }>('POST', `/tasks/${taskId}/notes/${nativeEventId(eventId)}/cut`, { revision });
      reportNoteChange({ type: 'event_removed', task_id: taskId, event_id: eventId });
      return true;
    }),
  renameTask: (taskId: string, title: string) => call<TaskView>('PATCH', `/tasks/${taskId}`, { title }),
  cancelQueued: (taskId: string, queuedId: string) => call('DELETE', `/tasks/${taskId}/queue/${queuedId}`),
  /** Sends a waiting message at once: into the running turn, like #now. */
  sendQueuedNow: (taskId: string, queuedId: string) => call('POST', `/tasks/${taskId}/queue/${queuedId}/send`),
  /** Moves a waiting message to `index` (0 = sent first). */
  moveQueued: (taskId: string, queuedId: string, index: number) => call('PUT', `/tasks/${taskId}/queue/${queuedId}`, { index }),
  /** Asks the task's agent for a handoff summary of the conversation (컨텍스트 재구성), or to revise `current`. */
  requestHandoff: (taskId: string, a: { picked?: number[]; feedback?: string; current?: string }) =>
    call<{ queued: boolean }>('POST', `/tasks/${taskId}/handoff`, a),
  /** Continues the task in a fresh engine session whose first message is `text`, after the running turn. */
  resetContext: (taskId: string, text: string) => call<{ queued: boolean }>('POST', `/tasks/${taskId}/reset`, { text }),
  interrupt: (taskId: string) => call('POST', `/tasks/${taskId}/interrupt`),
  /** Ends the task's engine process; the next reply resumes the conversation. */
  closeSession: (taskId: string) => call('POST', `/tasks/${taskId}/close`),
  /** Deletes a task for good, or a project with all its tasks; open sessions are closed first. */
  deleteTask: (taskId: string) => call('DELETE', `/tasks/${taskId}`),
  deleteProject: (projectId: string) => call('DELETE', `/projects/${projectId}`),
  /** `answers`: picks for an agent's multiple-choice question, keyed by question text. */
  resolve: (approvalId: string, allow: boolean, message?: string, answers?: Record<string, string>) =>
    call('POST', `/approvals/${approvalId}`, { allow, message, answers }),
  answer: (questionId: string, answer: string) => call('POST', `/questions/${questionId}`, { answer }),
  /** Opens a link from a reply in its local app (via the hub, which may run `open`). */
  open: (href: string, taskId?: string) => call<{ ok: true }>('POST', '/open', { href, task_id: taskId }),
  filePath: (href: string, taskId: string, previewId?: string, signal?: AbortSignal) => {
    const [source, task] = splitId(taskId);
    return call<{path:string;canReveal?:boolean}>('GET', '/file-path?' + new URLSearchParams({ href, task_id: task, ...(previewId ? {preview_id:previewId} : {}) }), undefined, signal, source);
  },
  revealFile: (href: string, taskId: string, previewId?: string) =>
    call<{ok:true}>('POST', '/file-reveal', { href, task_id: taskId, preview_id: previewId }),
  /** Addresses (with QR codes) other devices open the desk at; only on the hub's own machine. */
  access: () => call<{ urls: { url: string; qr: string }[] } & AccessView>('GET', '/access'),
  answerAccess: (id: string, allow: boolean) => call<AccessView>('POST', `/access-requests/${id}`, { allow }),
  renameDevice: (id: string, name: string) => call<AccessView>('PATCH', `/devices/${id}`, { name }),
  removeDevice: (id: string) => call<AccessView>('DELETE', `/devices/${id}`),
  rotateAccessToken: () => call<{ ok: true }>('POST', '/access-token'),
  modelCatalogs: (source='',refresh=false,signal?:AbortSignal) => call<import('../../shared/model-catalog.ts').RunnerModelCatalog[]>('GET', `/models${refresh ? '?refresh=1' : ''}`,undefined,signal,source),
  settings: (source='') => call<Settings>('GET', '/settings',undefined,undefined,source),
  /** Each engine's plan limits: used share and reset time per window. `refresh`: skip the hub's one-minute cache. */
  usage: (engine: string, refresh = false) => call<EngineUsage>('GET', `/usage?engine=${engine}${refresh ? '&refresh=1' : ''}`),
  /** Only the engines and keys given change; null clears one. */
  saveSettings: (s: { [E in keyof Settings]?: Partial<Settings[E]> }, signal?: AbortSignal) => call<Settings>('PUT', '/settings', s, signal),
  skills: (source='') => call<Skill[]>('GET', '/skills',undefined,undefined,source),
  createSkillFromContent: (content: string) => call<Skill>('POST', '/skills', { content }),
  createSkill: (name: string, description: string) => call<Skill>('POST', '/skills', { name, description }),
  deleteSkill: (name: string) => call('DELETE', `/skills/${name}`),
  readSkillFile: (name: string, path: string) =>
    call<{ path: string; content: string; executable: boolean }>('GET', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
  writeSkillFile: (name: string, path: string, content: string) =>
    call<Skill>('PUT', `/skills/${name}/file?path=${encodeURIComponent(path)}`, { content }),
  deleteSkillFile: (name: string, path: string) =>
    call<Skill>('DELETE', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
};
