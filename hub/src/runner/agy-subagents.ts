// ACP child notifications are accepted only after the parent's native metadata proves ownership.
// Metadata does not reliably map a spawn tool call to a child: never match prompts by role/order.
import type { RunnerToHub, SubagentInfo, SubagentEvent } from '../../../shared/protocol.ts';
const clip=(s:string)=>s.length>64000?s.slice(0,64000)+'\n…(truncated)':s;
export class AgySubagents {
  private known=new Map<string,SubagentInfo>();
  private buffers=new Map<string,string>();
  private tools=new Map<string,string>();
  private emit:(m:RunnerToHub)=>void;
  private sessionId:string;
  constructor(sessionId:string,emit:(m:RunnerToHub)=>void){this.sessionId=sessionId;this.emit=emit;}
  private report(info:SubagentInfo){this.known.set(info.id,info);this.emit({type:'subagent',sessionId:this.sessionId,subagent:info});}
  private step(id:string,event:SubagentEvent){this.emit({type:'subagent_event',sessionId:this.sessionId,subagentId:id,event});}
  discover(child:any,existing:boolean){
    const id='agent:'+child.conversationId;if(this.known.has(id))return;
    this.report({id,type:'local_agent',description:typeof child.subagentDescriptor?.role==='string'?child.subagentDescriptor.role:'agy 서브 에이전트',
      status:existing?'unknown':'running',background:true,
      detailNote:'AGY 자식 세션의 도구 기록과 native 종료 알림의 최근 응답을 보존합니다. 식별자 없는 실시간 응답 조각은 진행 요약으로만 표시합니다. 생성 지시와 이전 전체 대화는 연결 자료가 없어 복구하지 않습니다.'});
  }
  idle(childId:string,file:string,response:string){
    const id='agent:'+childId,info=this.known.get(id);if(!info)return;
    this.buffers.delete(id);
    if(response)this.step(id,{kind:'assistant',text:clip(response),sourceId:'agy-message:'+file});
    this.report({...info,status:'ended',summary:undefined});
  }
  update(childId:string,u:any){
    const id='agent:'+childId,info=this.known.get(id);if(!info)return;
    if(info.status!=='running' && u?.sessionUpdate==='tool_call')this.report({...info,status:'running'});
    if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'&&typeof u.content.text==='string'){
      // ACP chunks have no message/run identity. Keep progress in the replaceable row;
      // only the native idle message's stable ID creates a durable assistant event.
      if(info.status==='ended'||info.status==='stopped')return;
      const summary=clip((this.buffers.get(id)??'')+u.content.text);
      this.buffers.set(id,summary);this.report({...info,summary});return;
    }
    if(!['tool_call','tool_call_update'].includes(u?.sessionUpdate)||typeof u.toolCallId!=='string')return;
    this.buffers.delete(id);
    const key=id+'/'+u.toolCallId;
    if(!this.tools.has(key)){
      this.tools.set(key,u.toolCallId);
      const input=u.rawInput??u.args??{};
      this.step(id,{kind:'tool',toolUseId:u.toolCallId,name:String(u.name??u.title??'tool'),input:JSON.stringify(input).length>64000?{truncated:clip(JSON.stringify(input))}:input,sourceId:'agy-tool:'+u.toolCallId});
    }
    if(u.status==='completed'||u.status==='failed'){
      const output=u.rawOutput??u.content?.map((c:any)=>c.content?.text??'').join('\n')??'';
      this.step(id,{kind:'tool_result',toolUseId:u.toolCallId,isError:u.status==='failed',text:clip(typeof output==='string'?output:JSON.stringify(output)),sourceId:'agy-result:'+u.toolCallId});
      this.tools.delete(key);
    }
  }
  close(){this.buffers.clear();}
}
