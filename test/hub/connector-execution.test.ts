import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../hub/src/hub.ts';
import { Store } from '../../hub/src/db.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { ConnectorBroker, type ConnectorExecutionContext } from '../../hub/src/connector-broker.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { codexMcpProcess, claudeMcpOptions } from '../../hub/src/runner/managed-mcp.ts';
import { checkHubToRunner, type HubToRunner, type RunnerToHub } from '../../shared/protocol.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'desk-connector-execution-'));
  const store = new Store(':memory:'), sent:HubToRunner[] = [], live = new Set<string>();
  let say!:(message:RunnerToHub)=>void;
  const hub = new Hub(store,{skills:new SkillStore(join(dir,'skills')),runner:emit=>{
    say=emit;
    return {connected:true,id:'fixture',engines:new Set(['codex','claude','agy']),connectorMcpSupported:true,
      has:id=>live.has(id),handle:command=>{sent.push(command);if(command.type==='start')live.add(command.sessionId);}};
  }});
  const broker = new ConnectorBroker(store.database,'workspace',{shouldAuthorizePeer:()=>true,onIdle:id=>hub.connectorIdle(id)});
  hub.connectorBroker=broker;hub.connectorMcpUrl='http://127.0.0.1:4321/v1/connector-mcp';
  const context=(peer='A',request='first'):ConnectorExecutionContext=>({sourcePeerId:'peer-'+peer,
    hubId:'hub-'+peer,workspaceId:'workspace',requestId:request,capability:(peer==='A'?'a':'b').repeat(43),
    expiresAt:Date.now()+60_000,connections:[{service:'jira',generation:peer,tools:['getJiraIssue']}]});
  const task=hub.withConnectorContext(context(),()=>hub.compose(`@fixture:${dir} #codex 시작`));
  const start=sent[0] as Extract<HubToRunner,{type:'start'}>;
  return {hub,store,broker,sent,say,context,task,start,
    close:()=>{hub.dispose();store.database.close();rmSync(dir,{recursive:true,force:true});}};
}

test('cross-hub now messages wait for the turn and background work, then use their own grant',()=>{
  const f=fixture();
  try {
    assert.ok(f.start.connectorMcp);
    f.hub.withConnectorContext(f.context('A','steering'),()=>f.hub.sendMessage(f.task.id,'#now 같은 계정'));
    assert.equal(f.broker.stored(f.start.sessionId)?.requestId,'first');
    f.hub.withConnectorContext(f.context('B','next'),()=>f.hub.sendMessage(f.task.id,'#now 다른 계정'));
    const q=f.store.queued()[0];assert.ok(q);
    assert.throws(()=>f.hub.sendQueuedNow(f.task.id,q.id),/작업.*조회/);
    assert.ok(!JSON.stringify(f.hub.state()).includes(f.context().capability));
    assert.ok(!JSON.stringify(f.hub.state()).includes('connector_context'));
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[{id:'sub',description:'진행',status:'running'}] as never});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.queued().length,1);
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[]});
    assert.equal(f.store.queued().length,0);
    assert.equal(f.broker.stored(f.start.sessionId)?.sourcePeerId,'peer-B');
    assert.equal(f.sent.at(-1)?.type,'send');
  } finally {f.close();}
});

test('in-flight connector calls also delay authority changes and completion drains once',async()=>{
  const f=fixture();
  try {
    const pending=f.broker.invoke(f.start.connectorMcp!.token,'list');
    f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'#now 다음'));
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.queued().length,1);
    const [job]=f.broker.poll('peer-A');f.broker.complete('peer-A',job.callId,{result:{connections:['A']}});
    assert.deepEqual(await pending,{connections:['A']});
    assert.equal(f.store.queued().length,0);
    assert.equal(f.broker.stored(f.start.sessionId)?.sourcePeerId,'peer-B');
  } finally {f.close();}
});

