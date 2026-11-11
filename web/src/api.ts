import { feedParams, type FeedFilter } from '../../shared/api.ts';
import type { AccessView, ChannelMessageInput, MessageReceipt } from '../../shared/api.ts';
import type { Channel, ChannelEntryPage, ChannelInput, ChannelTokenReceipt, DeskState, EngineUsage, HubEvent, HubMessage, Project, Settings, Skill, TaskView } from './types.ts';
import { workspaceId, SharedPending } from './workspace.ts';
import { composeSource, compareEvents, discoverSources, eventSourceIndex, getSources, mapEvent, mapState, mapTask, nativeEventId, scopeId, sourceBase, sourceConnected, sourceFilter, sourceIndex, splitId } from './federation.ts';

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, target?:string): Promise<T> {
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
    for(const key of ['before','since','ids']) {
      const value=url.searchParams.get(key);if(value)url.searchParams.set(key,value.split(',').map(v=>String(nativeEventId(Number(v)))).join(','));
    }
  }
  if(source&&route.startsWith('/channels/'))throw new Error('채널 대화는 같은 허브의 프로젝트를 선택하세요');
  path=url.pathname+url.search;
  // getRandomValues also works on phones using an HTTP LAN address (randomUUID requires HTTPS).
  const requestId = source && method !== 'GET' && route !== '/open' ? Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('') : undefined;
  const init:RequestInit = {
    method,
    headers: { ...(input ? { 'content-type': 'application/json' } : {}), ...(requestId ? {'x-desk-operation-id':requestId} : {}) },
    body: input ? JSON.stringify(input) : undefined,
    signal,
  };
  const send = ()=>fetch(`${sourceBase(source)}${path}`,init);
  const res = await send().catch(e=>{if(requestId&&!signal?.aborted)return send();throw e;});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  if (data.shared_pending) throw new SharedPending();
  if(!source)return data as T;
  const index=sourceIndex(source);
  if(route==='/compose'||route==='/tasks'&&method==='POST')return mapTask(source,index,data) as T;
  if(route==='/projects'&&method==='POST')return {...data,id:scopeId(source,data.id)} as T;
  if(route.endsWith('/events')) {
    if(Array.isArray(data))return data.map(e=>mapEvent(source,index,e)) as T;
    return {...data,events:data.events.map((e:HubEvent)=>mapEvent(source,index,e))} as T;
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
async function state():Promise<DeskState> {
  await discoverSources();
  const unavailableSources:string[]=[];
  const availableSources:string[]=[];
  const localUpdates:HubMessage[]=[];
  let localRefresh=refreshing.get('');if(!localRefresh)refreshing.set('',localRefresh=new Set());localRefresh.add(localUpdates);
  let local:DeskState;
  try {
    let response:Response;
    try {response=await fetch('/api/state');}
    catch {throw new LocalUnavailable();}
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      if(response.status>=500)throw new LocalUnavailable();
      throw new Error(data.error??`HTTP ${response.status}`);
    }
    local=data as DeskState;
    availableSources.push('');
    for(const update of localUpdates)applyMessage(local,update);
    snapshots.set('',local);
  }catch(error){
    if(!(error instanceof LocalUnavailable))throw error;
    unavailableSources.push('');
    const held=snapshots.get('');
    local=held?{...held,runner:{connected:false},tasks:held.tasks.map(t=>({...t,runner_connected:false}))}
      :{projects:[],tasks:[],approvals:[],questions:[],channels:[],runner:{connected:false}};
  }finally{localRefresh.delete(localUpdates);if(!localRefresh.size)refreshing.delete('');}
  const linked=await Promise.all(getSources().map(async source=>{
    const updates:HubMessage[]=[];
    let active=refreshing.get(source.id);if(!active)refreshing.set(source.id,active=new Set());active.add(updates);
    try {
      const r=await fetch(sourceBase(source.id)+'/state');if(!r.ok)throw Error('offline');
      const value=mapState(source.id,source.view_index,await r.json());
      availableSources.push(source.id);
      for(const update of updates)applyMessage(value,update);
      value.projects=value.projects.filter(p=>!removedProjects.has(p.id));
      snapshots.set(source.id,value);sourceConnected(source.id,true);return value;
    }catch {
      unavailableSources.push(source.id);sourceConnected(source.id,false);
      const held=snapshots.get(source.id);
      return held&&{...held,tasks:held.tasks.map(t=>({...t,runner_connected:false}))};
    }finally{active.delete(updates);if(!active.size)refreshing.delete(source.id);}
  }));
  for(const id of snapshots.keys())if(id&&!getSources().some(s=>s.id===id))snapshots.delete(id);
  const all=[local,...linked.filter((s):s is DeskState=>!!s)];
  const combined={...local,unavailableSources,availableSources,projects:all.flatMap(s=>s.projects).filter(p=>!removedProjects.has(p.id)),tasks:all.flatMap(s=>s.tasks),approvals:all.flatMap(s=>s.approvals),questions:all.flatMap(s=>s.questions)};
  projects=combined.projects;return combined;
}
async function feeds(limit:number,before:HubEvent|undefined,q:FeedQuery,signal?:AbortSignal) {
  await discoverSources();
  const all=[{id:'',view_index:0},...getSources()];
  const pages=await Promise.all(all.map(async source=>{
    const filter=sourceFilter(source.id,q);if(!filter)return [];
    const p=feedSearch(filter);p.set('limit',String(limit));
    // A stable timestamp + source index + native ID cursor prevents cross-store gaps/ties.
    p.set('before_ts',before?.ts??'9999-12-31T23:59:59.999Z');
    const index=before?eventSourceIndex(before.id):0;
    p.set('cursor_id',String(!before||source.view_index<index?Number.MAX_SAFE_INTEGER:source.view_index>index?0:nativeEventId(before.id)));
    try {
      const r=await fetch(sourceBase(source.id)+'/feed?'+p,{signal});
      if(!r.ok){if(!source.id&&!before&&r.status>=500)return [];throw Error('글을 불러오지 못했습니다');}
      return (await r.json() as HubEvent[]).map(e=>mapEvent(source.id,source.view_index,e));
    }catch(e){if(before||signal?.aborted)throw e;if(source.id||e instanceof TypeError)return [];throw e;}
  }));
  return pages.flat().sort(compareEvents).slice(-limit);
}
async function feedCount(q:FeedQuery,signal?:AbortSignal) {
  await discoverSources();
  const counts=await Promise.all([{id:''},...getSources()].map(async source=>{
    const filter=sourceFilter(source.id,q);if(!filter)return {posts:0,tasks:0};
    let r:Response;
    try {r=await fetch(sourceBase(source.id)+'/feed/count?'+feedSearch(filter),{signal});}
    catch(error){if(!source.id&&!signal?.aborted)return {posts:0,tasks:0};throw error;}
    if(!r.ok){if(!source.id&&r.status>=500)return {posts:0,tasks:0};throw Error('글 수를 불러오지 못했습니다');}
    return await r.json() as {posts:number;tasks:number};
  }));
  return counts.reduce((a,b)=>({posts:a.posts+b.posts,tasks:a.tasks+b.tasks}),{posts:0,tasks:0});
}

