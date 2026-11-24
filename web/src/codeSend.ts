import { api, workspaceOperationId } from './api.ts';
import { SharedPending } from './workspace.ts';
interface Attempt {taskId:string;text:string;id:string;result?:{task_id?:string;shared_pending?:boolean};pending?:Promise<Attempt['result']>}
const attempts:Attempt[]=[];
try{const stored=JSON.parse(sessionStorage.getItem('agent-desk.code-sends')??'[]');if(Array.isArray(stored))for(const item of stored)if(typeof item.taskId==='string'&&typeof item.text==='string'&&typeof item.id==='string')attempts.push(item);}catch{}
function save(){try{sessionStorage.setItem('agent-desk.code-sends',JSON.stringify(attempts.map(({pending,...item})=>item)));}catch{}}
/** IDs survive panel unmounts and uncertain failures; successful retries replay the receipt. */
export async function sendCode(taskId:string,text:string) {
  let attempt=attempts.find(item=>item.taskId===taskId&&item.text===text);
  if(!attempt){
    if(attempts.length>=30){const oldest=attempts.findIndex(item=>item.result&&!item.pending);if(oldest>=0)attempts.splice(oldest,1);else throw new Error('미확인 코드 전송이 너무 많습니다. 전달 내역을 확인하세요');}
    attempt={taskId,text,id:workspaceOperationId()};attempts.push(attempt);save();
  }
  if(attempt.result)return attempt.result;
  if(attempt.pending)return attempt.pending;
  const held=attempt;
  held.pending=api.send(taskId,text,held.id).catch(error=>{if(error instanceof SharedPending)return {task_id:taskId,shared_pending:true};throw error;}).then(result=>{held.result=result;save();return result;}).finally(()=>{held.pending=undefined;});
  return held.pending;
}