test('expired queued authority preserves text and emits a visible failure instead of dropping it',()=>{
  const f=fixture();
  try {
    f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'보관할 메시지'));
    const q=f.store.queued()[0];q.connector_context!.expiresAt=1;
    f.store.database.prepare('UPDATE queued SET connector_context_json=? WHERE id=?').run(JSON.stringify(q.connector_context),q.id);
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.queued()[0].id,q.id);
    assert.match(JSON.stringify(f.store.listEvents(f.task.id,1)[0]?.payload),/대기 메시지를 보관/);
    assert.throws(()=>f.hub.sendQueuedNow(f.task.id,q.id),/만료/);
    assert.equal(f.store.queued()[0].id,q.id);
  } finally {f.close();}
});

test('explicit ungranted input clears authority only at the next turn and reset uses a new grant',async()=>{
  const f=fixture();
  try {
    f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'권한 없는 입력'));
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.broker.stored(f.start.sessionId),undefined);
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list'),{connections:[]});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    f.hub.withConnectorContext(f.context('B','reset'),()=>f.hub.resetContext(f.task.id,'새 문맥'));
    const next=f.sent.at(-1) as Extract<HubToRunner,{type:'start'}>;
    assert.notEqual(next.sessionId,f.start.sessionId);
    assert.equal(f.broker.stored(next.sessionId)?.requestId,'reset');
    await assert.rejects(f.broker.invoke(f.start.connectorMcp!.token,'list'),/인증/);
  } finally {f.close();}
});

test('engine MCP secrets use child environment only and invalid endpoints are rejected',()=>{
  const connector={url:'http://127.0.0.1:4321/v1/connector-mcp',token:'x'.repeat(43)};
  const codex=codexMcpProcess(undefined,connector),claude=claudeMcpOptions(undefined,connector);
  assert.ok(!codex.args.join(' ').includes(connector.token));
  assert.ok(!JSON.stringify(claude.mcpServers).includes(connector.token));
  assert.equal(codex.env.AGENT_DESK_CONNECTOR_MCP_AUTH,'Bearer '+connector.token);
  assert.equal(claude.env.AGENT_DESK_CONNECTOR_MCP_AUTH,'Bearer '+connector.token);
  assert.equal(codexMcpProcess().env.AGENT_DESK_CONNECTOR_MCP_AUTH,undefined);
  const start={type:'start',sessionId:'s',engine:'codex',cwd:'/tmp',prompt:'test',permissionMode:'auto',connectorMcp:connector};
  assert.equal(typeof checkHubToRunner(start),'object');
  for(const url of ['https://remote/v1/connector-mcp','http://127.0.0.1:4321/other','http://user@127.0.0.1/v1/connector-mcp'])
    assert.equal(typeof checkHubToRunner({...start,connectorMcp:{...connector,url}}),'string');
});

test('unsupported AGY keeps ordinary work usable without receiving connector authority',()=>{
  const f=fixture();
  try {
    const task=f.hub.withConnectorContext(f.context('B'),()=>f.hub.createTask(f.task.project_id,'AGY','#agy 작업'));
    const start=f.sent.at(-1) as Extract<HubToRunner,{type:'start'}>;
    assert.equal(start.connectorMcp,undefined);
    f.hub.withConnectorContext(f.context('B','steer'),()=>f.hub.sendMessage(task.id,'#now 이어서'));
    assert.equal(f.sent.at(-1)?.type,'send');
    assert.equal(f.broker.hasSession(start.sessionId),false);
    assert.match(JSON.stringify(f.store.listEvents(task.id)),/외부 연결 도구를 지원하지 않습니다/);
  } finally {f.close();}
});

test('agent questions cannot borrow the target conversation’s previous hub authority',async()=>{
  const f=fixture();
  try {
    const request=f.hub.requests.receiveCross('request-cross',{text:'조회해 주세요',toTaskId:f.task.id,
      from:{task_id:'other-task',session_id:'other-session',project_name:'other',seq:1,title:'질문',cwd:'/tmp'}});
    assert.equal(request.status,'queued');
    assert.equal(f.store.queued()[0].connector_context,null);
    assert.equal(f.broker.stored(f.start.sessionId)?.hubId,'hub-A');
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.getRequest(request.id)?.status,'running');
    assert.equal(f.broker.stored(f.start.sessionId),undefined);
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list'),{connections:[]});
  } finally {f.close();}
});

