import type { Hub } from './hub.ts';
import { canonical,digest } from './shared-workspace.ts';
import { HttpError } from './errors.ts';
import type { WorkspaceResult } from './workspace-api.ts';
/** Reuse the authority's durable receipts for direct HTTP message retries too. */
export function messageReceipt(hub:Hub,peer:string,id:string,path:string,body:unknown,send:()=>WorkspaceResult):WorkspaceResult {
  if(!/^[a-zA-Z0-9-]{16,100}$/.test(id))throw new HttpError(400,'잘못된 전송 ID입니다');
  const hash=digest(canonical({method:'POST',path,body}));
  return hub.atomic(()=>{
    const prior=hub.store.database.prepare('SELECT peer_id,digest,result FROM workspace_receipt WHERE id=?').get(id) as {peer_id:string;digest:string;result:string}|undefined;
    if(prior){if(prior.peer_id!==peer||prior.digest!==hash)throw new HttpError(409,'이미 사용한 전송 ID의 내용이 다릅니다');return JSON.parse(prior.result);}
    const result=send();
    if(result.status<500)hub.store.database.prepare('INSERT INTO workspace_receipt VALUES (?,?,?,?,?)').run(id,peer,hash,JSON.stringify(result),new Date().toISOString());
    return result;
  });
}
