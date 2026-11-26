// Only threads proven to descend from this runner's root are read. Native item IDs make
// live delivery and persisted history converge without duplicating the parent's transcript.
import type { RunnerToHub, SubagentEvent, SubagentInfo } from '../../../shared/protocol.ts';
type Json = any;
const text = (v: unknown) => typeof v === 'string' ? v : '';
const historyDone = (turn: Json, item: Json) => {
  if (typeof item.status === 'string') return ['completed','failed','declined'].includes(item.status);
  if (item.completedAtMs != null) return true;
  return ['agentMessage','plan'].includes(item.type) && ['completed','failed','interrupted'].includes(turn.status);
};
const clip = (s: string) => s.length > 64000 ? s.slice(0,64000) + '\n…(truncated)' : s;
export class CodexSubagents {
  private known = new Map<string, SubagentInfo>();
  private seen = new Set<string>();
  private pending = new Map<string, Promise<boolean>>();
  private closed = false;
  private retries=new Map<string,ReturnType<typeof setTimeout>>();
  private hydrating=new Map<string,{events:{method:string,p:Json,root:string}[];bytes:number;overflow:boolean}>();
  private versions=new Map<string,number>();
  private recoveredVersion=new Map<string,unknown>();
  private sessionId: string;
  private request: (method: string, p: Json) => Promise<Json>;
  private emit: (m: RunnerToHub) => void;
  constructor(sessionId: string, request: (method: string, p: Json) => Promise<Json>, emit: (m: RunnerToHub) => void) {this.sessionId=sessionId;this.request=request;this.emit=emit;}
  stop() { this.closed = true; for(const timer of this.retries.values())clearTimeout(timer);this.retries.clear();this.hydrating.clear(); }
  private report(info: SubagentInfo) {
    if (this.closed) return;
    if (JSON.stringify(this.known.get(info.id)) === JSON.stringify(info)) return;
    this.known.set(info.id, info); this.emit({ type:'subagent', sessionId:this.sessionId, subagent:info });
  }
  private step(id: string, sourceId: string, e: SubagentEvent) {
    if (this.closed || this.seen.has(id+'/'+sourceId)) return;
    this.seen.add(id+'/'+sourceId);
    const event = e.kind==='tool' ? {...e,input:JSON.stringify(e.input??null).length>64000?{truncated:clip(JSON.stringify(e.input))}:e.input} : {...e,text:clip(e.text)};
    this.emit({ type:'subagent_event', sessionId:this.sessionId, subagentId:id, event:{...event,sourceId} });
  }
  discover(t: Json, root: string) {
    if (typeof t.id !== 'string' || t.id === root) return;
    const id='agent:'+t.id, old=this.known.get(id);
    this.report({ ...old,id,type:'local_agent',description:t.agentNickname||t.agentRole||old?.description||'서브 에이전트',
      parentId:t.parentThreadId && t.parentThreadId!==root?'agent:'+t.parentThreadId:old?.parentId,
      background:true,status:t.status?.type==='active'?'running':old?.status==='running'?'ended':old?.status??'ended',
      detailNote:old ? old.detailNote : 'Codex 하위 스레드에 저장된 기록을 조회 중입니다.' });
    if (!old || !this.recoveredVersion.has(t.id) || (t.updatedAt !== undefined && this.recoveredVersion.get(t.id)!==t.updatedAt)) {
      if(!this.pending.has(t.id))void this.recover(t.id).then(ok=>{if(ok)this.recoveredVersion.set(t.id,t.updatedAt);});
    }
  }
  recover(threadId: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const existing=this.pending.get(threadId);if(existing)return existing;
    const id='agent:'+threadId;
    const version=this.versions.get(threadId)??0;
    clearTimeout(this.retries.get(threadId));this.retries.delete(threadId);
    if(!this.hydrating.has(threadId))this.hydrating.set(threadId,{events:[],bytes:0,overflow:false});
    let succeeded=false;
    const work=(async()=>{
      try {
        let r;
        try {
          r=await this.request('thread/read',{threadId,includeTurns:false});
          if(r.thread?.id!==threadId)throw Error('하위 스레드 응답 불일치');
          const turns:Json[]=[],cursors=new Set<string>();let cursor:string|null=null;
          do {
            if(this.closed)return false;
            const page=await this.request('thread/turns/list',{threadId,cursor,limit:100,sortDirection:'asc',itemsView:'full'});
            if(!Array.isArray(page.data))throw Error('턴 목록 응답 오류');
            turns.push(...page.data);
            for(const turn of page.data)for(const item of turn.items??[])this.item(threadId,turn.id,item,historyDone(turn,item));
            cursor=page.nextCursor??null;
            if(cursor){if(cursors.has(cursor)||cursors.size>=100)throw Error('턴 페이지 상한');cursors.add(cursor);}
          }while(cursor);
          r={thread:{...r.thread,turns}};
        } catch (error) {
          if(!/unsupported|unknown method|method not found|not implemented/i.test(String(error)))throw error;
          // Older app-servers expose only the full read. Unsupported history stays explicitly partial.
          r=await this.request('thread/read',{threadId,includeTurns:true});
        }
        if(this.closed)return false;
        if(r.thread?.id!==threadId || !Array.isArray(r.thread.turns))throw Error('기록 응답을 확인할 수 없습니다');
        for(const turn of r.thread.turns) {
          for(const item of turn.items??[]) this.item(threadId,turn.id,item,
            historyDone(turn,item));
        }
        const last=r.thread.turns.at(-1);
        const old=this.known.get(id);if(!old)return false;
        const partial=r.thread.turns.some((t:Json)=>t.itemsView && t.itemsView!=='full');
        this.report({...old,status:(this.versions.get(threadId)??0)!==version?old.status:r.thread.status?.type==='active'?'running':last?.status==='failed'?'failed':last?.status==='interrupted'?'stopped':last?.status==='completed'?'completed':old.status,
          detailNote:partial?'Codex가 반환한 기록은 일부입니다. 제공되지 않은 이전 항목은 복구하지 못했습니다.':r.thread.turns.length?undefined:'Codex에 저장된 하위 스레드 기록이 없습니다. 이후 수신한 기록부터 표시합니다.'});
        succeeded=true;return true;
      } catch {
        this.recoveredVersion.delete(threadId);
        const old=this.known.get(id);if(old)this.report({...old,detailNote:'Codex가 하위 스레드 과거 기록을 제공하지 못했습니다. 기록 순서를 복구하는 동안 실시간 상세 기록을 보관하고 재시도합니다.'});
        return false;
      }
    })().finally(()=>{
      this.pending.delete(threadId);
      if(this.closed)return;
      if(!succeeded){
        const timer=setTimeout(()=>{void this.recover(threadId);},5000);timer.unref();this.retries.set(threadId,timer);return;
      }
      const queued=this.hydrating.get(threadId);this.hydrating.delete(threadId);
      for(const event of queued?.events??[])this.notification(event.method,event.p,event.root);
      if(queued?.overflow){const old=this.known.get(id);if(old)this.report({...old,detailNote:'과거 기록 조회 중 실시간 기록이 보관 상한을 넘었습니다. 엔진이 저장한 기록 외 일부 실시간 내용은 누락될 수 있습니다.'});}
    });
    this.pending.set(threadId,work);return work;
  }
  item(threadId: string, turnId: string, item: Json, done: boolean) {
    const id='agent:'+threadId;if(!this.known.has(id)||typeof item?.id!=='string'||typeof turnId!=='string')return;
    const key=turnId+'/'+item.id, step=(suffix:string,e:SubagentEvent)=>this.step(id,key+'/'+suffix,e);
    if(item.type==='userMessage') {
      const content=(item.content??[]).filter((c:Json)=>c.type==='text'&&typeof c.text==='string').map((c:Json)=>c.text).join('\n');
      if(content)step('text',{kind:'user',text:content});
    } else if(item.type==='agentMessage'&&done&&text(item.text))step('text',{kind:'assistant',text:item.text});
    else if(item.type==='plan'&&done&&text(item.text))step('text',{kind:'assistant',text:item.text});
    else {
      const name=item.type==='commandExecution'?'Bash':item.type==='fileChange'?'Edit':item.type==='mcpToolCall'?`mcp__${item.server}__${item.tool}`:item.type==='dynamicToolCall'?item.tool:item.type==='webSearch'?'WebSearch':item.type==='imageView'?'ViewImage':undefined;
      if(!name)return;
      const input=item.type==='commandExecution'?{command:item.command,cwd:item.cwd}:item.type==='imageView'?{path:item.path}:item.arguments??item.changes??{query:item.query};
      step('call',{kind:'tool',toolUseId:key,name,input});
      if(done && item.type!=='imageView')step('result',{kind:'tool_result',toolUseId:key,isError:['failed','declined'].includes(item.status)||item.success===false||!!item.error||(item.exitCode??0)!==0,
        text:text(item.aggregatedOutput)||text(item.error?.message)||JSON.stringify(item.result??item.contentItems??item.changes??'')});
    }
  }
  notification(method: string,p: Json,root: string) {
    if(method==='thread/started')return;
    if(!this.known.has('agent:'+p.threadId)||p.threadId===root)return;
    this.versions.set(p.threadId,(this.versions.get(p.threadId)??0)+1);
    if(method==='item/started'||method==='item/completed'){
    const queued=this.hydrating.get(p.threadId);
    if(queued){
      const bytes=JSON.stringify(p).length;
      if(queued.events.length<128&&queued.bytes+bytes<=512*1024){queued.events.push({method,p,root});queued.bytes+=bytes;}else queued.overflow=true;
      return;
    }
      this.item(p.threadId,p.turnId,p.item,method==='item/completed');
    }
    if(method==='thread/status/changed' && p.status?.type==='active')this.report({...this.known.get('agent:'+p.threadId)!,status:'running',summary:undefined});
    if(method==='thread/closed')this.report({...this.known.get('agent:'+p.threadId)!,status:'stopped'});
    if(method==='turn/started')this.report({...this.known.get('agent:'+p.threadId)!,status:'running',summary:undefined});
    if(method==='turn/completed'){
      this.report({...this.known.get('agent:'+p.threadId)!,status:p.turn?.status==='failed'?'failed':p.turn?.status==='interrupted'?'stopped':p.turn?.status==='completed'?'completed':'ended'});
      const pending=this.pending.get(p.threadId);if(pending)void pending.then(()=>this.recover(p.threadId));else void this.recover(p.threadId);
    }
  }
}