test('another account cannot answer a pending question by message or change the running session',()=>{
  const f=fixture();
  try {
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'question-A',toolName:'AskUserQuestion',input:{questions:[{question:'무엇을 조회할까요?'}]}});
    const commands=f.sent.length, events=f.store.listEvents(f.task.id).length;
    assert.throws(()=>f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'#now #ask A의 PRIVATE-123을 조회해 주세요')),/응답 계정/);
    assert.equal(f.sent.length,commands);
    assert.equal(f.store.listEvents(f.task.id).length,events);
    assert.equal(f.store.getApproval('question-A')?.status,'pending');
    assert.equal(f.broker.stored(f.start.sessionId)?.requestId,'first');
    f.hub.withConnectorContext(f.context('A','answer'),()=>f.hub.sendMessage(f.task.id,'A의 정상 답변'));
    assert.equal(f.sent.at(-1)?.type,'approval_result');
    assert.equal(f.store.getApproval('question-A')?.status,'allowed');
  } finally {f.close();}
});

test('authenticated peer is checked independently of connector grants for approval answers and messages',()=>{
  const f=fixture(), shared=new SharedWorkspace(f.hub);
  f.hub.connectorBroker=f.broker;
  try {
    const peer=shared.grant('B');
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'question-A',toolName:'AskUserQuestion',input:{questions:[{question:'조회 대상'}]}});
    for (const body of [{allow:true,answers:{'조회 대상':'A 비공개 이슈'}},{allow:false,message:'A 비공개 이슈를 조회하세요'}]) {
      const commands=f.sent.length;
      const result=shared.execute(shared.authenticate(peer.token),{id:crypto.randomUUID(),method:'POST',path:'/approvals/question-A',body});
      assert.equal(result.status,409);
      assert.equal(f.sent.length,commands);
      assert.equal(f.store.getApproval('question-A')?.status,'pending');
    }
    assert.throws(()=>f.hub.withInputPeer(peer.id,()=>f.hub.withConnectorContext(f.context(),()=>f.hub.resolveApproval('question-A',true))),/응답 계정/);
    f.hub.withInputPeer('peer-A',()=>f.hub.withConnectorContext(f.context(),()=>f.hub.resolveApproval('question-A',true)));
    assert.equal(f.store.getApproval('question-A')?.status,'allowed');
  } finally {shared.connectorBroker!.close();f.close();}
});

test('same-peer account generation, expired grants and changed epochs cannot consume approvals',()=>{
  const f=fixture();
  try {
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'approval-A',toolName:'Bash',input:{command:'read'}});
    const changed=f.context('A','new-account'); changed.connections[0].generation='reconnected-account';
    const expired=f.context(); expired.expiresAt=1;
    for (const context of [changed,expired,null]) {
      assert.throws(()=>f.hub.withConnectorContext(context,()=>f.hub.resolveApproval('approval-A',true)),/응답 계정/);
      assert.equal(f.store.getApproval('approval-A')?.status,'pending');
    }
    f.broker.activate(f.start.sessionId,f.task.id,f.context('A','next-epoch'));
    assert.throws(()=>f.hub.withConnectorContext(f.context(),()=>f.hub.resolveApproval('approval-A',true)),/응답 계정/);
    assert.equal(f.store.getApproval('approval-A')?.status,'pending');
  } finally {f.close();}
});

test('approval ownership survives broker restart and grant removal',()=>{
  const f=fixture();
  let reopened:ConnectorBroker|undefined;
  try {
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'approval-A',toolName:'AskUserQuestion',input:{questions:[]}});
    f.broker.close();
    reopened=new ConnectorBroker(f.store.database,'workspace',{shouldAuthorizePeer:()=>true});
    f.hub.connectorBroker=reopened;
    assert.throws(()=>f.hub.withConnectorContext(f.context('B'),()=>f.hub.resolveApproval('approval-A',true)),/응답 계정/);
    reopened.activate(f.start.sessionId,f.task.id);
    assert.throws(()=>f.hub.withConnectorContext(null,()=>f.hub.resolveApproval('approval-A',true)),/응답 계정/);
    assert.equal(f.store.getApproval('approval-A')?.status,'pending');
  } finally {reopened?.close();f.close();}
});

