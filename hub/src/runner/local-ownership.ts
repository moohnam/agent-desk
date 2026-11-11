import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';

function owner(path:string):{host:string;pid:number;activated_at:string}|undefined {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_authority'").get();
    return table?db.prepare('SELECT host,pid,activated_at FROM local_authority WHERE id=1').get() as {host:string;pid:number;activated_at:string}|undefined:undefined;
  } finally { db.close(); }
}

/** A durable activation marker prevents a later legacy hub from reopening canonical task state. */
export function localAuthorityActivated(path: string): boolean {return !!owner(path)?.activated_at;}

export function assertLegacyHubAllowed(path: string) {
  const record=owner(path);
  let claimed=!!record?.pid;
  if(claimed && record!.host===hostname()) {
    try {process.kill(record!.pid,0);}catch(error){claimed=(error as NodeJS.ErrnoException).code!=='ESRCH';}
  }
  if (record?.activated_at || claimed) throw new Error('이 작업 DB는 로컬 러너 authority가 소유합니다. 기존 허브 모드로 다시 열 수 없습니다');
}
