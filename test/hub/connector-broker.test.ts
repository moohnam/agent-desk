import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorBroker, type ConnectorExecutionContext } from '../../hub/src/connector-broker.ts';

function fixture(options: { now?: () => number; waitMs?: number; onIdle?: (sessionId: string) => void } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO session VALUES ('session-A','task-A','running'),('session-B','task-B','running');
    CREATE TABLE workspace_peer(id TEXT PRIMARY KEY, revoked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO workspace_peer VALUES ('peer-A',0),('peer-B',0);`);
  const broker = new ConnectorBroker(db, 'workspace', options);
  const context = (peer = 'A', request = 'input-A'): ConnectorExecutionContext => ({
    capability: (peer === 'A' ? 'a' : 'b').repeat(43), hubId: 'hub-' + peer, workspaceId: 'workspace',
    requestId: request, expiresAt: Date.now() + 60_000, sourcePeerId: 'peer-' + peer,
    connections: [{ service: 'jira', generation: 'generation-' + peer, tools: ['getJiraIssue'] }],
  });
  return { db, broker, context, close: () => { broker.close(); db.close(); } };
}

test('session credentials isolate source peers and ACK never erases unread results', async () => {
  const f = fixture();
  try {
    const tokenA = f.broker.open('session-A', 'task-A', f.context());
    const tokenB = f.broker.open('session-B', 'task-B', f.context('B', 'input-B'));
    const raw = JSON.stringify(f.db.prepare('SELECT * FROM connector_runtime').all());
    assert.ok(!raw.includes(tokenA)); assert.ok(!raw.includes(tokenB));
    const resultA = f.broker.invoke(tokenA, 'read', { service: 'jira', tool: 'getJiraIssue', arguments: { id: 'A' } });
    const resultB = f.broker.invoke(tokenB, 'list');
    const [jobA] = f.broker.poll('peer-A'), [jobB] = f.broker.poll('peer-B');
    assert.equal(jobA.context.requestId, 'input-A'); assert.equal(jobA.context.taskId, 'task-A');
    assert.equal(jobB.context.requestId, 'input-B'); assert.equal(jobB.context.taskId, 'task-B');
    assert.deepEqual(f.broker.poll('peer-A'), [jobA]);
    assert.throws(() => f.broker.complete('peer-B', jobA.callId, { result: 'stolen' }), /이 허브/);
    assert.throws(() => f.broker.ack('peer-B', [jobA.callId]), /이 허브/);
    f.broker.complete('peer-A', jobA.callId, { result: { source: 'A' } });
    f.broker.ack('peer-A', [jobA.callId]);
    assert.notEqual((f.db.prepare('SELECT completion FROM connector_job WHERE id=?').get(jobA.callId) as { completion: string | null }).completion, null);
    assert.deepEqual(await resultA, { source: 'A' });
    assert.equal((f.db.prepare('SELECT completion FROM connector_job WHERE id=?').get(jobA.callId) as { completion: string | null }).completion, null);
    assert.deepEqual(f.broker.complete('peer-A', jobA.callId, { result: { source: 'A' } }), { accepted: true });
    assert.throws(() => f.broker.complete('peer-A', jobA.callId, { result: { source: 'changed' } }), /결과가 바뀌/);
    f.broker.complete('peer-B', jobB.callId, { result: { connections: ['B'] } });
    assert.deepEqual(await resultB, { connections: ['B'] });
  } finally { f.close(); }
});

test('changed account contexts wait while same-policy steering preserves the accepted grant', async () => {
  const idle: string[] = [], f = fixture({ onIdle: session => idle.push(session) });
  try {
    const token = f.broker.open('session-A', 'task-A', f.context());
    const pending = f.broker.invoke(token, 'list');
    assert.equal(f.broker.busy('session-A'), true);
    assert.equal(f.broker.samePolicy('session-A', f.context('A', 'next-input')), true);
    assert.equal(f.broker.samePolicy('session-A', f.context('B', 'next-input')), false);
    assert.throws(() => f.broker.activate('session-A', 'task-A', f.context('B', 'next-input')), /진행 중/);
    f.broker.activate('session-A', 'task-A', f.context('A', 'next-input'));
    assert.equal(f.broker.stored('session-A')!.requestId, 'input-A');
    const [job] = f.broker.poll('peer-A');
    f.broker.complete('peer-A', job.callId, { result: { source: 'A' } });
    assert.equal(f.broker.busy('session-A'), true);
    await pending;
    assert.equal(f.broker.busy('session-A'), false); assert.deepEqual(idle, ['session-A']);
    f.broker.activate('session-A', 'task-A', f.context('B', 'next-input'));
    assert.equal(f.broker.stored('session-A')!.sourcePeerId, 'peer-B');
  } finally { f.close(); }
});

test('runtime rotation, cancelled callers, deleted sessions and revoked source peers fail closed', async () => {
  const f = fixture();
  try {
    const old = f.broker.open('session-A', 'task-A', f.context());
    const pending = f.broker.invoke(old, 'list');
    const rejected = assert.rejects(pending, /인증|문맥/);
    const token = f.broker.open('session-A', 'task-A', f.context());
    await rejected;
    await assert.rejects(f.broker.invoke(old, 'list'), /인증/);
    const abort = new AbortController();
    const cancelled = f.broker.invoke(token, 'list', {}, abort.signal);
    const cancelledResult = assert.rejects(cancelled, /취소/);
    abort.abort(); await cancelledResult;
    assert.deepEqual(f.broker.poll('peer-A'), []);
    await assert.rejects(f.broker.invoke(token, 'read', { service: 'jira', tool: 'getJiraIssue', arguments: {}, capability: 'forged' }), /허용되지 않은 인자/);
    f.db.prepare('UPDATE workspace_peer SET revoked=1 WHERE id=?').run('peer-A');
    await assert.rejects(f.broker.invoke(token, 'list'), /허브 권한/);
    assert.throws(() => f.broker.poll('peer-A'), /허브 권한/);
    f.db.prepare('DELETE FROM session WHERE id=?').run('session-A');
    await assert.rejects(f.broker.invoke(token, 'list'), /세션/);
  } finally { f.close(); }
});

test('ungranted sessions cannot borrow workspace privileges and offline calls expire', async () => {
  const f = fixture({ waitMs: 10 });
  try {
    const token = f.broker.open('session-A', 'task-A');
    assert.deepEqual(await f.broker.invoke(token, 'list'), { connections: [] });
    await assert.rejects(f.broker.invoke(token, 'tools', { service: 'jira' }), /허용된 외부 연결/);
    await assert.rejects(f.broker.invoke('workspace-peer-bearer', 'list'), /인증/);
    f.broker.activate('session-A', 'task-A', f.context());
    await assert.rejects(f.broker.invoke(token, 'list'), /만료/);
    assert.deepEqual(f.broker.poll('peer-A'), []);
  } finally { f.close(); }
});

test('shutdown releases pending callers even when the owning database closes immediately', async () => {
  const f = fixture();
  const token = f.broker.open('session-A', 'task-A', f.context());
  const pending = f.broker.invoke(token, 'list');
  const rejected = assert.rejects(pending, /중계가 종료/);
  f.broker.close(); f.db.close();
  await rejected;
});

test('idle sweep removes expired raw grants and jobs while preserving tokens for later input', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1000; const f = fixture({ now: () => now });
  try {
    const context = { ...f.context(), expiresAt: now + 100 };
    const token = f.broker.open('session-A', 'task-A', context);
    const pending = f.broker.invoke(token, 'list');
    const rejected = assert.rejects(pending, /만료/);
    const original = f.db.prepare('SELECT token_hash FROM connector_runtime WHERE session_id=?').get('session-A') as { token_hash: string };
    now += 100; t.mock.timers.tick(60_000); await rejected;
    const row = f.db.prepare('SELECT context,token_hash,active FROM connector_runtime WHERE session_id=?').get('session-A') as { context: string | null; token_hash: string; active: number };
    assert.equal(row.context, null); assert.equal(row.token_hash, original.token_hash); assert.equal(row.active, 1);
    assert.equal((f.db.prepare('SELECT count(*) n FROM connector_job').get() as { n: number }).n, 0);
    assert.deepEqual(await f.broker.invoke(token, 'list'), { connections: [] });
    f.broker.activate('session-A', 'task-A', { ...f.context(), requestId: 'new-input', capability: 'z'.repeat(43), expiresAt: now + 100 });
    assert.equal(f.broker.stored('session-A')!.requestId, 'new-input');
    f.broker.authorize(token);
  } finally { f.close(); assert.doesNotThrow(() => t.mock.timers.tick(60_000)); }
});

test('expiry found by another peer poll is notified once by the next sweep',t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let now=1000;const idle:string[]=[];
  const f=fixture({now:()=>now,onIdle:sessionId=>idle.push(sessionId)});
  try {
    f.broker.open('session-A','task-A',{...f.context(),expiresAt:1100});
    now=1200;
    f.broker.poll('peer-B');
    assert.equal(f.broker.hasAuthority('session-A'),false);
    assert.deepEqual(idle,[]);
    t.mock.timers.tick(60_000);
    assert.deepEqual(idle,['session-A']);
    t.mock.timers.tick(60_000);
    assert.deepEqual(idle,['session-A']);
  } finally {f.close();}
});
