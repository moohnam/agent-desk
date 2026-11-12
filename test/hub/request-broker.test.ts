import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { handleWorkspaceBroker, handleBrokerMcp, closeRequestBroker } from '../../hub/src/request-broker.ts';
import { HttpError } from '../../hub/src/errors.ts';
import type { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import { WorkspaceLinks as WorkspaceLinksRuntime } from '../../hub/src/workspace-links.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { Access } from '../../hub/src/access.ts';
import { createHttpServer } from '../../hub/src/http.ts';

function owner(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `desk-broker-${name}-`));
  const store = new Store(join(dir, 'owner.db'));
  const sent: unknown[] = [];
  const hub = new Hub(store, { skills: new SkillStore(join(dir, 'skills')),
    runner: () => ({ connected: true, id: name, engines: new Set(['claude']), has: () => false,
      handle: command => { sent.push(command); } }) });
  const project = hub.createProject(name, dir);
  const task = hub.createTask(project.id, `${name} task`, '일하세요', 'default', 'claude');
  const session = store.latestSession(task.id)!;
  hub.busy.delete(session.id);
  return { dir, store, hub, task, session, sent, close() { hub.dispose(); store.database.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function peer(o: ReturnType<typeof owner>) {
  return { task_id: o.task.id, session_id: o.session.id, project_name: o.task.project_name,
    seq: o.task.seq, title: o.task.title, cwd: o.session.cwd };
}
function rpc(links: WorkspaceLinks, body: unknown) {
  const req = { method: 'POST' } as IncomingMessage;
  const res = new EventEmitter() as ServerResponse & { output?: string };
  res.writeHead = (() => res) as ServerResponse['writeHead'];
  res.end = ((chunk?: string) => { res.output = chunk; res.emit('close'); return res; }) as ServerResponse['end'];
  return handleBrokerMcp(links, 'origin', body, req, res).then(handled => {
    assert.equal(handled, true);
    return JSON.parse(res.output!).result as { content: { text: string }[]; isError?: boolean };
  });
}

test('cross-source request keeps approval at origin, delivery and final turn at target, and replays once', async () => {
  const from = owner('from'), to = owner('to'), gateway = new Store(':memory:');
  to.store.updateSession(to.session.id, { engine_session_id: 'target-engine-session' });
  let replySource = '';
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { return (id === 'origin' ? from.hub : to.hub).atomic(() =>
        handleWorkspaceBroker(id === 'origin' ? from.hub : to.hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    },
    proxyMcp: async (source: string, _req: unknown, res: ServerResponse, body: any) => {
      assert.equal(body.params.name, 'desk_reply');
      replySource = source;
      const a = body.params.arguments;
      to.hub.requests.replyRequest(a.question_id, a.answer, a.session_id);
      res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        result: { content: [{ type: 'text', text: '전달했습니다' }] } }));
    },
  } as unknown as WorkspaceLinks;
  try {
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: '대상에게 물어봐 주세요' });
    const args = { to: `@${to.task.project_name}#${to.task.seq}`, question: '결과를 알려 주세요', task_id: from.task.id, timeout_sec: 1 };
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request', arguments: args } };
    const first = await rpc(links, request);
    const match = /question_id: "([^"]+)"/.exec(first.content[0].text)!;
    assert.ok(match);
    const id = match[1];
    assert.equal(from.store.getRequest(id)?.status, 'approval');
    assert.equal(to.store.getRequest(id), undefined);
    assert.equal(from.store.pendingApprovals().length, 1);
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: '다른 에이전트의 질문',
      request: { id: 'inbound', task_id: to.task.id, from: 'to', title: 'to' } });
    const again = await rpc(links, request);
    assert.match(again.content[0].text, new RegExp(id));
    assert.equal(from.store.pendingApprovals().length, 1);
    from.hub.resolveApproval(from.store.pendingApprovals()[0].id, true);
    const waiting = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_wait_answer', arguments: { question_id: id, timeout_sec: 1 } } };
    const pending = rpc(links, waiting);
    const targetRequest = await new Promise<ReturnType<typeof to.store.getRequest>>((resolve, reject) => {
      const until = Date.now() + 1000;
      const check = () => { const r = to.store.getRequest(id); if (r) resolve(r);
        else if (Date.now() > until) reject(Error('target did not receive')); else setTimeout(check, 10); };
      check();
    });
    assert.equal(targetRequest?.status, 'running');
    assert.equal(handleWorkspaceBroker(to.hub, 'lookup', { kind: 'request', id }).status, 404,
      'the target copy must not look like the owner of desk_wait_answer');
    const event = to.store.listEvents(to.task.id).find(e => e.kind === 'user' && (e.payload as any).request?.id === id);
    assert.ok(event);
    assert.match((to.sent.at(-1) as { prompt: string }).prompt, new RegExp(id));
    to.hub.addEvent(to.session.id, to.task.id, 'assistant', { text: '최종 답변' });
    await rpc(links, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'desk_reply',
      arguments: { question_id: id, answer: '명시적 답변', session_id: 'target-engine-session' } } });
    assert.equal(replySource, 'target');
    to.hub.requests.answerRequests(to.session.id);
    const answered = await pending;
    assert.match(answered.content[0].text, /명시적 답변/);
    assert.equal(from.store.getRequest(id)?.status, 'answered');
    assert.equal(to.store.getRequest(id)?.status, 'answered');
    assert.equal(to.store.listEvents(to.task.id).filter(e => e.kind === 'user' && (e.payload as any).request?.id === id).length, 1);
    const completedRetry = await rpc(links, request);
    assert.match(completedRetry.content[0].text, /명시적 답변/);
    assert.equal(from.store.pendingApprovals().length, 0);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('desk_wait_answer for a user question routes to its owning workspace', async () => {
  const from = owner('question-origin'), other = owner('question-other'), gateway = new Store(':memory:');
  const questionId = randomUUID();
  from.store.createQuestion({ id: questionId, task_id: from.task.id, session_id: from.session.id,
    text: '사용자 질문', status: 'answered', answer: '사용자 답', created_at: new Date().toISOString(), answered_at: new Date().toISOString() });
  let proxied = '';
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'other' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { const hub = id === 'origin' ? from.hub : other.hub;
        return hub.atomic(() => handleWorkspaceBroker(hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    },
    proxyMcp: async (source: string, _req: unknown, res: ServerResponse) => {
      proxied = source;
      res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '사용자 답변:\n사용자 답' }] } }));
    } } as unknown as WorkspaceLinks;
  try {
    const answer = await rpc(links, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_wait_answer',
      arguments: { question_id: questionId, timeout_sec: 1 } } });
    assert.equal(proxied, 'origin');
    assert.match(answer.content[0].text, /사용자 답/);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); other.close(); }
});

