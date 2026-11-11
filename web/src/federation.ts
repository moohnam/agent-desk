import { parseCompose } from '../../shared/compose.ts';
import type { DeskState, HubEvent, HubMessage, TaskView } from './types.ts';
import type { FeedFilter } from '../../shared/api.ts';
import type { SharedWorkspaceView } from '../../shared/workspace.ts';
import { EVENT_BLOCK, legacyIds, legacySourceId as resolveLegacySourceId, migrateLegacyStorage } from './legacyMigration.ts';

// Persisted, never reused source indices keep existing local event IDs/preferences intact.
export { EVENT_BLOCK } from './legacyMigration.ts';
export const scopeId = (source: string, id: string) => source ? `w:${source}:${id}` : id;
export function splitId(id: string): [string, string] {
  const m = /^w:([a-zA-Z0-9-]+):(.+)$/.exec(id);
  return m ? [m[1], m[2]] : ['', id];
}
export const sourceBase = (source: string) => source ? `/api/workspaces/${encodeURIComponent(source)}` : '/api';
export function eventId(index: number, id: number) {
  const result = index * EVENT_BLOCK + id;
  if (!Number.isSafeInteger(result) || index < 0 || id < 1 || id >= EVENT_BLOCK) throw new Error('글 식별자 범위를 초과했습니다');
  return result;
}
export const nativeEventId = (id: number) => id % EVENT_BLOCK;
export const eventSourceIndex = (id: number) => Math.floor(id / EVENT_BLOCK);
export function compareEvents(a: Pick<HubEvent,'ts'|'id'>, b: Pick<HubEvent,'ts'|'id'>) {
  return a.ts.localeCompare(b.ts) || a.id - b.id;
}
export function mapEvent(source: string, index: number, e: HubEvent): HubEvent {
  if (!source) return e;
  const payload = e.payload && {...e.payload};
  if (payload) {
    for (const k of ['approvalId','questionId','requestId']) if (typeof payload[k] === 'string') payload[k] = scopeId(source,payload[k]);
    if (typeof payload.answers === 'string') payload.answers = scopeId(source,payload.answers);
  }
  return {...e,id:eventId(index,e.id),task_id:scopeId(source,e.task_id),session_id:scopeId(source,e.session_id),payload};
}
export function mapTask(source: string, index: number, t: TaskView): TaskView {
  if (!source) return t;
  return {...t,id:scopeId(source,t.id),project_id:scopeId(source,t.project_id),runner_id:t.runner_id && scopeId(source,t.runner_id),
    last_event:t.last_event && mapEvent(source,index,t.last_event),pending_ask:t.pending_ask && {...t.pending_ask,event_id:eventId(index,t.pending_ask.event_id)},
    queued:t.queued.map(q=>({...q,id:scopeId(source,q.id)}))};
}
function mapRequest<T extends {id:string;task_id:string;session_id:string}>(source:string,r:T):T {
  return {...r,id:scopeId(source,r.id),task_id:scopeId(source,r.task_id),session_id:scopeId(source,r.session_id)};
}
export function mapState(source:string,index:number,s:DeskState):DeskState {
  if (!source) return s;
  return {...s,projects:s.projects.map(p=>({...p,id:scopeId(source,p.id)})),tasks:s.tasks.map(t=>mapTask(source,index,t)),
    approvals:s.approvals.map(a=>mapRequest(source,a)),questions:s.questions.map(q=>mapRequest(source,q))};
}
export function mapMessage(source:string,index:number,m:HubMessage):HubMessage|null {
  if (!source) return m;
  switch(m.type) {
    case 'event': return {...m,event:mapEvent(source,index,m.event)};
    case 'task': return {...m,task:mapTask(source,index,m.task)};
    case 'approval': return {...m,approval:mapRequest(source,m.approval)};
    case 'question': return {...m,question:mapRequest(source,m.question)};
    case 'runners': return {...m,runners:m.runners.map(r=>({...r,id:scopeId(source,r.id)}))};
    case 'removed': return {...m,taskIds:m.taskIds.map(id=>scopeId(source,id)),projectIds:m.projectIds.map(id=>scopeId(source,id))};
    default: return null; // Access and local-runner state belong to the gateway only.
  }
}
export function sourceFilter(source:string,q:FeedFilter):FeedFilter|null {
  const out={...q};
  for (const k of ['taskIds','projectIds'] as const) if(q[k]) {
    out[k]=q[k].filter(id=>splitId(id)[0]===source).map(id=>splitId(id)[1]);
    if (!out[k]!.length) return null;
  }
  return out;
}
export interface Source extends SharedWorkspaceView { connected?:boolean }
let sources:Source[]=[];
export const legacyTaskId=(id:string)=>{const ids=legacyIds(sources);return ids.scoped(id,ids.tasks);};
export const legacySourceId=(id:string)=>resolveLegacySourceId(id,sources);
const listeners=new Set<()=>void>();
export const getSources=()=>sources;
export const subscribeSources=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
function publish(next:Source[]) { if(JSON.stringify(next)!==JSON.stringify(sources)){sources=next;listeners.forEach(f=>f());} }
export const sourceIndex=(source:string)=>{
  if(!source)return 0;
  const index=sources.find(s=>s.id===source)?.view_index;
  if(!index)throw new Error('공유 작업공간 연결을 확인하지 못했습니다');
  return index;
};
export function sourceConnected(source:string,connected:boolean) {publish(sources.map(s=>s.id===source?{...s,connected}:s));}
let discovering:Promise<void>|undefined;
let discoveredAt=0;
export async function discoverSources(force=false) {
  if(discovering)return discovering;
  if(!force && Date.now()-discoveredAt<3000)return;
  discovering=(async()=>{
    const r=await fetch('/api/workspaces');if(!r.ok)throw new Error('공유 러너 목록을 불러오지 못했습니다');
    const next=await r.json() as Source[];
    if(typeof localStorage!=='undefined'&&next.some(s=>s.legacy_project_ids?.length||s.legacy_task_ids?.length
      ||s.legacy_approval_ids?.length||s.legacy_question_ids?.length||s.legacy_runner_ids?.length)) {
      if(typeof window!=='undefined'&&!window.dispatchEvent(new Event('desk-before-legacy-migration',{cancelable:true})))
        throw new Error('저장 중인 초안을 보존하려고 작업공간 전환을 기다립니다');
      if(migrateLegacyStorage(localStorage,next) && typeof window!=='undefined')window.dispatchEvent(new Event('desk-legacy-migrated'));
    }
    publish(next.map(s=>({...s,connected:sources.find(p=>p.id===s.id)?.connected})));
    discoveredAt=Date.now();
  })().finally(()=>{discovering=undefined;});
  return discovering;
}
export function composeSource(text:string,projects:DeskState['projects'],chosen?:string):string {
  if(chosen!==undefined)return chosen;
  const name=parseCompose(text).mention?.name.toLowerCase();
  const matches=projects.filter(p=>p.name.toLowerCase()===name);
  const candidates=[...new Set(matches.map(p=>splitId(p.id)[0]))];
  if(candidates.length>1)throw new Error('같은 이름의 프로젝트가 여러 작업공간에 있습니다. 새 지시의 실행 대상을 선택하세요');
  return candidates[0]??'';
}
