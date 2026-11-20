import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { randomUUID } from 'node:crypto';
import { Store } from '../../hub/src/db.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { agentPublicKeys, publicKey, signWithAgent, SSH_ENROLL_NAMESPACE } from '../../hub/src/ssh-signature.ts';
import { enrollmentCall, requestEnrollment, sshLogin } from '../../hub/src/ssh-client.ts';

// Real OpenSSH signing with disposable keys and an isolated agent. Never uses personal keys.
test('SSH bootstrap, signatures, pinned workspace, replay, expiry, revocation and recovery', async t => {
  const dir=mkdtempSync(join(tmpdir(),'desk-ssh-test-'));
  const previous=process.env.SSH_AUTH_SOCK;
  let agentPid:number|undefined;
  const store=new Store(join(dir,'workspace.db'));
  const hub=new Hub(store,{skills:new SkillStore(join(dir,'skills')),runner:()=>({connected:true,id:'fixture',engines:new Set(['claude','codex']),has:()=>false,handle:()=>{}})});
  const workspace=new SharedWorkspace(hub);
  const server=workspace.server();
  const requesterStore=new Store(join(dir,'requester.db'));
  const requester=new WorkspaceLinks(requesterStore);
  t.after(async()=>{
    if(server.listening){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
    await requester.close();requesterStore.database.close();
    hub.dispose();store.database.close();
    if(previous===undefined)delete process.env.SSH_AUTH_SOCK;else process.env.SSH_AUTH_SOCK=previous;
    if(agentPid)process.kill(agentPid,'SIGTERM');
    rmSync(dir,{recursive:true,force:true});
  });
  const keyFile=join(dir,'key');
  const otherFile=join(dir,'other');
  const candidateFile=join(dir,'candidate');
  const rejectedFile=join(dir,'rejected');
  for(const file of [keyFile,otherFile,candidateFile,rejectedFile])execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',file]);
  const key=readFileSync(keyFile+'.pub','utf8'),other=readFileSync(otherFile+'.pub','utf8');
  const out=execFileSync('/usr/bin/ssh-agent',['-s','-a',join(dir,'agent.sock')],{encoding:'utf8'});
  agentPid=Number(out.match(/SSH_AGENT_PID=(\d+)/)![1]);
  process.env.SSH_AUTH_SOCK=join(dir,'agent.sock');
  execFileSync('/usr/bin/ssh-add',[keyFile,otherFile,candidateFile,rejectedFile],{stdio:'ignore'});
  const legacy=workspace.grant('old-hub');
  const runtime=workspace.grant('agent-desk-runtime');
  const admin=await workspace.ssh.register({name:'Mac',ownerName:'남무현',publicKey:key},undefined,legacy.id);
  assert.equal(admin.peerId,legacy.id);
  assert.equal(admin.admin,true);
  await assert.rejects(workspace.ssh.register({name:'race',ownerName:'other',publicKey:other}),/이미 완료/);
  assert.throws(()=>workspace.authenticate(legacy.token),/만료/);
  workspace.adoptRuntime(runtime.id,runtime.token);
  assert.equal(workspace.authenticate(runtime.token,true),runtime.id);
  assert.throws(()=>workspace.adoptRuntime(legacy.id,legacy.token),/올바르지/);
  const member=await workspace.ssh.register({name:'server',ownerName:'other',publicKey:other},admin.peerId);
  assert.equal(member.admin,false);
  await assert.rejects(workspace.ssh.register({name:'no',ownerName:'no',publicKey:key},member.peerId),/관리자/);
  assert.throws(()=>workspace.ssh.challenge(admin.fingerprint,'wrong'),/작업공간/);
  let c=workspace.ssh.challenge(admin.fingerprint,workspace.id);
  await assert.rejects(workspace.ssh.authenticateChallenge(c.id,await signWithAgent(other,c.message)),/일치하지/);
  await assert.rejects(workspace.ssh.authenticateChallenge(c.id,await signWithAgent(key,c.message)),/이미 사용/);
  c=workspace.ssh.challenge(admin.fingerprint,workspace.id);
  const signature=await signWithAgent(key,c.message);
  const results=await Promise.allSettled([workspace.ssh.authenticateChallenge(c.id,signature),workspace.ssh.authenticateChallenge(c.id,signature)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const signed=results.find(r=>r.status==='fulfilled')! as PromiseFulfilledResult<Awaited<ReturnType<typeof workspace.ssh.authenticateChallenge>>>;
  assert.equal(workspace.authenticate(signed.value.token),admin.peerId);
  store.database.prepare('UPDATE ssh_session SET expires=0').run();
  assert.throws(()=>workspace.authenticate(signed.value.token),/만료/);
  c=workspace.ssh.challenge(admin.fingerprint,workspace.id);
  store.database.prepare('UPDATE ssh_challenge SET expires=0 WHERE id=?').run(c.id);
  await assert.rejects(workspace.ssh.authenticateChallenge(c.id,signature),/만료/);
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=await sshLogin(url,workspace.id,key,AbortSignal.timeout(10000));
  const headers={authorization:`Bearer ${session.token}`,'x-workspace-id':workspace.id};
  assert.equal((await fetch(url+'/v1/ssh/peers',{headers})).status,200);
  assert.equal((await fetch(url+'/v1/ssh/peers',{headers:{...headers,'x-workspace-id':'wrong'}})).status,409);
  assert.equal((await fetch(url+'/v1/identity',{headers:{authorization:`Bearer ${runtime.token}`}})).status,403);
  assert.equal((await fetch(url+'/v1/ssh/peers',{headers:{...headers,origin:'https://untrusted.example'}})).status,403);
  const memberSession=await sshLogin(url,workspace.id,other,AbortSignal.timeout(10000));
  assert.equal((await fetch(url+'/v1/ssh/peers',{headers:{...headers,authorization:`Bearer ${memberSession.token}`}})).status,403);
  const enrolledKey=publicKey(readFileSync(candidateFile+'.pub','utf8')).key;
  assert.ok((await agentPublicKeys()).some(k=>k.key===enrolledKey));
  const initial={workspaceId:workspace.id,name:'new-Mac',ownerName:'새 사용자',publicKey:enrolledKey};
  const proof=await enrollmentCall(url,'challenge',initial);
  await assert.rejects(enrollmentCall(url,'submit',{id:proof.id,signature:await signWithAgent(key,proof.message,SSH_ENROLL_NAMESPACE)}),{status:401});
  await assert.rejects(enrollmentCall(url,'submit',{id:proof.id,signature:await signWithAgent(enrolledKey,proof.message,SSH_ENROLL_NAMESPACE)}),{status:401});
  const linkId=randomUUID();
  requesterStore.database.prepare('INSERT INTO workspace_link VALUES(?,?,?,?,?)').run(linkId,'공유 공간',url+'/',workspace.id,legacy.token);
  requesterStore.database.prepare('INSERT INTO workspace_view_index(link_id) VALUES(?)').run(linkId);
  const outgoing=await requester.startSshRequest({...initial,name:'공유 공간',hubName:initial.name,url,linkId});
  assert.equal(outgoing.status,'pending');
  assert.throws(()=>requester.enqueue(linkId,{id:randomUUID(),method:'POST',path:'/compose',body:{text:'이전 인증으로 들어온 메시지'}}),
    {status:409});
  assert.equal(requester.list()[0]?.pending,0);
  await assert.rejects(sshLogin(url,workspace.id,enrolledKey,AbortSignal.timeout(10000)),{status:401});
  const list=async (auth=headers)=>fetch(url+'/v1/ssh/requests',{headers:auth});
  assert.equal((await list({...headers,authorization:`Bearer ${memberSession.token}`})).status,403);
  let [incoming]=await (await list()).json() as {id:string;name:string;ownerName:string;fingerprint:string}[];
  assert.equal(incoming.ownerName,initial.ownerName);
  assert.equal(incoming.fingerprint,publicKey(enrolledKey).fingerprint);
  const respond=(approve:boolean,auth=headers)=>fetch(url+'/v1/ssh/requests/'+incoming.id,{
    method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({approve}),
  });
  assert.equal((await respond(true,{...headers,authorization:`Bearer ${memberSession.token}`})).status,403);
  assert.equal((await respond(true)).status,200);
  assert.deepEqual(await (await list()).json(),[]);
  assert.equal((await respond(false)).status,409);
  const deadline=Date.now()+10000;
  while (requester.outgoingSshRequests()[0]?.status!=='connected' && Date.now()<deadline) await delay(50);
  assert.equal(requester.outgoingSshRequests()[0]?.status,'connected');
  assert.equal(requester.list()[0]?.id,linkId);
  assert.equal(requester.list()[0]?.publicKey,enrolledKey);
  const newPeer=workspace.ssh.peers().find(p=>p.fingerprint===incoming.fingerprint)!;
  assert.equal(newPeer.ownerName,initial.ownerName);
  workspace.revoke(newPeer.peerId);
  assert.equal((await enrollmentCall(url,'status',{id:incoming.id})).status,'rejected');
  await assert.rejects(requestEnrollment(url,workspace.id,initial),{status:409});
  assert.deepEqual(await (await list()).json(),[]);
  const rejectedKey=readFileSync(rejectedFile+'.pub','utf8');
  await assert.rejects(requestEnrollment(url,randomUUID(),{...initial,publicKey:rejectedKey}),{status:404});
  const rejectedId=await requestEnrollment(url,workspace.id,{...initial,publicKey:rejectedKey});
  [incoming]=await (await list()).json() as typeof incoming[];
  assert.equal(rejectedId,incoming.id);
  assert.equal((await respond(false)).status,200);
  assert.equal((await enrollmentCall(url,'status',{id:rejectedId})).status,'rejected');
  assert.deepEqual(await (await list()).json(),[]);
  assert.equal((await respond(true)).status,409);
  await assert.rejects(sshLogin(url,workspace.id,rejectedKey,AbortSignal.timeout(10000)),{status:401});
  const target=workspace.execute(admin.peerId,{id:randomUUID(),method:'POST',path:'/compose',body:{text:`@target:${dir} #claude original`}}).body;
  const sessionId=store.latestSession(target.id)!.id;
  const requestId=randomUUID();
  const response=await fetch(url+'/v1/broker/receive',{method:'POST',headers:{...headers,authorization:`Bearer ${memberSession.token}`,'content-type':'application/json'},body:JSON.stringify({id:requestId,text:'question',to_task_id:target.id,from:{task_id:'foreign-task',session_id:sessionId,project_name:'remote',seq:1,title:'foreign',cwd:dir}})});
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(store.origins.queued(requestId)?.peerId,member.peerId,'the untrusted from.session_id must not impersonate the admin');
  const queued=store.queued({taskId:target.id});
  assert.equal(queued.length,1);
  assert.equal(store.origins.queued(queued[0].id)?.peerId,member.peerId);
  c=workspace.ssh.challenge(member.fingerprint,workspace.id);
  const memberSignature=await signWithAgent(other,c.message);
  workspace.revoke(member.peerId);
  assert.throws(()=>workspace.authenticate(memberSession.token),/만료/);
  await assert.rejects(workspace.ssh.authenticateChallenge(c.id,memberSignature),/使用|사용/);
  const reopened=new SharedWorkspace(undefined,store);
  assert.equal(reopened.ssh.identity(admin.peerId).ownerName,'남무현');
  await assert.rejects(reopened.ssh.register({name:'again',ownerName:'again',publicKey:key}),/이미 완료/);
  // A request authenticated at the headers must not retain access while its body stalls.
  for(const [path,body] of [
    ['/v1/ssh/peers',{name:'late',ownerName:'late',publicKey:other}],
    ['/v1/operation',{id:randomUUID(),method:'POST',path:'/compose',body:{text:`@late:${dir} reject this work`}}],
  ] as const) {
    const fresh=await sshLogin(url,workspace.id,key,AbortSignal.timeout(10000));
    const arriving=once(server,'request');
    const responseReady=Promise.withResolvers<number>();
    const slow=httpRequest(url+path,{method:'POST',headers:{...headers,authorization:`Bearer ${fresh.token}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>responseReady.resolve(res.statusCode!));});
    slow.on('error',responseReady.reject);slow.write('{');
    await arriving;
    workspace.ssh.invalidate(admin.peerId);
    slow.end(JSON.stringify(body).slice(1));
    assert.equal(await responseReady.promise,401,`invalidated session cannot use ${path} after body reception`);
  }
  // Invalidation must also cancel verification already running outside SQLite.
  c=workspace.ssh.challenge(admin.fingerprint,workspace.id);
  const pendingSignature=await signWithAgent(key,c.message);
  const pendingAuthentication=workspace.ssh.authenticateChallenge(c.id,pendingSignature);
  workspace.ssh.invalidate(admin.peerId);
  await assert.rejects(pendingAuthentication,/인증 정보가 변경/);
  c=workspace.ssh.challenge(admin.fingerprint,workspace.id);
  const staleChallengeSignature=await signWithAgent(key,c.message);
  // A consumed challenge must carry its issued generation, not reread a newer one.
  store.database.prepare('UPDATE ssh_challenge SET generation=0 WHERE id=?').run(c.id);
  await assert.rejects(workspace.ssh.authenticateChallenge(c.id,staleChallengeSignature),/인증 정보가 변경/);
  // Rotating to the same public key still revokes pre-recovery sessions.
  const rotated=await workspace.ssh.rotate(admin.peerId,key);
  assert.equal(rotated.ownerId,admin.ownerId);
  assert.throws(()=>workspace.authenticate(session.token),/만료/);
  // Even a stale insert committed after another process invalidates cannot revive access.
  const staleToken='late-session-after-invalidation';
  const {createHash}=await import('node:crypto');
  store.database.prepare('INSERT INTO ssh_session(token_hash,peer_id,expires,generation) VALUES(?,?,?,?)')
    .run(createHash('sha256').update(staleToken).digest('hex'),admin.peerId,Date.now()+60000,0);
  assert.throws(()=>workspace.authenticate(staleToken),/만료/);

  assert.equal(publicKey(key).fingerprint,rotated.fingerprint);
});
