import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../hub/src/db.ts';
import { connectLocalTakeover } from '../../hub/src/runner/local-runtime.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import type { RunnerToHub } from '../../shared/protocol.ts';

const runnerId=`local-${hostname()}`;
const sessionId='existing-session';
const approvalId='existing-approval';

function source(dir:string, lease=false) {
  const path=join(dir,'desk.db');
  const store=new Store(path);
  store.database.prepare('INSERT INTO project VALUES (?,?,?,?)').run('p','existing',dir,'2026-01-01');
  store.database.prepare("INSERT INTO task (id,project_id,title,status,created_by,created_at,updated_at,seq) VALUES ('t','p','old','waiting','owner','2026-01-01','2026-01-01',1)").run();
  store.database.prepare("INSERT INTO session (id,task_id,engine,engine_session_id,cwd,source,status,runner_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(sessionId,'t','claude','engine-existing',dir,'app','waiting',runnerId,'2026-01-01');
  store.database.prepare("INSERT INTO approval (id,session_id,task_id,tool_name,input_json,status,created_at) VALUES (?,?,?,'Bash','{}','pending','2026-01-01')")
    .run(approvalId,sessionId,'t');
  store.database.prepare("INSERT INTO queued (id,task_id,session_id,text,body,skills_json,mode,created_at,ord) VALUES ('q','t',?,'later','later','[]','ask','2026-01-01',1)").run(sessionId);
  if(lease){
    store.database.exec("CREATE TABLE local_authority (id INTEGER PRIMARY KEY,host TEXT NOT NULL,pid INTEGER NOT NULL,activated_at TEXT NOT NULL)");
    store.database.prepare('INSERT INTO local_authority VALUES (1,?,?,?)').run(hostname(),process.pid,'');
  }
  store.database.close();
  return path;
}

const hello=(id=runnerId):Extract<RunnerToHub,{type:'hello'}>=>({
  type:'hello',runnerId:id,host:hostname(),capabilities:{engines:['claude'],close:true},protocolVersion:1,
  sessions:[{sessionId,busy:true,approvals:[{approvalId,toolName:'Bash',input:{}}]}],
});

async function fixture(reply?:string) {
  const sockets=new Set<Socket>();
  let accepted=0;
  const server=createServer(socket=>{
    sockets.add(socket);accepted++;
    socket.on('close',()=>sockets.delete(socket));
    if(reply!==undefined)socket.once('data',()=>socket.write(reply));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:(server.address() as {port:number}).port, get accepted(){return accepted;}, close:async()=>{
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }};
}

test('one authenticated socket hands an active session, approval, queue and next event to Hub',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-takeover-'));
  const db=source(dir);
  const event:RunnerToHub={type:'event',sessionId,event:{kind:'assistant',text:'after hello'}};
  const net=await fixture(`${JSON.stringify(hello())}\n${JSON.stringify(event)}\n`);
  let runtime:Awaited<ReturnType<typeof connectLocalTakeover>>|undefined;
  try {
    runtime=await connectLocalTakeover(db,{timeoutMs:1000,client:{host:'127.0.0.1',port:net.port,token:()=> 'fixture-token'},
      skills:new SkillStore(join(dir,'skills'))});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(net.accepted,1);
    assert.equal(runtime.hub.store.getSession(sessionId)?.engine_session_id,'engine-existing');
    assert.equal(runtime.hub.store.getApproval(approvalId)?.status,'pending');
    assert.deepEqual(runtime.hub.store.queued().map(x=>x.id),['q']);
    assert.equal(runtime.hub.store.listEvents('t').filter(x=>x.kind==='assistant').length,1);
  }finally{runtime?.close();await net.close();rmSync(dir,{recursive:true,force:true});}
});

test('wrong, incomplete and missing hello leave canonical state untouched',async()=>{
  const invalid=[hello('local-wrong'),{...hello(),protocolVersion:2},{...hello(),sessions:[]},
    {...hello(),sessions:[{sessionId,busy:true,approvals:[]}]}];
  for(const reply of [...invalid.map(value=>`${JSON.stringify(value)}\n`),undefined]){
    const dir=mkdtempSync(join(tmpdir(),'desk-takeover-reject-'));
    const db=source(dir);
    const net=await fixture(reply);
    try {
      await assert.rejects(connectLocalTakeover(db,{timeoutMs:100,client:{host:'127.0.0.1',port:net.port,token:()=> 'fixture-token'}}));
      const check=new DatabaseSync(db,{readOnly:true});
      try {
        assert.equal(check.prepare("SELECT status FROM session WHERE id=?").get(sessionId)?.status,'waiting');
        assert.equal(check.prepare("SELECT status FROM approval WHERE id=?").get(approvalId)?.status,'pending');
        assert.equal(check.prepare("SELECT count(*) AS n FROM queued").get()?.n,1);
        assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='local_authority'").get(),undefined);
      }finally{check.close();}
    }finally{await net.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('an existing authority lease remains when live takeover is rejected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-takeover-lease-'));
  const db=source(dir,true);
  const net=await fixture(`${JSON.stringify(hello())}\n`);
  try {
    await assert.rejects(connectLocalTakeover(db,{timeoutMs:1000,client:{host:'127.0.0.1',port:net.port,token:()=> 'fixture-token'}}),/이미 실행/);
    const check=new DatabaseSync(db,{readOnly:true});
    try {
      assert.equal(check.prepare('SELECT pid FROM local_authority WHERE id=1').get()?.pid,process.pid);
      assert.equal(check.prepare("SELECT status FROM session WHERE id=?").get(sessionId)?.status,'waiting');
    }finally{check.close();}
  }finally{await net.close();rmSync(dir,{recursive:true,force:true});}
});

test('a missing daemon is not started by live takeover',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desk-takeover-missing-'));
  const db=source(dir);
  const probe=await fixture();
  const port=probe.port;
  await probe.close();
  try {
    await assert.rejects(connectLocalTakeover(db,{timeoutMs:300,client:{host:'127.0.0.1',port,token:()=> 'fixture-token'}}));
    const check=new DatabaseSync(db,{readOnly:true});
    try {assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='local_authority'").get(),undefined);}
    finally{check.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
