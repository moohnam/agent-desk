import assert from 'node:assert/strict';
import {test} from 'node:test';
import {subagentHistoryPosts} from '../../web/src/subagentHistory.ts';
import type {Subagent} from '../../shared/api.ts';
import type {HubEvent} from '../../web/src/types.ts';
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
