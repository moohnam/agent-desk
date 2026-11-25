import type { BackgroundTask } from '../../../shared/protocol.ts';

type Json = any;
type Request = (method:string, params:Json) => Promise<Json>;

/** Native snapshots reconcile edge notifications; a finished parent does not finish its children. */
export class CodexActivity {
  private root = '';
  private tasks = new Map<string, BackgroundTask>();
  private owners = new Set<string>();
  private timer?: NodeJS.Timeout;
  private pending = false;
  private again = false;
  private closed = false;
  private revision = 0;
  private failures = 0;
  private last = '';
  private request:Request;
  private emit:(tasks:BackgroundTask[])=>void;
  private interval:number;
  private onChild?: (thread:Json, root:string)=>void;
  constructor(request:Request, emit:(tasks:BackgroundTask[])=>void, interval=5000, onChild?: (thread:Json, root:string)=>void) {this.request=request;this.emit=emit;this.interval=interval;this.onChild=onChild;}

  start(root:string) { this.root=root; this.refresh(); }
  stop() { this.closed=true; clearTimeout(this.timer); this.tasks.clear(); this.owners.clear(); }
  private publish() {
    if(this.closed)return;
    const tasks=[...this.tasks.values()], next=JSON.stringify(tasks);
    if(next!==this.last){this.last=next;this.emit(tasks);}
  }
  private active(id:string, description:string, type='local_agent') {
    this.tasks.set(id,{id,type,description:description.slice(0,500),...(type==='shell'?{backgroundEvidence:'native' as const}:{})});
  }
  notification(method:string,p:Json) {
    if(this.closed||!this.root)return;
    const owned=(id:string)=>id===this.root||this.owners.has(id);
    if(method==='thread/started'){
      const t=p.thread;
      const parent=t?.parentThreadId??t?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if(t?.id&&owned(parent)){this.owners.add(t.id);this.onChild?.(t,this.root);if(t.status?.type==='active')this.active(`agent:${t.id}`,t.agentNickname||t.agentRole||'서브 에이전트');}
      else return;
    }else if(!owned(p.threadId))return;
    else if(method==='thread/status/changed'&&p.threadId!==this.root){
      if(p.status?.type==='active')this.active(`agent:${p.threadId}`,'서브 에이전트');
      else this.tasks.delete(`agent:${p.threadId}`);
    }else if(method==='thread/closed'){
      this.tasks.delete(`agent:${p.threadId}`);this.owners.delete(p.threadId);
      for(const key of this.tasks.keys())if(key.startsWith(`command:${p.threadId}:`))this.tasks.delete(key);
    }
    else if(method==='item/started'||method==='item/completed'){
      const item=p.item;
      if(item?.type==='collabAgentToolCall'){
        for(const id of item.receiverThreadIds??[]){
          if(typeof id!=='string'||id===this.root)continue;
          if(item.tool==='spawnAgent'){this.owners.add(id);this.onChild?.({id,parentThreadId:p.threadId,status:{type:'active'}},this.root);}
          else if(!this.owners.has(id))continue;
          const status=item.agentsStates?.[id]?.status;
          if(status==='running'||status==='pendingInit')this.active(`agent:${id}`,'서브 에이전트');
          else if(status)this.tasks.delete(`agent:${id}`);
          else if(['spawnAgent','sendInput','resumeAgent','followupTask'].includes(item.tool))this.active(`agent:${id}`,'서브 에이전트');
        }
      }else if(item?.type==='subAgentActivity'&&item.agentThreadId){
        if(item.agentThreadId===this.root)return;
        if(item.kind==='started'){this.owners.add(item.agentThreadId);this.onChild?.({id:item.agentThreadId,parentThreadId:p.threadId,status:{type:'active'}},this.root);}
        else if(!this.owners.has(item.agentThreadId))return;
        if(item.kind==='started'||item.kind==='interacted')this.active(`agent:${item.agentThreadId}`,item.agentPath||'서브 에이전트');
        else this.tasks.delete(`agent:${item.agentThreadId}`);
      }else if(item?.type==='commandExecution'){
        const id=`command:${p.threadId}:${item.processId??item.id}`;
        if(item.processId&&item.status==='completed'&&item.exitCode==null)this.active(id,item.command||'백그라운드 명령','shell');
        else if(item.status==='inProgress')this.active(id,item.command||'실행 중인 도구','tool');
        else this.tasks.delete(id);
      }else return;
    }else if(method!=='turn/completed')return;
    this.revision++;
    const needsInventory=!this.tasks.size;
    if(needsInventory)this.tasks.set('checking',{id:'checking',type:'status',description:'백그라운드 작업 상태 확인 중',state:'unknown'});
    this.publish();
    if(needsInventory||method==='turn/completed')this.refresh();
    else if(!this.timer&&!this.pending){this.timer=setTimeout(()=>this.refresh(),this.interval);this.timer.unref();}
  }