test('cross-source approval denial never reaches target; only a verified user mention skips approval', () => {
  const from = owner('asking'), to = owner('answering');
  try {
    const id = randomUUID();
    const r = from.hub.requests.requestCross(id, { text: '질문', fromTaskId: from.task.id, target: peer(to), explicitMention: true });
    assert.equal(r.status, 'approval');
    from.hub.resolveApproval(r.approval_id!, false, '지금은 안 됩니다');
    assert.equal(from.store.getRequest(id)?.status, 'denied');
    assert.equal(to.store.getRequest(id), undefined);
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: `@answering#${to.task.seq}에게 질문하세요` });
    const next = from.hub.requests.requestCross(randomUUID(), { text: '질문 2', fromTaskId: from.task.id, target: peer(to), explicitMention: true });
    assert.equal(next.status, 'queued');
    assert.equal(next.approval_id, null);
  } finally { from.close(); to.close(); }
});

test('cross-source receive rejects an Antigravity target before storing a question', () => {
  const from = owner('agy-asker'), to = owner('agy-target');
  try {
    to.store.database.prepare('UPDATE session SET engine=? WHERE id=?').run('agy', to.session.id);
    const id = randomUUID();
    assert.throws(() => to.hub.requests.receiveCross(id, { text: '질문', from: peer(from), toTaskId: to.task.id }), /desk_reply 연결을 지원하지 않아/);
    assert.equal(to.store.getRequest(id), undefined);
  } finally { from.close(); to.close(); }
});

