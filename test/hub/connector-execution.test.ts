import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../hub/src/hub.ts';
import { Store } from '../../hub/src/db.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { ConnectorBroker, type ConnectorExecutionContext } from '../../hub/src/connector-broker.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { codexMcpProcess, claudeMcpOptions } from '../../hub/src/runner/managed-mcp.ts';
import { RunnerClient } from '../../hub/src/runner/client.ts';
import { readLines, writeLine } from '../../hub/src/runner/wire.ts';
import { MODE_LABEL } from '../../shared/compose.ts';
import { checkHubToRunner, type HubToRunner, type RunnerToHub } from '../../shared/protocol.ts';

function fixture(scoped = false) {
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
    expiresAt:Date.now()+60_000,connections:[{service:'jira',generation:peer,tools:['getJiraIssue']}],...(scoped&&{inputScoped:true as const})});
  const task=hub.withConnectorContext(context(),()=>hub.compose(`@fixture:${dir} #codex 시작`));
  const start=sent[0] as Extract<HubToRunner,{type:'start'}>;
  if (start.connectorMcp) broker.markScopedTools(start.connectorMcp.token);
  return {hub,store,broker,sent,say,context,task,start,
    close:()=>{hub.dispose();store.database.close();rmSync(dir,{recursive:true,force:true});}};
}

test('tagged requests require their input id and untagged steering revokes previous tool access',async()=>{
  const f=fixture(true);
  try {
    assert.match(f.start.prompt,/request_id=first/);
    await assert.rejects(f.broker.invoke(f.start.connectorMcp!.token,'list'),/request_id/);
    await assert.rejects(f.broker.invoke(f.start.connectorMcp!.token,'list',{request_id:'another'}),/request_id/);
    const pending=f.broker.invoke(f.start.connectorMcp!.token,'list',{request_id:'first'});
    const cancelled=assert.rejects(pending,/문맥|만료/);
    f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'#now 일반 대화'));
    assert.equal(f.store.queued().length,0);
    assert.equal(f.sent.at(-1)?.type,'send');
    assert.equal(f.broker.stored(f.start.sessionId),undefined);
    await cancelled;
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list',{request_id:'first'}),{connections:[]});
  } finally {f.close();}
});

test('a fresh tagged input cannot be borrowed by old background calls and ends with the turn',async()=>{
  const f=fixture(true);
  try {
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[{id:'old',type:'local_agent',description:'이전 요청'}]});
    f.hub.withConnectorContext(f.context('B','second'),()=>f.hub.sendMessage(f.task.id,'#now #jira 새 조회'));
    assert.equal(f.store.queued().length,0);
    const send=f.sent.at(-1) as Extract<HubToRunner,{type:'send'}>;
    assert.match(send.text,/request_id=second/);
    await assert.rejects(f.broker.invoke(f.start.connectorMcp!.token,'list',{request_id:'first'}),/request_id/);
    const pending=f.broker.invoke(f.start.connectorMcp!.token,'list',{request_id:'second'});
    const [job]=f.broker.poll('peer-B');assert.ok(job);
    f.broker.complete('peer-B',job.callId,{result:{connections:['jira']}});
    await pending;
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[]});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.broker.stored(f.start.sessionId),undefined);
  } finally {f.close();}
});

test('an untagged answer continues the original scoped question without minting another grant',()=>{
  const f=fixture(true);
  try {
    f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'scoped-question',toolName:'AskUserQuestion',input:{questions:[{question:'어느 이슈?'}]}});
    const identity={hubId:'hub-A',connections:[{service:'jira' as const,generation:'A'}]};
    assert.throws(()=>f.hub.withInputPeer('peer-B',()=>f.hub.withConnectorIdentity(identity,()=>f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'TEST-1')))),/응답 계정/);
    f.hub.withInputPeer('peer-A',()=>f.hub.withConnectorIdentity(identity,()=>f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'TEST-1'))));
    assert.equal(f.store.getApproval('scoped-question')?.status,'allowed');
    assert.equal(f.broker.stored(f.start.sessionId)?.requestId,'first');
  } finally {f.close();}
});

