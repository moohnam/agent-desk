import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubToRunner, LiveSession, RunnerToHub } from '../../shared/protocol.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import type { RunnerPort } from '../../hub/src/runner/client.ts';
import { SkillStore } from '../../hub/src/skills.ts';

/** A runner that records the hub's commands; the test plays the runner's side with `say`. */
class FakeRunner implements RunnerPort {
  connected = false;
  id: string | null = null;
  engines = new Set(['claude', 'codex', 'agy']);
  sent: HubToRunner[] = [];
  private live = new Set<string>();
  private onMessage: (m: RunnerToHub) => void;
  private onConnection: (c: boolean) => void;
  constructor(onMessage: (m: RunnerToHub) => void, onConnection: (c: boolean) => void) {
    this.onMessage = onMessage;
    this.onConnection = onConnection;
  }
  has(sessionId: string) { return this.connected && this.live.has(sessionId); }
  handle(cmd: HubToRunner) {
    if (!this.connected) throw new Error('runner not connected');
    if (cmd.type === 'start') this.live.add(cmd.sessionId);
    this.sent.push(cmd);
  }
  hello(sessions: LiveSession[] = []) {
    this.connected = true;
    this.id = 'fake';
    this.live = new Set(sessions.map((s) => s.sessionId));
    this.onMessage({ type: 'hello', runnerId: 'fake', host: 'test', capabilities: { engines: [...this.engines], close: true }, sessions });
    this.onConnection(true);
  }
  say(m: RunnerToHub) {
    if (m.type === 'closed') this.live.delete(m.sessionId);
    this.onMessage(m);
  }
  last<T extends HubToRunner['type']>(type: T) { return this.sent.filter((c) => c.type === type).at(-1) as Extract<HubToRunner, { type: T }> | undefined; }
}

function setup({ connect = true, graceMs = 60_000 } = {}) {
  let runner!: FakeRunner;
  const hub = new Hub(new Store(':memory:'), {
    skills: new SkillStore(mkdtempSync(join(tmpdir(), 'desk-skills-'))),
    runner: (onMessage, onConnection) => (runner = new FakeRunner(onMessage, onConnection)),
    graceMs,
  });
  if (connect) runner.hello();
  const dir = mkdtempSync(join(tmpdir(), 'desk-proj-'));
  return { hub, runner, dir };
}

const status = (hub: Hub, taskId: string) => hub.store.getTask(taskId)?.status;
const kinds = (hub: Hub, taskId: string) => hub.store.listEvents(taskId).map((e) => e.kind === 'status' ? `status:${(e.payload as { state: string }).state}` : e.kind);

/** Starts a task and has the runner report its turn running. */
function started(t = setup(), text = '고쳐 줘') {
  const view = t.hub.compose(`@web:${t.dir} ${text}`);
  const start = t.runner.last('start')!;
  t.runner.say({ type: 'busy', sessionId: start.sessionId, busy: true });
  return { ...t, taskId: view.id, sessionId: start.sessionId };
}

test('compose starts a task in a new project and sends the runner a start', () => {
  const { hub, runner, dir } = setup();
  const view = hub.compose(`@web:${dir} #codex #astra 테스트 고쳐 줘`);
  assert.equal(view.status, 'running');
  assert.equal(hub.store.listProjects()[0].root_path, dir);
  const start = runner.last('start')!;
  assert.deepEqual([start.engine, start.model, start.prompt, start.cwd], ['codex', 'astra', '테스트 고쳐 줘', dir]);
});

test('a finished turn marks the task done; a warning on the way does not fail it', () => {
  const { hub, runner, taskId, sessionId } = started();
  runner.say({ type: 'event', sessionId, event: { kind: 'status', state: 'warning', detail: { message: '스킬 등록 실패' } } });
  assert.equal(status(hub, taskId), 'running');
  runner.say({ type: 'event', sessionId, event: { kind: 'assistant', text: '고쳤어요' } });
  runner.say({ type: 'event', sessionId, event: { kind: 'status', state: 'turn_done' } });
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(status(hub, taskId), 'done');
});