test('cross-source receive replays a matching old request even after its target changes to Antigravity', () => {
  const from = owner('agy-replay-asker'), to = owner('agy-replay-target');
  try {
    const id = randomUUID();
    const input = { text: '기존 질문', from: peer(from), toTaskId: to.task.id };
    const original = to.hub.requests.receiveCross(id, input);
    to.store.database.prepare('UPDATE session SET engine=? WHERE id=?').run('agy', to.session.id);
    assert.deepEqual(to.hub.requests.receiveCross(id, input), original);
    assert.throws(() => to.hub.requests.receiveCross(id, { ...input, text: '바뀐 질문' }), /같은 요청 ID의 내용이 바뀌었습니다/);
    assert.throws(() => to.hub.requests.receiveCross(randomUUID(), input), /desk_reply 연결을 지원하지 않아/);
  } finally { from.close(); to.close(); }
});

test('a later user mention does not approve an earlier cross-source request', async () => {
  const from = owner('mention-race-origin'), to = owner('mention-race-target'), gateway = new Store(':memory:');
  let addedLaterMention = false;
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try {
        const hub = id === 'origin' ? from.hub : to.hub;
        const response = hub.atomic(() => handleWorkspaceBroker(hub, path.split('/').at(-1)!, body));
        if (id === 'target' && path.endsWith('/lookup') && body.kind === 'target' && !addedLaterMention) {
          addedLaterMention = true;
          from.hub.addEvent(from.session.id, from.task.id, 'user', { text: `@${to.task.project_name}#${to.task.seq}에게 물어보세요` });
        }
        return response;
      } catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: '먼저 알아봐 주세요' });
    const response = await rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: `@${to.task.project_name}#${to.task.seq}`, question: '원래 질문', task_id: from.task.id, timeout_sec: 1 } } });
    assert.equal(addedLaterMention, true);
    const id = /question_id: "([^"]+)"/.exec(response.content[0].text)![1];
    assert.equal(from.store.getRequest(id)?.status, 'approval');
    assert.equal(from.store.pendingApprovals().length, 1);
    assert.equal(to.store.getRequest(id), undefined);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('cross-source cycle detection includes local requests between remote edges', async () => {
  const from = owner('cycle-origin'), to = owner('cycle-target'), gateway = new Store(':memory:');
  const middle = to.hub.createTask(to.task.project_id, 'middle task', '일하세요', 'default', 'claude');
  const middleSession = to.store.latestSession(middle.id)!;
  to.hub.busy.delete(middleSession.id);
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { const hub = id === 'origin' ? from.hub : to.hub;
        return hub.atomic(() => handleWorkspaceBroker(hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: `@${to.task.project_name}#${to.task.seq}에게 물어보세요` });
    const first = await rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: to.task.id, question: 'A에서 B로', task_id: from.task.id, timeout_sec: 1 } } });
    const firstId = /question_id: "([^"]+)"/.exec(first.content[0].text)![1];
    assert.equal(to.store.getRequest(firstId)?.status, 'running');
    const local = to.hub.requests.request({ to: middle.id, text: 'B에서 C로', fromTaskId: to.task.id });
    assert.equal(local.status, 'approval');
    to.hub.resolveApproval(local.approval_id!, true);
    assert.equal(to.store.getRequest(local.id)?.status, 'running');
    const last = await rpc(links, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: from.task.id, question: 'C에서 A로', task_id: middle.id, timeout_sec: 1 } } });
    assert.match(last.content[0].text, /서로 답을 기다리는 질문/);
    assert.equal(to.store.pendingApprovals().length, 0);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('approval-time cross requests are checked again before first delivery', async () => {
  const from = owner('late-cycle-origin'), to = owner('late-cycle-target'), gateway = new Store(':memory:');
  const middle = to.hub.createTask(to.task.project_id, 'middle task', '일하세요', 'default', 'claude');
  to.hub.busy.delete(to.store.latestSession(middle.id)!.id);
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { const hub = id === 'origin' ? from.hub : to.hub;
        return hub.atomic(() => handleWorkspaceBroker(hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  const ask = (taskId: string, targetId: string, text: string, id: number) => rpc(links,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: targetId, question: text, task_id: taskId, timeout_sec: 1 } } });
  try {
    const ab = /question_id: "([^"]+)"/.exec((await ask(from.task.id, to.task.id, 'A에서 B로', 1)).content[0].text)![1];
    const ca = /question_id: "([^"]+)"/.exec((await ask(middle.id, from.task.id, 'C에서 A로', 2)).content[0].text)![1];
    const bc = to.hub.requests.request({ to: middle.id, text: 'B에서 C로', fromTaskId: to.task.id });
    assert.equal(from.store.getRequest(ab)?.status, 'approval');
    assert.equal(to.store.getRequest(ca)?.status, 'approval');
    assert.equal(bc.status, 'approval');
    from.hub.resolveApproval(from.store.getRequest(ab)!.approval_id!, true);
    to.hub.resolveApproval(to.store.getRequest(ca)!.approval_id!, true);
    to.hub.resolveApproval(bc.approval_id!, true);
    const answer = await rpc(links, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'desk_wait_answer',
      arguments: { question_id: ab, timeout_sec: 1 } } });
    assert.match(answer.content[0].text, /서로 답을 기다리는 질문/);
    assert.equal(from.store.getRequest(ab)?.status, 'failed');
    assert.equal(to.store.getRequest(ab), undefined, 'an uncreated target copy must not be delivered');
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('a lost receive reply reuses the delivered target request', async () => {
  const from = owner('lost-reply-origin'), to = owner('lost-reply-target'), gateway = new Store(':memory:');
  to.store.updateSession(to.session.id, { engine_session_id: 'lost-reply-engine' });
  let loseReply = true;
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try {
        const hub = id === 'origin' ? from.hub : to.hub;
        const action = path.split('/').at(-1)!;
        const result = hub.atomic(() => handleWorkspaceBroker(hub, action, body));
        if (id === 'target' && action === 'receive' && loseReply) {
          loseReply = false;
          return { status: 503, body: { error: 'reply lost after receive' } };
        }
        return result;
      } catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: `@${to.task.project_name}#${to.task.seq}에게 물어보세요` });
    const first = await rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: to.task.id, question: '한 번만 전달', task_id: from.task.id, timeout_sec: 1 } } });
    const id = /question_id: "([^"]+)"/.exec(first.content[0].text)![1];
    assert.equal(to.store.getRequest(id)?.status, 'running');
    assert.equal(to.store.listEvents(to.task.id).filter(e => e.kind === 'user' && (e.payload as any).request?.id === id).length, 1);
    const waiting = rpc(links, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_wait_answer',
      arguments: { question_id: id, timeout_sec: 2 } } });
    to.hub.requests.replyRequest(id, '한 번 보낸 답', 'lost-reply-engine');
    to.hub.requests.answerRequests(to.session.id);
    assert.match((await waiting).content[0].text, /한 번 보낸 답/);
    assert.equal(from.store.getRequest(id)?.status, 'answered');
    assert.equal(to.store.listEvents(to.task.id).filter(e => e.kind === 'user' && (e.payload as any).request?.id === id).length, 1);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('ambiguous @project target is rejected before any approval card is created', async () => {
  const from = owner('origin'), first = owner('duplicate'), second = owner('duplicate'), gateway = new Store(':memory:');
  const hubs: Record<string, Hub> = { origin: from.hub, first: first.hub, second: second.hub };
  const links = { database: gateway.database, list: () => Object.keys(hubs).map(id => ({ id })),
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { return hubs[id].atomic(() => handleWorkspaceBroker(hubs[id], path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    const answer = await rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: '@duplicate#1', question: '질문', task_id: from.task.id, timeout_sec: 1 } } });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /여러 작업공간/);
    assert.equal(from.store.pendingApprovals().length, 0);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); first.close(); second.close(); }
});

