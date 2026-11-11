import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { SkillStore } from '../../hub/src/skills.ts';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));

test('revoking a workspace peer interrupts its active file response',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-file-revoke-'));
  const project=join(dir,'project');mkdirSync(project);
  const path=join(project,'large.bin');writeFileSync(path,'');truncateSync(path,50*1024*1024);
  const store=new Store(join(dir,'desk.db'));
  const hub=new Hub(store,{skills:new SkillStore(join(dir,'skills')),runner:()=>({connected:true,id:'local-test',engines:new Set(['claude']),has:()=>true,handle:()=>{}})});
  const workspace=new SharedWorkspace(hub),peer=workspace.grant('reader');
  const task=workspace.execute(peer.id,{id:randomUUID(),method:'POST',path:'/compose',body:{text:`@files:${project} #claude test`}}).body;
  const server=workspace.server();
  try {
    const url=await listen(server);
    const response=await fetch(`${url}/v1/file?task_id=${task.id}&href=large.bin`,{headers:{authorization:`Bearer ${peer.token}`,'x-workspace-id':workspace.id}});
    assert.equal(response.status,200);
    workspace.revoke(peer.id);
    let received=0;
    try { for await(const chunk of response.body! as any)received+=chunk.length; }
    catch { /* A destroyed in-flight response rejects the reader. */ }
    assert.ok(received<50*1024*1024,'revoked peer received the complete file');
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    hub.dispose();store.database.close();rmSync(dir,{recursive:true,force:true});
  }
});