test('older cached tool schemas reject tagged input before changing engine settings',()=>{
  const f=fixture();
  try {
    f.store.database.prepare('UPDATE connector_runtime SET scoped_tools=0 WHERE session_id=?').run(f.start.sessionId);
    const before=f.sent.length,session=f.store.getSession(f.start.sessionId);
    assert.throws(()=>f.hub.withConnectorContext({...f.context(),inputScoped:true},()=>f.hub.sendMessage(f.task.id,'#now #jira #high 조회')),/이전 외부 도구 목록/);
    assert.equal(f.sent.length,before);
    assert.deepEqual(f.store.getSession(f.start.sessionId),session);
  } finally {f.close();}
});

test('a new input waits for pending approval and cannot invalidate either approve or deny',()=>{
  for(const allow of [true,false]) {
    const f=fixture(true);
    try {
      f.say({type:'approval_request',sessionId:f.start.sessionId,approvalId:'held',toolName:'Bash',input:{command:'read'}});
      f.hub.withInputPeer('peer-A',()=>f.hub.withConnectorContext(null,()=>f.hub.sendMessage(f.task.id,'#now 일반 입력')));
      const q=f.store.queued()[0];assert.ok(q);
      assert.throws(()=>f.hub.sendQueuedNow(f.task.id,q.id),/승인·질문/);
      assert.equal(f.broker.stored(f.start.sessionId)?.requestId,'first');
      f.hub.withInputPeer('peer-A',()=>f.hub.withConnectorIdentity({hubId:'hub-A',connections:[{service:'jira',generation:'A'}]},
        ()=>f.hub.withConnectorContext(null,()=>f.hub.resolveApproval('held',allow))));
      assert.equal(f.store.getApproval('held')?.status,allow?'allowed':'denied');
      f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
      assert.equal(f.store.queued().length,0);
    } finally {f.close();}
  }
});

test('shared input discards legacy automatic grants and rejects tagged legacy requests',async()=>{
  const f=fixture(),workspace=new SharedWorkspace(f.hub,undefined,{localAuthority:true});
  try {
    const peer=workspace.grant('legacy'),operationId=crypto.randomUUID();
    const grant={...f.context(),workspaceId:workspace.id,requestId:operationId};
    const op={id:operationId,method:'POST',path:'/compose',body:{text:`@legacy:${f.start.cwd} #codex 일반 대화`,__desk_connector_grant:grant}};
    const result=workspace.execute(peer.id,op);assert.equal(result.status,201);
    const start=f.sent.at(-1) as Extract<HubToRunner,{type:'start'}>;
    assert.equal(workspace.connectorBroker!.stored(start.sessionId),undefined);
    assert.deepEqual(await workspace.connectorBroker!.invoke(start.connectorMcp!.token,'list'),{connections:[]});
    const tagged=crypto.randomUUID();
    assert.throws(()=>workspace.execute(peer.id,{...op,id:tagged,body:{...op.body,text:`@legacy #slack 읽어줘`,__desk_connector_grant:{...grant,requestId:tagged}}}),/허브를 업데이트/);
    assert.deepEqual(workspace.execute(peer.id,op),JSON.parse(JSON.stringify(result)));
    const foreign=workspace.grant('foreign');
    assert.throws(()=>workspace.execute(foreign.id,op),/다른 허브/);
  } finally {workspace.connectorBroker!.close();f.close();}
});

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