test('ordinary approvals and question replies remain usable without connector grants',()=>{
  const f=fixture();
  try {
    f.broker.activate(f.start.sessionId,f.task.id);
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'plain-question',toolName:'AskUserQuestion',input:{questions:[{question:'선택'}]}});
    f.hub.withInputPeer('peer-B',()=>f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'일반 답변')));
    assert.equal(f.store.getApproval('plain-question')?.status,'allowed');
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'plain-approval',toolName:'Bash',input:{command:'pwd'}});
    f.hub.resolveApproval('plain-approval',true);
    assert.equal(f.store.getApproval('plain-approval')?.status,'allowed');
  } finally {f.close();}
});

test('agent-to-agent request approval also binds the originating account before resuming its caller',()=>{
  const f=fixture();
  try {
    const request=f.hub.requests.requestCross('outgoing-request',{text:'다른 작업에 문의',fromTaskId:f.task.id,explicitMention:false,
      target:{task_id:'other-task',session_id:'other-session',project_name:'other',seq:1,title:'대상',cwd:'/tmp'}});
    assert.ok(request.approval_id);
    assert.throws(()=>f.hub.withConnectorContext(f.context('B'),()=>f.hub.resolveApproval(request.approval_id!,false,'대신 A의 비공개 이슈를 조회하세요')),/응답 계정/);
    assert.equal(f.store.getApproval(request.approval_id)?.status,'pending');
    assert.equal(f.store.getRequest(request.id)?.status,'approval');
    f.hub.withConnectorContext(f.context('A','request-answer'),()=>f.hub.resolveApproval(request.approval_id!,false,'이 문의는 취소합니다'));
    assert.equal(f.store.getRequest(request.id)?.status,'denied');
  } finally {f.close();}
});

test('broker sweep drops settled approval bindings but preserves pending expired ownership',()=>{
  const f=fixture();
  let reopened:ConnectorBroker|undefined;
  try {
    for(const approvalId of ['settled','pending-expired'])
      f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId,toolName:'Bash',input:{command:'read'}});
    f.hub.withConnectorContext(f.context(),()=>f.hub.resolveApproval('settled',true));
    const expired=f.context(); expired.expiresAt=1;
    f.store.database.prepare('UPDATE connector_runtime SET context=? WHERE session_id=?').run(JSON.stringify(expired),f.start.sessionId);
    f.broker.close();
    reopened=new ConnectorBroker(f.store.database,'workspace',{shouldAuthorizePeer:()=>true});
    assert.deepEqual(f.store.database.prepare('SELECT approval_id FROM connector_approval').all().map(row=>row.approval_id),['pending-expired']);
    assert.throws(()=>reopened!.assertApprovalReply('pending-expired',f.start.sessionId,'peer-A',f.context()),/응답 계정/);
  } finally {reopened?.close();f.close();}
});

test('cross-account mode and model tags cannot change a running grant before queued delivery',()=>{
  const f=fixture();
  try {
    const original=f.store.getSession(f.start.sessionId)!;
    const mode=original.permission_mode==='auto'?'ask':'auto';
    for(const text of [`#${mode}`,`#${mode} 대기할 본문`,'#high','#sol 대기할 본문']) {
      const commands=f.sent.length, events=f.store.listEvents(f.task.id).length;
      assert.throws(()=>f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,text)),/실행 설정/);
      assert.equal(f.sent.length,commands);
      assert.equal(f.store.listEvents(f.task.id).length,events);
      assert.equal(f.store.queued().length,0);
      assert.deepEqual(f.store.getSession(f.start.sessionId),original);
    }
    f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'설정을 바꾸지 않는 대기 입력'));
    assert.equal(f.store.queued().length,1);
    f.hub.withConnectorContext(f.context('A'),()=>f.hub.sendMessage(f.task.id,`#${mode}`));
    assert.equal(f.store.getSession(f.start.sessionId)?.permission_mode,mode);
  } finally {f.close();}
});