test('an error marks the task as failed', () => {
  const { hub, runner, taskId, sessionId } = started();
  runner.say({ type: 'event', sessionId, event: { kind: 'status', state: 'error', detail: { message: '실패' } } });
  assert.equal(status(hub, taskId), 'error');
});

test('a message sent mid-turn waits (#later) and goes when the turn ends', () => {
  const { hub, runner, taskId, sessionId } = started();
  hub.sendMessage(taskId, '그다음 이것도');
  assert.equal(runner.last('send'), undefined);
  assert.deepEqual(hub.taskView(hub.store.getTask(taskId)!).queued.map((q) => q.text), ['그다음 이것도']);
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '그다음 이것도', skills: [], steer: false });
  assert.equal(hub.taskView(hub.store.getTask(taskId)!).queued.length, 0);
  assert.equal(status(hub, taskId), 'running');
});

test('#now joins the running turn instead of waiting', () => {
  const { hub, runner, taskId, sessionId } = started();
  hub.sendMessage(taskId, '#now 이것도 같이');
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '이것도 같이', skills: [], steer: true });
});

test('an approval makes the task wait until the user answers it', () => {
  const { hub, runner, taskId, sessionId } = started();
  runner.say({ type: 'approval_request', sessionId, approvalId: 'a1', toolName: 'Bash', input: { command: 'rm -rf build' } });
  assert.equal(status(hub, taskId), 'waiting');
  assert.equal(hub.state().approvals.length, 1);
  hub.resolveApproval('a1', true);
  assert.deepEqual(runner.last('approval_result'), { type: 'approval_result', sessionId, approvalId: 'a1', allow: true, message: undefined, answers: undefined });
  assert.equal(status(hub, taskId), 'running');
});

test('a session the runner no longer has after a reconnect is lost, and its queue is dropped', () => {
  const { hub, runner, taskId } = started();
  hub.sendMessage(taskId, '대기 중인 말');
  runner.hello([]);
  assert.equal(status(hub, taskId), 'error');
  assert.deepEqual(kinds(hub, taskId).slice(-2), ['status:error', 'status:queue_dropped']);
});

test('without a runner at startup sessions show lost, but what waits on them is kept for the runner\'s report', async () => {
  const t = setup();
  const { taskId, sessionId } = started(t);
  t.hub.sendMessage(taskId, '대기 중인 말');
  // A new hub on the same database, whose runner is late.
  const late = setup({ connect: false, graceMs: 5 });
  const hub = new Hub(t.hub.store, { skills: late.hub.skills, runner: (m, c) => (late.runner = new FakeRunner(m, c)), graceMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(status(hub, taskId), 'error');
  assert.equal(hub.taskView(hub.store.getTask(taskId)!).queued.length, 1, 'the queue waits for the runner');
  late.runner.hello([{ sessionId, busy: true, approvals: [] }]);
  assert.equal(status(hub, taskId), 'running');
  assert.equal(hub.taskView(hub.store.getTask(taskId)!).queued.length, 1);
});

test('a new task for an engine the runner lacks is refused, and nothing is made', () => {
  const { hub, runner, dir } = setup();
  runner.engines.delete('agy');
  assert.throws(() => hub.compose(`@web:${join(dir, 'new')} #agy 해 줘`), /러너는 Antigravity 엔진을 실행하지 못합니다/);
  assert.deepEqual(hub.store.listProjects(), []);
});

test('deleting the task that asked settles its request', async () => {
  const { hub, taskId: target, dir } = started();
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '어떻게 됐어요?', fromTaskId: asker.id });
  const answer = hub.requests.waitRequest(r.id, 5_000);
  hub.deleteTask(asker.id);
  const settled = await answer;
  assert.equal(settled.status, 'failed');
  assert.match(settled.answer ?? '', /질문한 작업이 삭제/);
});