test('target outage leaves a durable pending request and wait delivers it after reconnect', async () => {
  const from = owner('outage-origin'), to = owner('outage-target'), gateway = new Store(':memory:');
  to.store.updateSession(to.session.id, { engine_session_id: 'outage-engine' });
  let targetOnline = false;
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      const action = path.split('/').at(-1)!;
      if (id === 'target' && action === 'receive' && !targetOnline) return { status: 503, body: { error: 'target offline' } };
      try { const hub = id === 'origin' ? from.hub : to.hub;
        return hub.atomic(() => handleWorkspaceBroker(hub, action, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    from.hub.addEvent(from.session.id, from.task.id, 'user', { text: `@outage-target#1에게 확인하세요` });
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: '@outage-target#1', question: '상태?', task_id: from.task.id, timeout_sec: 1 } } };
    const pending = await rpc(links, request);
    const id = /question_id: "([^"]+)"/.exec(pending.content[0].text)![1];
    assert.equal(from.store.getRequest(id)?.status, 'queued');
    assert.equal(to.store.getRequest(id), undefined);
    targetOnline = true;
    const waiting = rpc(links, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'desk_wait_answer',
      arguments: { question_id: id, timeout_sec: 1 } } });
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 1000;
      const check = () => { if (to.store.getRequest(id)) resolve();
        else if (Date.now() > until) reject(Error('delivery did not recover')); else setTimeout(check, 10); };
      check();
    });
    to.hub.requests.replyRequest(id, '복구 후 답변', 'outage-engine');
    to.hub.requests.answerRequests(to.session.id);
    assert.match((await waiting).content[0].text, /복구 후 답변/);
    assert.equal(from.store.getRequest(id)?.status, 'answered');
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('same-source request keeps the owner MCP path', async () => {
  const ownerHub = owner('same'), gateway = new Store(':memory:');
  let proxied = '';
  const links = { database: gateway.database, list: () => [{ id: 'same' }],
    trustedCall: async (_id: string, path: string, body: Record<string, unknown>) => {
      try { return ownerHub.hub.atomic(() => handleWorkspaceBroker(ownerHub.hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    },
    proxyMcp: async (source: string, _req: unknown, res: ServerResponse) => {
      proxied = source;
      res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '기존 경로' }] } }));
    } } as unknown as WorkspaceLinks;
  try {
    const answer = await rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: ownerHub.task.id, question: '질문', task_id: ownerHub.task.id, timeout_sec: 1 } } });
    assert.equal(proxied, 'same');
    assert.equal(answer.content[0].text, '기존 경로');
  } finally { await closeRequestBroker(links); gateway.database.close(); ownerHub.close(); }
});

