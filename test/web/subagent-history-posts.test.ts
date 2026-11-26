import assert from 'node:assert/strict';
import {test} from 'node:test';
import {subagentHistoryPosts} from '../../web/src/subagentHistory.ts';
import type {Subagent} from '../../shared/api.ts';
import type {HubEvent} from '../../web/src/types.ts';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {subagentTracker} from '../../hub/src/runner/claude.ts';
import {Store, type Session} from '../../hub/src/db.ts';
import {Subagents} from '../../hub/src/subagents.ts';
test('common history preserves source attribution and orphan tools in chronological feed cards',()=>{
 const agents=['a','b'].map(id=>({id,session_id:'s',task_id:'t',type:'agent',status:'completed',description:id,detailed:true,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:10Z'})) as Subagent[];
 const e=(id:number,subagent_id:string,kind:string,payload:any)=>({id,subagent_id,session_id:'s',task_id:'t',kind,payload,ts:`2026-01-01T00:00:0${id}Z`}) as HubEvent;
 const rows=subagentHistoryPosts(agents,[e(1,'a','tool',{name:'Read',toolUseId:'x'}),e(2,'b','assistant',{text:'B answer'}),e(3,'a','tool_result',{toolUseId:'x',text:'A tool output'})]);
 const tool=rows.find(r=>r.agent.id==='a'&&!r.summary)!;
 assert.deepEqual(tool.post.activity.map(e=>e.id),[1,3]);
 assert.equal(rows.find(r=>r.agent.id==='b'&&!r.summary)!.post.activity.length,0);
 assert.deepEqual(rows.map(r=>r.post.event.ts),rows.map(r=>r.post.event.ts).sort().reverse());
 assert.equal(rows.filter(r=>r.summary).length,2);
});


test('Claude tracker long handback suppresses only its duplicate clipped history summary',()=>{
 const store=new Store(':memory:');
 store.database.exec('PRAGMA foreign_keys=OFF');
 try {
  const subagents=new Subagents(store,()=>{}), session={id:'s',task_id:'t'} as Session;
  const track=subagentTracker('s',message=>{
   if(message.type==='subagent')subagents.report(session,message.subagent);
   if(message.type==='subagent_event')subagents.event(session,message.subagentId,message.event);
  });
  const sdk=(message:Record<string,unknown>)=>message as unknown as SDKMessage;
  const text='긴 답변 시작 '+'가'.repeat(9000)+' 끝';
  track(sdk({type:'system',subtype:'task_started',task_id:'a',tool_use_id:'call',description:'조사',task_type:'local_agent'}));
  track(sdk({type:'assistant',parent_tool_use_id:'call',message:{content:[{type:'tool_use',id:'h',name:'SubagentHandback',input:{message:text}}]}}));
  track(sdk({type:'system',subtype:'task_notification',task_id:'a',status:'completed',summary:'delivered',output_file:''}));
  const agents=subagents.list('t'), events=subagents.history('t').events as HubEvent[];
  assert.equal(text.length,9010);
  assert.equal(agents[0].summary,text.slice(0,4000)+'\n…(truncated)','exercise the real tracker summary clipping contract');
  const rows=subagentHistoryPosts(agents,events);
  assert.equal(rows.filter(row=>row.post.event.payload.text?.startsWith('긴 답변 시작')).length,1,'only the complete answer is shown');
  assert.equal(rows.find(row=>!row.summary)!.post.event.payload.text,text);
  assert.equal(rows.find(row=>row.summary)!.post.event.payload.text,'작업 상태가 기록됐습니다.');
  assert.equal(subagentHistoryPosts(agents,[]).find(row=>row.summary)!.post.event.payload.text,agents[0].summary,'a page without the original answer keeps the summary');
  for(const summary of ['검증 실패로 종료했습니다.',text.slice(0,4000),text.slice(0,4000)+'\n별도 종료 사유']){
   const independent=agents.map(agent=>({...agent,status:'failed' as const,summary}));
   assert.equal(subagentHistoryPosts(independent,events).find(row=>row.summary)!.post.event.payload.text,summary,'independent completion reasons and unmarked prefixes are retained');
  }
  const note='상세 기록 복구 안내';
  const withNote=agents.map(agent=>({...agent,detailNote:note}));
  assert.equal(subagentHistoryPosts(withNote,events).find(row=>row.summary)!.post.event.payload.text,note,'deduplication preserves independent detail notes');
 } finally {store.database.close();}
});
