import type { BackgroundTask } from '../../../shared/protocol.ts';

/** A parent prompt ending does not prove its ACP tools exited. */
export class AgyActivity {
  private tasks=new Map<string,BackgroundTask>();
  private last='';
  private emit:(tasks:BackgroundTask[])=>void;
  constructor(emit:(tasks:BackgroundTask[])=>void) {this.emit=emit;}
  private publish(){const tasks=[...this.tasks.values()],next=JSON.stringify(tasks);if(next!==this.last){this.last=next;this.emit(tasks);}}
  acpTool(update:any){
    const key='tool:'+update.toolCallId;
    if(update.status==='completed'||update.status==='failed') this.tasks.delete(key);
    else this.tasks.set(key,{id:key,type:'tool',description:String(update.title??update.name??'도구').slice(0,500)});
    this.publish();
  }
  parentResult(){
    for(const [id,task]of this.tasks)this.tasks.set(id,{...task,state:'unknown'});
    this.publish();
  }
  hasWork(){return this.tasks.size>0;}
  reset(){this.tasks.clear();this.publish();}
}
