import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Store } from '../db.ts';

type Link={id:string;name:string;url:string;workspace_id:string;token:string};
type Delivery={seq:number;id:string;link_id:string;digest:string;payload:string;result:string|null;status:number|null};
type Index={seq:number;link_id:string};

/** Move only gateway-owned link/receipt rows. The canonical task database is never copied. */
export function importLegacyWorkspaceLinks(sourcePath:string,gateway:Store) {
  const source=new DatabaseSync(sourcePath,{readOnly:true});
  try {
    const has=(name:string)=>!!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const rows=<T>(name:string)=>has(name)?source.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as T[]:[];
    const links=rows<Link>('workspace_link'),deliveries=rows<Delivery>('workspace_delivery'),indices=rows<Index>('workspace_view_index');
    const fingerprint=createHash('sha256').update(JSON.stringify([links,deliveries,indices])).digest('hex');
    const db=gateway.database;
    db.exec('CREATE TABLE IF NOT EXISTS local_gateway_import(source TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)');
    const path=resolve(sourcePath);
    db.exec('BEGIN IMMEDIATE');
    try {
      const imported=db.prepare('SELECT source,fingerprint FROM local_gateway_import').all() as {source:string;fingerprint:string}[];
      if(imported.length) {
        if(imported.length!==1||imported[0].source!==path||imported[0].fingerprint!==fingerprint)
          throw new Error('기존 작업공간 연결 기록이 이관 뒤 바뀌었습니다. 자동 재이관을 중단합니다');
        db.exec('COMMIT');
        return;
      }
      for(const table of ['workspace_link','workspace_delivery','workspace_view_index']) {
        const count=db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number};
        if(count.n)throw new Error('게이트웨이 DB에 이미 작업공간 연결 기록이 있어 자동 이관할 수 없습니다');
      }
      for(const row of links)db.prepare('INSERT INTO workspace_link(id,name,url,workspace_id,token) VALUES (?,?,?,?,?)')
        .run(row.id,row.name,row.url,row.workspace_id,row.token);
      for(const row of deliveries)db.prepare('INSERT INTO workspace_delivery(seq,id,link_id,digest,payload,result,status) VALUES (?,?,?,?,?,?,?)')
        .run(row.seq,row.id,row.link_id,row.digest,row.payload,row.result,row.status);
      if(indices.length)for(const row of indices)db.prepare('INSERT INTO workspace_view_index(seq,link_id) VALUES (?,?)').run(row.seq,row.link_id);
      else for(const row of links)db.prepare('INSERT INTO workspace_view_index(link_id) VALUES (?)').run(row.id);
      db.prepare('INSERT INTO local_gateway_import(source,fingerprint) VALUES (?,?)').run(path,fingerprint);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  } finally {source.close();}
}