test('expired queued authority delivers text without tools once the active turn ends',async()=>{
  const f=fixture();
  try {
    f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'보관할 메시지'));
    const q=f.store.queued()[0];q.connector_context!.expiresAt=1;
    f.store.database.prepare('UPDATE queued SET connector_context_json=? WHERE id=?').run(JSON.stringify(q.connector_context),q.id);
    // A still-authorized running turn must not lend its account to an expired input.
    assert.throws(()=>f.hub.sendQueuedNow(f.task.id,q.id),/만료/);
    assert.equal(f.store.queued().length,1);
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.queued().length,0);
    const send=f.sent.at(-1) as Extract<HubToRunner,{type:'send'}>;
    assert.equal(send.type,'send');assert.match(send.text,/보관할 메시지/);
    assert.match(send.text,/조회는 활성화하지 않았습니다/);
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list'),{connections:[]});
    assert.match(JSON.stringify(f.store.listEvents(f.task.id)),/메시지는 전달했습니다/);
  } finally {f.close();}
});

test('expired previous grants allow same-account steering without renewing background authority',async()=>{
  const f=fixture();
  try {
    const expired=f.context();expired.expiresAt=1;
    f.store.database.prepare('UPDATE connector_runtime SET context=? WHERE session_id=?').run(JSON.stringify(expired),f.start.sessionId);
    f.hub.withConnectorContext(f.context('A','new-input'),()=>f.hub.sendMessage(f.task.id,'#now 같은 계정'));
    assert.equal(f.store.queued().length,0);
    const send=f.sent.at(-1) as Extract<HubToRunner,{type:'send'}>;
    assert.equal(send.type,'send');assert.equal(send.steer,true);
    assert.match(send.text,/같은 계정/);assert.match(send.text,/조회는 활성화하지 않았습니다/);
    await assert.rejects(f.broker.invoke(f.start.connectorMcp!.token,'list'),/만료/);
    assert.throws(()=>f.hub.withConnectorContext(f.context(),()=>f.hub.sendMessage(f.task.id,'#high')),/실행 설정/);
  } finally {f.close();}
});

test('ordinary follow-ups during background work need no new external authority',async()=>{
  const f=fixture();
  try {
    f.broker.activate(f.start.sessionId,f.task.id);
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[{id:'bench',type:'local_bash',description:'측정 종료 대기'}]});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    f.hub.withConnectorContext(f.context('B','question'),()=>f.hub.sendMessage(f.task.id,'러너 재시작해도 되나요?'));
    assert.equal(f.store.queued().length,0);
    const send=f.sent.at(-1) as Extract<HubToRunner,{type:'send'}>;
    assert.equal(send.type,'send');assert.match(send.text,/러너 재시작해도 되나요/);
    assert.equal(f.broker.stored(f.start.sessionId),undefined);
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list'),{connections:[]});
    // A later input can activate fresh authority only after all work has ended.
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[]});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    f.hub.withConnectorContext(f.context('B','read'),()=>f.hub.sendMessage(f.task.id,'이제 조회하세요'));
    assert.equal(f.broker.stored(f.start.sessionId)?.requestId,'read');
  } finally {f.close();}
});

test('grant expiry retries waiting text while background work remains, without installing a new grant',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:Date.now()});
  const f=fixture();
  try {
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[{id:'bench',type:'local_bash',description:'측정 종료 대기'}]});
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    f.hub.withConnectorContext(f.context('B','queued'),()=>f.hub.sendMessage(f.task.id,'측정 진행은 어떤가요?'));
    assert.equal(f.store.queued().length,1);
    const before=f.sent.length;
    t.mock.timers.tick(60_001);
    assert.equal(f.store.queued().length,0);
    assert.equal(f.sent.length,before+1);
    const send=f.sent.at(-1) as Extract<HubToRunner,{type:'send'}>;
    assert.equal(send.type,'send');assert.match(send.text,/측정 진행은 어떤가요/);
    assert.deepEqual(await f.broker.invoke(f.start.connectorMcp!.token,'list'),{connections:[]});
    t.mock.timers.tick(60_000);
    assert.equal(f.sent.length,before+1);
  } finally {f.close();}
});