test('closing the broker releases an active long MCP wait before its database closes', async () => {
  const from = owner('closing-origin'), to = owner('closing-target'), gateway = new Store(':memory:');
  const links = { database: gateway.database, list: () => [{ id: 'origin' }, { id: 'target' }],
    trustedCall: async (id: string, path: string, body: Record<string, unknown>) => {
      try { const hub = id === 'origin' ? from.hub : to.hub;
        return hub.atomic(() => handleWorkspaceBroker(hub, path.split('/').at(-1)!, body)); }
      catch (e) { return { status: e instanceof HttpError ? e.status : 500, body: { error: e instanceof Error ? e.message : String(e) } }; }
    }, proxyMcp: async () => { throw Error('unexpected proxy'); } } as unknown as WorkspaceLinks;
  try {
    const waiting = rpc(links, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_request',
      arguments: { to: '@closing-target#1', question: '질문', task_id: from.task.id, timeout_sec: 600 } } });
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 1000;
      const check = () => { if (from.store.pendingApprovals().length) resolve();
        else if (Date.now() > until) reject(Error('approval was not created')); else setTimeout(check, 10); };
      check();
    });
    await closeRequestBroker(links);
    assert.match((await waiting).content[0].text, /아직 답이 없습니다/);
  } finally { await closeRequestBroker(links); gateway.database.close(); from.close(); to.close(); }
});

