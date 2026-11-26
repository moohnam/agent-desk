// ACP 1.5 reports the spawn tool, but omits its child ID and idle notification.
// Reconcile with agy's own per-session records. Missing records leave work unknown.
import { readdirSync, readFileSync, openSync, closeSync, fstatSync, constants, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundTask } from '../../../shared/protocol.ts';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
function files(dir: string) {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json') && uuid.test(f.slice(0,-5)))
      .flatMap(file=>{try{const st=lstatSync(join(dir,file),{bigint:true});return st.isFile()?[{file,at:st.mtimeNs}]:[];}catch{return [];}})
      .sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.file.localeCompare(b.file)).map(x=>x.file);
  }
  catch { return []; }
}
function record(dir: string, file: string) {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir,file),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st=fstatSync(fd);
    if(!st.isFile() || st.size>1024*1024) return undefined;
    return JSON.parse(readFileSync(fd,'utf8'));
  } catch { return undefined; } finally { if(fd!==undefined) closeSync(fd); }
}

export class AgyChildren {
  private waiting = new Map<string,BackgroundTask>();
  private running = new Map<string,BackgroundTask>();
  private seenChildren = new Set<string>();
  private seenMessages = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private dir?: string;
  private emit: (tasks:BackgroundTask[])=>void;
  private brain: string;
  private details?: { discover(child:any, existing:boolean):void; idle(child:string,file:string,response:string):void };
  private owned = new Set<string>();
  private watching = new Set<string>();
  constructor(emit:(tasks:BackgroundTask[])=>void, brain=join(homedir(),'.gemini','antigravity-cli','brain'), details?: { discover(child:any,existing:boolean):void; idle(child:string,file:string,response:string):void }) {
    this.emit=emit;
    this.brain=brain;this.details=details;
  }
  beforePrompt(session:string) {
    if(!uuid.test(session)) return;
    const dir=join(this.brain,session,'.system_generated');
    if(this.dir && this.dir!==dir){this.waiting.clear();this.running.clear();this.stop();}
    this.dir=dir;
    // Parent input is also a recovery boundary for children that answered without tool events.
    // Keep the seen sets for the same session so unchanged history does not emit again.
    this.refresh(true,true);
  }
  observe(update:any) {
    if(update.name!=='invoke_subagent') return;
    const key=update.toolCallId;
    if(update.status==='failed') { this.waiting.delete(key); this.publish(); return; }
    if(update.sessionUpdate!=='tool_call' || this.waiting.has(key)) return;
    if(!this.timer && this.dir) {
      this.timer=setInterval(()=>this.refresh(),1500);
      this.timer.unref();
    }
    this.waiting.set(key,{id:'spawn:'+key,type:'local_agent',description:String(update.rawInput?.Role??'agy 서브 에이전트'),state:'unknown'});
    this.publish();
  }
  belongs(session:string){if(!this.owned.has(session))this.refresh();return this.owned.has(session);}
  observeUpdate(session:string,u:any){
    this.watch(session);
    if(u?.sessionUpdate==='tool_call' && u.status!=='completed' && u.status!=='failed')this.active(session);
  }
  watch(session:string){
    if(!this.owned.has(session)||!this.dir)return;
    this.watching.add(session);
    if(!this.timer){this.timer=setInterval(()=>this.refresh(),1500);this.timer.unref();}
  }
  active(session:string){
    if(!this.owned.has(session)||!this.dir)return;
    if(!this.running.has(session)){
      this.running.set(session,{id:'agent:'+session,type:'local_agent',description:'agy 서브 에이전트',state:'unknown'});
      this.publish();
    }
    if(!this.timer){this.timer=setInterval(()=>this.refresh(),1500);this.timer.unref();}
  }
  private detailMessage(file:string,msg:any){
    if(!this.dir||!this.details)return;
    if(msg?.sender!=='system'||typeof msg.content!=='string')return;
    const match=/^Subagent ([\da-f-]+) has gone idle\.([\s\S]*)$/i.exec(msg.content);
    if(match&&this.owned.has(match[1]))this.details.idle(match[1],file,match[2].startsWith(" This was the subagent's most recent response: ")?match[2].slice(" This was the subagent's most recent response: ".length):'');
  }
  owns(session:string) { this.refresh(); return this.running.has(session); }
  private refresh(force=false,existing=false) {
    if(!this.dir || !force && !this.waiting.size && !this.running.size && !this.watching.size) return;
    const dir=this.dir;
    let changed=false;
    for(const file of files(join(dir,'subagents'))) {
      if(this.seenChildren.has(file)) continue;
      const child=record(join(dir,'subagents'),file);
      if(child?.conversationId!==file.slice(0,-5)) continue;
      this.seenChildren.add(file);
      this.owned.add(child.conversationId);this.details?.discover(child,existing);
      const role=child.subagentDescriptor?.role;
      const waiting=[...this.waiting].find(([,task])=>task.description===role) ?? this.waiting.entries().next().value;
      if(!waiting) continue;
      this.waiting.delete(waiting[0]);
      this.running.set(child.conversationId,{id:'agent:'+child.conversationId,type:'local_agent',description:role??'agy 서브 에이전트',state:'unknown'});
      changed=true;
    }
    for(const file of files(join(dir,'messages'))) {
      if(this.seenMessages.has(file)) continue;
      const msg=record(join(dir,'messages'),file);
      if(!msg) continue;
      const idle=msg.sender==='system' && typeof msg.content==='string' && /^Subagent ([\da-f-]+) has gone idle\./i.exec(msg.content);
      if(idle && !this.owned.has(idle[1])) continue;
      this.seenMessages.add(file);this.detailMessage(file,msg);
      if(idle){this.watching.delete(idle[1]);if(this.running.delete(idle[1]))changed=true;}
    }
    if(changed) this.publish();
    else this.stopIdleTimer();
  }
  private stopIdleTimer(){
    if(!this.waiting.size && !this.running.size && !this.watching.size) { clearInterval(this.timer); this.timer=undefined; }
  }
  private publish() {
    this.emit([...this.waiting.values(),...this.running.values()]);
    this.stopIdleTimer();
  }
  private stop() {
    clearInterval(this.timer); this.timer=undefined; this.dir=undefined;
    this.watching.clear();this.owned.clear();this.seenChildren.clear(); this.seenMessages.clear();
  }
  reset() {this.waiting.clear();this.running.clear();this.stop();this.emit([]);}
}
