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

export function subagentHistoryPosts(agents: Subagent[], events: HubEvent[]) {
  const rows: {key:string; agent:Subagent; post:Post; summary:boolean}[]=[];
  const groups=new Map<string,HubEvent[]>();
  for(const event of events){
    const key=`${event.session_id}/${(event as HubEvent & {subagent_id:string}).subagent_id}`;
    const group=groups.get(key)??[];group.push(event);groups.set(key,group);
  }
  for(const [i,agent] of agents.entries()){
    const key=`${agent.session_id}/${agent.id}`;
    const native=withSubagentAnswers(groups.get(key)??[]);
    // A page may start at a tool call. Give it a card without borrowing another agent's post.
    const anchor:HubEvent={id:-(i*2+1),task_id:agent.task_id,session_id:agent.session_id,ts:native[0]?.ts??agent.created_at,
      kind:'assistant',payload:{text:'도구 기록'}};
    const stream=native.length && ['tool','tool_result'].includes(native[0].kind)?[anchor,...native]:native;
    for(const post of buildPosts(stream))rows.push({key:`${key}/${post.id}`,agent,post,summary:false});
    const repeated=native.some(e=>e.payload.text===agent.summary);
    const text=[!repeated && agent.summary,agent.detailNote,!agent.detailed && '상태 목록만 수신한 항목입니다. 상세 대화 기록은 제공되지 않았습니다.'].filter(Boolean).join('\n\n');
    const event:HubEvent={id:-(i*2+2),task_id:agent.task_id,session_id:agent.session_id,ts:agent.updated_at,kind:'assistant',payload:{text:text||'작업 상태가 기록됐습니다.'}};
    const post=buildPosts([event])[0];rows.push({key:`${key}/status`,agent,post,summary:true});
  }
  return rows.sort((a,b)=>Date.parse(b.post.event.ts)-Date.parse(a.post.event.ts)||b.post.id-a.post.id||a.key.localeCompare(b.key));
}