test('HTTP gateway sends a cross-source MCP request through authenticated workspaces and returns its explicit reply', async () => {
  const from = owner('http-origin'), to = owner('http-target'), offline = owner('http-offline');
  to.store.updateSession(to.session.id, { engine_session_id: 'http-target-engine' });
  const gatewayDir = mkdtempSync(join(tmpdir(), 'desk-broker-gateway-'));
  const gatewayStore = new Store(join(gatewayDir, 'gateway.db'));
  const gatewayHub = new Hub(gatewayStore, { skills: new SkillStore(join(gatewayDir, 'skills')),
    runner: () => ({ connected: true, id: 'gateway-only', engines: new Set<string>(), has: () => false,
      handle: () => { throw Error('gateway executed a task'); } }) });
  const links = new WorkspaceLinksRuntime(gatewayStore);
  const originWorkspace = new SharedWorkspace(from.hub, undefined, { localAuthority: true });
  const targetWorkspace = new SharedWorkspace(to.hub);
  const offlineWorkspace = new SharedWorkspace(offline.hub);
  const originServer = originWorkspace.server(), targetServer = targetWorkspace.server(), offlineServer = offlineWorkspace.server();
  let gatewayServer: Server | undefined;
  let offlineListening = false;
  const listen = (server: Server) => new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject);
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`); });
  });
  const stop = (server: Server) => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  });
  try {
    const originUrl = await listen(originServer), targetUrl = await listen(targetServer);
    const originToken = originWorkspace.grant('gateway').token;
    const targetToken = targetWorkspace.grant('gateway').token;
    const localId = await links.configureLocal(originUrl, originToken);
    await links.attach({ name: 'target', url: targetUrl, token: targetToken });
    gatewayServer = createHttpServer(gatewayHub, new Access(join(gatewayDir, 'access-token'), 4317),
      join(gatewayDir, 'uploads'), { workspaces: links, localAuthorityId: localId });
    const gatewayUrl = await listen(gatewayServer);
    const tool = (id: number, name: string, args: Record<string, unknown>) => fetch(`${gatewayUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    }).then(async response => ({ status: response.status, body: await response.json() as any }));
    const asked = await tool(1, 'desk_request', { to: '@http-target#1', question: 'HTTP로 물어봅니다', task_id: from.task.id, timeout_sec: 1 });
    assert.equal(asked.status, 200);
    const id = /question_id: "([^"]+)"/.exec(asked.body.result.content[0].text)![1];
    assert.equal(from.store.getRequest(id)?.status, 'approval');
    assert.equal(to.store.getRequest(id), undefined);
    const approvalId = from.store.pendingApprovals()[0].id;
    const approval = await fetch(`${gatewayUrl}/api/approvals/${approvalId}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allow: true }) });
    assert.equal(approval.status, 200, await approval.text());
    const waiting = tool(2, 'desk_wait_answer', { question_id: id, timeout_sec: 3 });
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 2000;
      const check = () => { if (to.store.getRequest(id)?.status === 'running') resolve();
        else if (Date.now() > until) reject(Error('HTTP broker did not deliver')); else setTimeout(check, 20); };
      check();
    });
    to.hub.requests.replyRequest(id, 'HTTP 경유 명시 답변', 'http-target-engine');
    to.hub.requests.answerRequests(to.session.id);
    const answered = await waiting;
    assert.equal(answered.status, 200);
    assert.match(answered.body.result.content[0].text, /HTTP 경유 명시 답변/);
    assert.equal(from.store.getRequest(id)?.status, 'answered');
    assert.equal(gatewayStore.listTasks().length, 0, 'gateway never owns a canonical task');
    const offlineUrl = await listen(offlineServer); offlineListening = true;
    await links.attach({ name: 'offline', url: offlineUrl, token: offlineWorkspace.grant('gateway').token });
    await stop(offlineServer); offlineListening = false;
    const unsafe = await tool(3, 'desk_request', { to: '@http-target#1', question: '다시 질문', task_id: from.task.id, timeout_sec: 1 });
    assert.equal(unsafe.body.result.isError, true);
    assert.match(unsafe.body.result.content[0].text, /연결이 끊긴 작업공간.*task_id/);
    assert.equal(from.store.pendingApprovals().length, 0, 'ambiguous offline target must not create another approval');
  } finally {
    if (gatewayServer) await stop(gatewayServer);
    await links.close();
    gatewayHub.dispose(); gatewayStore.database.close();
    await stop(originServer); await stop(targetServer); if (offlineListening) await stop(offlineServer);
    from.close(); to.close(); offline.close(); rmSync(gatewayDir, { recursive: true, force: true });
  }
});
