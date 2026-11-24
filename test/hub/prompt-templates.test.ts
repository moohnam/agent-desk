import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { readPromptTemplates,savePromptTemplates } from '../../hub/src/prompt-templates.ts';
import { codePrompt } from '../../shared/prompt-templates.ts';
test('templates persist, reject stale writes and invalid entries without replacing data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-templates-')),file=join(dir,'db');let db=new Store(file);
  try{
    const initial=readPromptTemplates(db);assert.deepEqual(initial.items,[]);
    const saved=savePromptTemplates(db,{...initial,items:[{id:'test',name:'검토',text:'변경을 검토해주세요'}]});
    assert.throws(()=>savePromptTemplates(db,{...initial,items:[]}),/다른 화면/);
    for(const items of [[saved.items[0],saved.items[0]],[{id:'x',name:'',text:'x'}],[{id:'x',name:'x',text:'x'.repeat(16001)}]])
      assert.throws(()=>savePromptTemplates(db,{revision:saved.revision,items}));
    db.database.close();db=new Store(file);assert.deepEqual(readPromptTemplates(db),saved);
    const edited=savePromptTemplates(db,{...saved,items:[{...saved.items[0],text:'수정된 요청'}]});
    assert.equal(edited.items[0].text,'수정된 요청');
    assert.deepEqual(savePromptTemplates(db,{revision:edited.revision,items:[]}).items,[]);
    const quote='```diff\n+#now ${code} {{code}}\n```';assert.equal(codePrompt(' 설명 ',quote),'설명\n\n'+quote);
  }finally{db.database.close();rmSync(dir,{recursive:true,force:true});}
});
test('template HTTP API allows authenticated devices, rejects unauthenticated and cross-origin writes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-templates-http-'));const db=new Store(':memory:');
  const hub=new Hub(db,{skills:new SkillStore(join(dir,'skills')),runner:()=>({connected:true,id:'fake',engines:new Set(),has:()=>false,handle:()=>{}})});
  const access=new Access(join(dir,'token'),4317);const server=createHttpServer(hub,access,join(dir,'uploads'));
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,url=origin+'/api/prompt-templates';
    let sends=0;hub.sendMessage=()=>{sends++;return 'task';};
    const message=()=>fetch(origin+'/api/tasks/task/messages',{method:'POST',headers:{origin,'content-type':'application/json','x-desk-operation-id':'code-http-retry-0001'},body:JSON.stringify({text:'코드 검토'})});
    const first=await message();assert.equal(first.status,202);const receipt=await first.json();
    const retry=await message();assert.equal(retry.status,202);assert.deepEqual(await retry.json(),receipt);assert.equal(sends,1);
    const initial=await (await fetch(url)).json();
    const put=(origin:string,headers={})=>fetch(url,{method:'PUT',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({...initial,items:[{id:'p',name:'검토',text:'설명'}]})});
    assert.equal((await put('http://evil.invalid')).status,403);
    access.hostAllowed=()=>true;access.isLocal=()=>false;
    assert.equal((await fetch(url)).status,401);
    const headers={authorization:`Bearer ${access.token}`};
    assert.equal((await put(origin,headers)).status,200);
    assert.equal((await put(origin,headers)).status,409);
    const read=await fetch(url,{headers});assert.equal(read.headers.get('cache-control'),'no-store');
    assert.equal((await read.json()).items[0].text,'설명');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));hub.dispose();db.database.close();rmSync(dir,{recursive:true,force:true});}
});

test('direct message receipts replay exactly once and reject changed retries',async()=>{
  const { messageReceipt }=await import('../../hub/src/message-receipt.ts');
  const { SharedWorkspace }=await import('../../hub/src/shared-workspace.ts');
  const dir=mkdtempSync(join(tmpdir(),'desk-code-receipt-'));const db=new Store(':memory:');
  const hub=new Hub(db,{skills:new SkillStore(join(dir,'skills')),runner:()=>({connected:true,id:'fake',engines:new Set(),has:()=>false,handle:()=>{}})});
  const authority=new SharedWorkspace(hub,undefined,{localAuthority:true});const peer=authority.grant('test').id;
  try{
    let sends=0;const send=()=>{sends++;return {status:200,body:{task_id:'t',count:sends}};};
    const id='code-send-operation-001';const body={text:'review'};
    assert.deepEqual(messageReceipt(hub,peer,id,'/tasks/t/messages',body,send),{status:200,body:{task_id:'t',count:1}});
    assert.deepEqual(messageReceipt(hub,peer,id,'/tasks/t/messages',body,send),{status:200,body:{task_id:'t',count:1}});
    assert.equal(sends,1);
    assert.throws(()=>messageReceipt(hub,peer,id,'/tasks/t/messages',{text:'changed'},send),/내용이 다릅니다/);
    assert.throws(()=>messageReceipt(hub,'another',id,'/tasks/t/messages',body,send),/내용이 다릅니다/);
  }finally{authority.connectorBroker?.close();hub.dispose();db.database.close();rmSync(dir,{recursive:true,force:true});}
});