test('text-only delivery does not release queued session resets into background work',()=>{
  const f=fixture();
  try {
    f.say({type:'background',sessionId:f.start.sessionId,tasks:[{id:'bench',type:'local_bash',description:'측정 종료 대기'}]});
    f.hub.withConnectorContext(f.context(),()=>f.hub.resetContext(f.task.id,'새 세션'));
    f.store.database.prepare('UPDATE connector_runtime SET context=NULL WHERE session_id=?').run(f.start.sessionId);
    const commands=f.sent.length;
    f.say({type:'busy',sessionId:f.start.sessionId,busy:false});
    assert.equal(f.store.queued().length,1);
    assert.equal(f.sent.length,commands);
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
  const ipv6DeskMcpUrl='http://[::1]:17641/mcp';
  assert.equal(typeof checkHubToRunner({...start,ipv6DeskMcpUrl,connectorMcp:{...connector,url:'http://[::1]:17641/v1/connector-mcp'}}),'object');
  for(const url of ['https://remote/v1/connector-mcp','http://127.0.0.1:4321/other','http://user@127.0.0.1/v1/connector-mcp',
    'http://[::]:17641/v1/connector-mcp','http://[::1]:65536/v1/connector-mcp','http://[::1]:17641/v1/connector-mcp\n'])
    assert.equal(typeof checkHubToRunner({...start,connectorMcp:{...connector,url}}),'string');
  for(const url of ['http://[::]:17641/mcp','http://[::1]:0/mcp','http://[::1]:17641/mcp?other=1','http://127.0.0.1:17641/mcp'])
    assert.equal(typeof checkHubToRunner({...start,ipv6DeskMcpUrl:url}),'string');
});

test('an older local runner accepts ordinary starts on an IPv6 hub without receiving connector credentials', { timeout: 5000 }, async t => {
  const commands: unknown[] = [];
  const events = new EventEmitter();
  const server = createServer(socket => readLines(socket, message => {
    if ((message as HubToRunner).type === 'auth') writeLine(socket, {
      type: 'hello', runnerId: 'legacy', host: 'local', sessions: [], protocolVersion: 1,
      capabilities: { engines: ['codex'], connectorMcp: true },
    } satisfies RunnerToHub);
    else { commands.push(message); events.emit('command'); }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connected = once(events, 'connected', { signal: t.signal });
  const client = new RunnerClient(() => {}, up => { if (up) events.emit('connected'); }, {
    port: (server.address() as AddressInfo).port, token: () => 'fixture', spawnIfMissing: false,
    ipv6DeskMcpUrl: () => 'http://[::1]:17641/mcp',
  });
  try {
    await connected;
    assert.equal(client.connectorMcpSupported, false);
    const start = { type: 'start', sessionId: 'old', cwd: tmpdir(), engine: 'codex', prompt: 'test', permissionMode: 'auto' } as const;
    assert.throws(() => client.handle({ ...start, connectorMcp: {
      url: 'http://[::1]:17641/v1/connector-mcp', token: 'a'.repeat(43),
    } }), /로컬 러너를 업데이트/);
    const received = once(events, 'command', { signal: t.signal });
    client.handle(start);
    await received;
    assert.deepEqual(commands, [start]);
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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
    const mode = original.permission_mode === 'auto' ? 'default' : 'auto';
    const tag = MODE_LABEL[mode];
    for(const text of [tag,`${tag} 대기할 본문`,'#high','#sol 대기할 본문']) {
      const commands=f.sent.length, events=f.store.listEvents(f.task.id).length;
      assert.throws(()=>f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,text)),/실행 설정/);
      assert.equal(f.sent.length,commands);
      assert.equal(f.store.listEvents(f.task.id).length,events);
      assert.equal(f.store.queued().length,0);
      assert.deepEqual(f.store.getSession(f.start.sessionId),original);
    }
    f.hub.withConnectorContext(f.context('B'),()=>f.hub.sendMessage(f.task.id,'설정을 바꾸지 않는 대기 입력'));
    assert.equal(f.store.queued().length,1);
    f.hub.withConnectorContext(f.context('A'),()=>f.hub.sendMessage(f.task.id,tag));
    assert.equal(f.store.getSession(f.start.sessionId)?.permission_mode,mode);
  } finally {f.close();}
});