  private async pages(method:string,params:Json):Promise<Json[]> {
    const rows:Json[]=[],seen=new Set<string>();let cursor:string|null=null;
    do{
      if(this.closed)throw Error('closed');
      const result=await this.request(method,{...params,cursor,limit:100});
      if(!Array.isArray(result?.data))throw Error('활동 목록 응답 오류');
      rows.push(...result.data);cursor=result.nextCursor??null;
      if(cursor){if(seen.has(cursor)||seen.size>=100)throw Error('활동 목록 페이지 오류');seen.add(cursor);}
    }while(cursor);
    return rows;
  }
  refresh() {
    if(this.closed||!this.root)return;
    if(this.pending){this.again=true;return;}
    clearTimeout(this.timer);this.timer=undefined;this.pending=true;
    const revision=this.revision;
    // This sentinel also prevents an idle reaper/update racing the first snapshot.
    if(!this.tasks.size)this.tasks.set('checking',{id:'checking',type:'status',description:'백그라운드 작업 상태 확인 중',state:'unknown'});
    this.publish();
    void (async()=>{
      const children=await this.pages('thread/list',{ancestorThreadId:this.root,sourceKinds:['subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther'],useStateDbOnly:true});
      // Ephemeral descendants may not be in persisted listings. Read known children too.
      const listed=new Set(children.map(t=>t.id));
      for(const id of this.owners)if(!listed.has(id)){
        const result=await this.request('thread/read',{threadId:id,includeTurns:false});
        if(!result?.thread)throw Error('하위 스레드 조회 실패');
        children.push(result.thread);
      }
      const owners=new Set<string>();const next=new Map<string,BackgroundTask>();
      for(const t of children){
        if(typeof t.id!=='string')throw Error('하위 스레드 응답 오류');
        if(!['active','idle','notLoaded','systemError'].includes(t.status?.type))throw Error('하위 스레드 상태 응답 오류');
        if(t.status.type==='notLoaded')continue;
        owners.add(t.id);
        if(t.status?.type==='active')next.set(`agent:${t.id}`,{id:`agent:${t.id}`,type:'local_agent',description:t.agentNickname||t.agentRole||'서브 에이전트'});
      }
      for(const id of [this.root,...owners]){
        const terminals=await this.pages('thread/backgroundTerminals/list',{threadId:id});
        for(const t of terminals){
          if(typeof t.processId!=='string')throw Error('백그라운드 명령 응답 오류');
          const key=`command:${id}:${t.processId}`;
          next.set(key,{id:key,type:'shell',backgroundEvidence:'native',description:String(t.command||'백그라운드 명령').slice(0,500)});
        }
      }
      if(this.closed)return;
      // A response captured before a live event must never erase the newer work.
      if(revision!==this.revision){this.again=true;return;}
      for(const t of children)this.onChild?.(t,this.root);
      this.tasks=next;this.owners=owners;this.failures=0;
    })().catch(()=>{
      this.failures=Math.min(this.failures+1,4);
      if(!this.closed)this.tasks.set('checking',{id:'checking',type:'status',description:'백그라운드 작업 상태를 확인하지 못했습니다',state:'unknown'});
    }).finally(()=>{
      this.pending=false;if(this.closed)return;this.publish();
      const delay=Math.min(60000,this.interval*2**this.failures);
      if(this.again){this.again=false;this.timer=setTimeout(()=>this.refresh(),delay);}
      else if(this.tasks.size)this.timer=setTimeout(()=>this.refresh(),delay);
      this.timer?.unref();
    });
  }
}