/** Events per feed page: a full page means older ones may exist. */
export const FEED_PAGE = 1000;

export const api = {
  remember,
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
  feed: (limit = FEED_PAGE, before?: HubEvent, q: FeedQuery = {}, signal?: AbortSignal) => feeds(limit,before,q,signal),
  feedCount,
  /**
   * A page of a task's history, oldest first: its newest events (below `before`, when given), and
   * every event from `since` on. `more`: older events exist before the page.
   */
  events: (taskId: string, at: { since?: number; before?: number; ids?: number[] } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (at.ids?.length) q.set('ids', at.ids.join(','));
    if (at.since) q.set('since', String(at.since));
    if (at.before) q.set('before', String(at.before));
    const qs = q.toString();
    // A hub not yet restarted answers with the bare array (newest 500, no paging).
    return call<{ events: HubEvent[]; more: boolean } | HubEvent[]>('GET', `/tasks/${taskId}/events${qs ? `?${qs}` : ''}`, undefined, signal)
      .then((r) => (Array.isArray(r) ? { events: r, more: false } : r));
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
  /** Has the hub download a web file (an image dragged in from a page); returns the saved path. */
  uploadUrl: (url: string) => call<{ path: string }>('POST', '/uploads', { url }),
  createProject: (name: string, root_path: string) => call<Project>('POST', '/projects', { name, root_path }),
  compose: (text: string, source?:string) => call<TaskView>('POST', '/compose', { text },undefined,composeSource(text,projects,source)),
  createTask: (project_id: string, title: string, prompt: string) =>
    call<TaskView>('POST', '/tasks', { project_id, title, prompt }),
  /** Returns the task that got the message: a new one for #new or #fork. */
  send: (taskId: string, text: string) => call<{ task_id: string } & MessageReceipt>('POST', `/tasks/${taskId}/messages`, { text }),
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
  /** Addresses (with QR codes) other devices open the desk at; only on the hub's own machine. */
  access: () => call<{ urls: { url: string; qr: string }[] } & AccessView>('GET', '/access'),
  answerAccess: (id: string, allow: boolean) => call<AccessView>('POST', `/access-requests/${id}`, { allow }),
  renameDevice: (id: string, name: string) => call<AccessView>('PATCH', `/devices/${id}`, { name }),
  removeDevice: (id: string) => call<AccessView>('DELETE', `/devices/${id}`),
  rotateAccessToken: () => call<{ ok: true }>('POST', '/access-token'),
  settings: (source='') => call<Settings>('GET', '/settings',undefined,undefined,source),
  /** Each engine's plan limits: used share and reset time per window. `refresh`: skip the hub's one-minute cache. */
  usage: (engine: string, refresh = false) => call<EngineUsage>('GET', `/usage?engine=${engine}${refresh ? '&refresh=1' : ''}`),
  /** Only the engines and keys given change; null clears one. */
  saveSettings: (s: { [E in keyof Settings]?: Partial<Settings[E]> }) => call<Settings>('PUT', '/settings', s),
  skills: (source='') => call<Skill[]>('GET', '/skills',undefined,undefined,source),
  createSkill: (name: string, description: string) => call<Skill>('POST', '/skills', { name, description }),
  deleteSkill: (name: string) => call('DELETE', `/skills/${name}`),
  readSkillFile: (name: string, path: string) =>
    call<{ path: string; content: string; executable: boolean }>('GET', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
  writeSkillFile: (name: string, path: string, content: string) =>
    call<Skill>('PUT', `/skills/${name}/file?path=${encodeURIComponent(path)}`, { content }),
  deleteSkillFile: (name: string, path: string) =>
    call<Skill>('DELETE', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
};
