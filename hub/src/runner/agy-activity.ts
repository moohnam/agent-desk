import type { BackgroundTask } from '../../../shared/protocol.ts';

/** Stream-json has spawn metadata but no complete /tasks snapshot. Never infer child exit from the parent's result. */
export class AgyActivity {
  private tasks=new Map<string,BackgroundTask>();
  private children=new Set<string>();
  private last='';
  private emit:(tasks:BackgroundTask[])=>void;
  constructor(emit:(tasks:BackgroundTask[])=>void) {this.emit=emit;}
  private publish(){const tasks=[...this.tasks.values()],next=JSON.stringify(tasks);if(next!==this.last){this.last=next;this.emit(tasks);}}
  step(step:any){
    const key=`step:${step.conversation_id??''}:${step.step_index}`;
    if(step.step_type==='tool'&&Number.isInteger(step.step_index)){
      if(step.state==='ACTIVE')this.tasks.set(key,{id:key,type:'tool',description:String(step.tool_name||'백그라운드 도구')});
      else if(step.state==='DONE'||step.state==='ERROR')this.tasks.delete(key);
    }
    for(const child of step.subagent_info?.subagents??[]){
      if(typeof child.conversation_id!=='string'||!child.conversation_id)continue;
      const id=child.conversation_id;this.children.add(id);
      // DONE here means the spawn call returned, not that its asynchronous child finished.
      this.tasks.set(`agent:${id}`,{id:`agent:${id}`,type:'local_agent',description:String(child.role||child.type_name||'서브 에이전트').slice(0,500),state:'unknown'});
    }
    this.publish();
  }
  childResult(id:string){
    if(!this.children.has(id))return false;
    this.children.delete(id);this.tasks.delete(`agent:${id}`);
    // Like the parent's result, a child's result does not prove its tools exited.
    for(const [key,task] of this.tasks)if(key.startsWith(`step:${id}:`))this.tasks.set(key,{...task,state:'unknown'});
    this.publish();return true;
  }
  parentResult(){
    for(const [id,task]of this.tasks)this.tasks.set(id,{...task,state:'unknown'});
    this.publish();
  }
  hasWork(){return this.tasks.size>0;}
  reset(){this.tasks.clear();this.children.clear();this.publish();}
}
