import type { Subagent } from '../../shared/api.ts';
import type { HubEvent, Post } from './types.ts';
import { buildPosts } from './posts.ts';

export function withSubagentAnswers(events: HubEvent[]): HubEvent[] {
  const calls = new Set<string>();
  return events.flatMap(e => {
    if (e.kind === 'tool' && e.payload.name === 'SubagentHandback' && typeof e.payload.input?.message === 'string') {
      calls.add(e.payload.toolUseId);
      return [{ ...e, kind: 'assistant', payload: { text: e.payload.input.message, handback: true, clipped: e.payload.clipped } }];
    }
    return e.kind === 'tool_result' && calls.has(e.payload.toolUseId) ? [] : [e];
  });
}

/** A page may start in the middle of a run of tool calls. Keep those steps on a readable card. */
export function subagentPosts(events: HubEvent[], agent: Subagent, anchorId = -1) {
  const first = events[0];
  if (!first || !['tool','tool_result'].includes(first.kind)) return buildPosts(events);
  const anchor: HubEvent = {id:anchorId, task_id:agent.task_id, session_id:agent.session_id,
    ts:first.ts, kind:'assistant', payload:{text:'도구 기록'}};
  return buildPosts([anchor,...events]);
}

export function subagentHistoryPosts(agents: Subagent[], events: HubEvent[], complete: boolean | string = false) {
  const rows: {key:string; agent:Subagent; post:Post; summary:boolean; showStatus:boolean}[]=[];
  const groups=new Map<string,HubEvent[]>();
  for(const event of events){
    const key=`${event.session_id}/${(event as HubEvent & {subagent_id:string}).subagent_id}`;
    const group=groups.get(key)??[];group.push(event);groups.set(key,group);
  }
  for(const [i,agent] of agents.entries()){
    const key=`${agent.session_id}/${agent.id}`;
    const native=withSubagentAnswers(groups.get(key)??[]);
    const posts=subagentPosts(native,agent,-(i*2+1));
    // Claude's tracker stores clipResult(fullAnswer): 4000 UTF-16 units plus this exact suffix.
    // Match that format, not an arbitrary prefix, so independent completion reasons stay visible.
    const repeated=native.some(e=>{
      const text=e.payload.text;
      return typeof text==='string' && (text===agent.summary ||
        text.length>4000 && text.slice(0,4000)+'\n…(truncated)'===agent.summary);
    });
    const text=[!repeated && agent.summary,agent.detailNote,!agent.detailed && '상태 목록만 수신한 항목입니다. 상세 대화 기록은 제공되지 않았습니다.'].filter(Boolean).join('\n\n');
    for(const post of posts)rows.push({key:`${key}/${post.id}`,agent,post,summary:false,showStatus:!text && post===posts.at(-1)});
    const statusOnly=!posts.length && (complete===true || complete===key || agent.status==='failed' || agent.status==='stopped');
    if(!text && !statusOnly)continue;
    const event:HubEvent={id:-(i*2+2),task_id:agent.task_id,session_id:agent.session_id,ts:agent.updated_at,kind:'assistant',payload:{text:text || (agent.status==='failed'?'작업 실패':agent.status==='stopped'?'작업 중지':'기록된 대화가 없습니다.')}};
    const post=buildPosts([event])[0];rows.push({key:`${key}/status`,agent,post,summary:true,showStatus:true});
  }
  return rows.sort((a,b)=>Date.parse(b.post.event.ts)-Date.parse(a.post.event.ts)||b.post.id-a.post.id||a.key.localeCompare(b.key));
}
