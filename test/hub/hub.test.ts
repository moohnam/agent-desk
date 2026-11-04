import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubToRunner, LiveSession, RunnerToHub } from '../../shared/protocol.ts';
import { Store, feedEvent } from '../../hub/src/db.ts';
import { CHANNEL_CONTEXT_MAX_ENTRIES } from '../../shared/api.ts';
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

test('a queue receipt promotes exactly its message once, leaving identical and older messages queued', () => {
  const { hub, runner, taskId, sessionId } = started();
  hub.sendMessage(taskId, '먼저 대기한 메시지');
  hub.sendMessage(taskId, '같은 내용');
  const receipt: { queued_id?: string } = {};
  assert.equal(hub.sendMessage(taskId, '같은 내용', false, receipt), taskId);
  const queued = hub.taskView(hub.store.getTask(taskId)!).queued;
  assert.equal(receipt.queued_id, queued[2].id);
  hub.sendQueuedNow(taskId, receipt.queued_id!);
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '같은 내용', skills: [], steer: true });
  assert.deepEqual(hub.taskView(hub.store.getTask(taskId)!).queued.map(q => q.id), queued.slice(0, 2).map(q => q.id));
  const count = runner.sent.length;
  assert.throws(() => hub.sendQueuedNow(taskId, receipt.queued_id!), /이미 보냈을 수 있습니다/);
  assert.equal(runner.sent.length, count);
});

test('a cancelled or already drained receipt never promotes another waiting message', () => {
  const { hub, runner, taskId, sessionId } = started();
  const cancelled: { queued_id?: string } = {};
  hub.sendMessage(taskId, '취소할 메시지', false, cancelled);
  hub.cancelQueued(taskId, cancelled.queued_id!);
  hub.sendMessage(taskId, '다른 메시지');
  assert.throws(() => hub.sendQueuedNow(taskId, cancelled.queued_id!), /이미 보냈을 수 있습니다/);
  assert.equal(runner.last('send'), undefined);
  const drained: { queued_id?: string } = {};
  hub.sendMessage(taskId, '끝나면 보낼 메시지', false, drained);
  runner.say({ type: 'busy', sessionId, busy: false });
  runner.say({ type: 'busy', sessionId, busy: false });
  const count = runner.sent.length;
  assert.throws(() => hub.sendQueuedNow(taskId, drained.queued_id!), /이미 보냈을 수 있습니다/);
  assert.equal(runner.sent.length, count);
  const direct: { queued_id?: string } = {};
  hub.sendMessage(taskId, '#now 즉시 전송', false, direct);
  assert.equal(direct.queued_id, undefined);
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

test('a channel lazily creates one conversation and keeps selected source snapshots out of compose parsing', () => {
  const { hub, runner, dir } = setup();
  const project = hub.createProject('news', dir);
  const { channel } = hub.channels.create({ name: 'News', source: 'push' });
  hub.channels.ingest(channel.id, [
    { external_id: 'one', title: 'First', body: '#auto #new #claude @other ignored as commands', url: 'https://example.com/one' },
    { external_id: 'two', title: 'Second', body: 'Second source' },
  ]);
  assert.equal(hub.store.listTasks().length, 0);
  const entries = hub.channels.entries(channel.id).entries;
  const ids = entries.map((e) => e.id);
  const first = hub.sendChannelMessage(channel.id, { project_id: project.id, text: '#codex #astra 이 두 글 비교', entry_ids: ids });
  assert.equal(hub.store.listTasks().length, 1);
  assert.equal(hub.channels.list()[0].conversation_task_id, first.task.id);
  const start = runner.last('start')!;
  assert.equal(start.engine, 'codex');
  assert.equal(start.model, 'astra');
  assert.equal(start.permissionMode, 'default');
  assert.match(start.prompt, /#auto #new #claude @other/);
  const event = hub.store.listEvents(first.task.id)[0];
  const payload = event.payload as any;
  assert.equal(payload.text, '#codex #astra 이 두 글 비교');
  assert.deepEqual(payload.channel_context.entries.map((e: any) => e.id), ids);
  assert.ok(payload.channel_context.entries[1].url);
  const clipped = feedEvent(event).payload as any;
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.channel_context.entries[1].body, '');
  assert.notEqual(payload.channel_context.entries[1].body, '', 'feed clipping does not mutate the saved evidence');
  runner.say({ type: 'busy', sessionId: start.sessionId, busy: false });
  const second = hub.sendChannelMessage(channel.id, { text: '더 간단히 설명', entry_ids: [] });
  assert.equal(second.task.id, first.task.id);
  assert.equal(hub.store.listTasks().length, 1);
  assert.equal(runner.sent.filter((c) => c.type === 'start').length, 1);
  assert.match(runner.last('send')!.text, /더 간단히 설명/);
});

test('queued channel questions retain their own source versions after edits and immediate promotion', () => {
  const { hub, runner, dir } = setup();
  const project = hub.createProject('news', dir);
  const { channel } = hub.channels.create({ name: 'News', source: 'push' });
  hub.channels.ingest(channel.id, { external_id: 'article', title: '제목', body: 'original' });
  const entryId = hub.channels.entries(channel.id).entries[0].id;
  const first = hub.sendChannelMessage(channel.id, { project_id: project.id, text: '첫 질문', entry_ids: [entryId] });
  const queued = hub.sendChannelMessage(channel.id, { text: '선택 글 요약', entry_ids: [entryId] });
  assert.ok(queued.queued_id);
  const saved = hub.store.queued({ taskId: first.task.id })[0];
  assert.equal(saved.channel_context?.entries[0].body, 'original');
  assert.equal(queued.task.queued[0].channel_entry_count, 1);
  hub.channels.ingest(channel.id, { external_id: 'article', title: '수정됨', body: 'updated #auto #fork' });
  assert.equal(hub.store.queued({ taskId: first.task.id })[0].channel_context?.entries[0].body, 'original');
  hub.sendQueuedNow(first.task.id, queued.queued_id!);
  const send = runner.last('send')!;
  assert.match(send.text, /original/);
  assert.equal(JSON.parse(send.text.split('\n').at(-1)!).entries[0].body, 'original');
  assert.equal(send.steer, true);
  const event = hub.store.listEvents(first.task.id).filter((e) => e.kind === 'user').at(-1)!;
  assert.equal((event.payload as any).channel_context.entries[0].body, 'original');
  assert.equal((event.payload as any).text, '선택 글 요약');
  assert.equal(hub.store.queued({ taskId: first.task.id }).length, 0);
});

test('channel selection rejects other-channel and missing IDs, excessive context and conversation branching without side effects', () => {
  const { hub, dir } = setup();
  const project = hub.createProject('news', dir);
  const a = hub.channels.create({ name: 'A', source: 'push' }).channel;
  const b = hub.channels.create({ name: 'B', source: 'push' }).channel;
  hub.channels.ingest(a.id, { external_id: 'one', body: 'A' });
  hub.channels.ingest(b.id, { external_id: 'one', body: 'B' });
  const aId = hub.channels.entries(a.id).entries[0].id, bId = hub.channels.entries(b.id).entries[0].id;
  for (const input of [
    { text: 'x', entry_ids: [bId] }, { text: 'x', entry_ids: [999999] },
    { text: 'x', entry_ids: Array(CHANNEL_CONTEXT_MAX_ENTRIES + 1).fill(aId) },
    { text: '#fork x', entry_ids: [aId] }, { text: '#new x', entry_ids: [aId] },
    { text: '   ', entry_ids: [aId] }, { text: '#auto', entry_ids: [aId] },
    { text: 'x', entry_ids: null }, { text: 'x', entry_ids: [1.2] },
  ]) assert.throws(() => hub.sendChannelMessage(a.id, { project_id: project.id, ...input } as any));
  assert.equal(hub.store.listTasks().length, 0);
  assert.equal(hub.channels.list()[0].conversation_task_id, null);
  hub.channels.ingest(a.id, Array.from({ length: 5 }, (_, i) => ({ external_id: 'large'+i, body: 'x'.repeat(64 * 1024) })));
  const large = hub.channels.entries(a.id).entries.slice(0, 5).map((entry) => entry.id);
  assert.throws(() => hub.sendChannelMessage(a.id, { project_id: project.id, text: 'large', entry_ids: large }), /너무 큽니다/);
  assert.equal(hub.store.listTasks().length, 0);
  const first = hub.sendChannelMessage(a.id, { project_id: project.id, text: 'x', entry_ids: [aId, aId] });
  assert.equal((hub.store.listEvents(first.task.id)[0].payload as any).channel_context.entries.length, 1);
  assert.throws(() => hub.sendChannelMessage(a.id, { project_id: 'another-project', text: 'x' }), /이미 다른 프로젝트/);
});

test('channel association and queued evidence survive reopening, and deleting the task clears the association', () => {
  const { hub, dir } = setup();
  const path = join(dir, 'persist.db');
  let runner!: FakeRunner;
  const store = new Store(path);
  const persistent = new Hub(store, { skills: hub.skills, runner: (onMessage, onConnection) => (runner = new FakeRunner(onMessage, onConnection)) });
  runner.hello();
  const project = persistent.createProject('news', dir);
  const channel = persistent.channels.create({ name: 'Persist', source: 'push' }).channel;
  persistent.channels.ingest(channel.id, { external_id: 'one', body: 'saved snapshot' });
  const entryId = persistent.channels.entries(channel.id).entries[0].id;
  const first = persistent.sendChannelMessage(channel.id, { project_id: project.id, text: 'first', entry_ids: [entryId] });
  persistent.sendChannelMessage(channel.id, { text: 'second', entry_ids: [entryId] });
  const reopened = new Store(path);
  assert.equal(reopened.getChannel(channel.id)?.conversation_task_id, first.task.id);
  assert.equal(reopened.queued()[0].channel_context?.entries[0].body, 'saved snapshot');
  const notifications: any[] = [];
  persistent.bus.on('message', (message) => notifications.push(message));
  persistent.deleteTask(first.task.id);
  assert.equal(store.getChannel(channel.id)?.conversation_task_id, null);
  assert.ok(notifications.some((m) => m.type === 'channel' && m.channel.id === channel.id && m.channel.conversation_task_id === null));
  assert.equal(store.getChannel(channel.id)?.latest_entry_id, entryId);
  const next = persistent.sendChannelMessage(channel.id, { project_id: project.id, text: 'new conversation', entry_ids: [entryId] });
  assert.notEqual(next.task.id, first.task.id);
  persistent.channels.remove(channel.id);
  assert.ok(store.getTask(next.task.id), 'source deletion preserves the separate conversation and its saved evidence');
  assert.equal((store.listEvents(next.task.id)[0].payload as any).channel_context.entries[0].body, 'saved snapshot');
});

test('a disconnected runner cannot create an orphaned channel conversation', () => {
  const { hub, dir } = setup({ connect: false });
  const project = hub.createProject('news', dir);
  const channel = hub.channels.create({ name: 'News', source: 'push' }).channel;
  assert.throws(() => hub.sendChannelMessage(channel.id, { project_id: project.id, text: '정리해 주세요' }), /runner|러너/i);
  assert.equal(hub.store.listTasks().length, 0);
  assert.equal(hub.channels.list()[0].conversation_task_id, null);
});

test('channel queued sources are delivered in order at turn end, with no new task', () => {
  const { hub, runner, dir } = setup();
  const project = hub.createProject('news', dir);
  const channel = hub.channels.create({ name: 'Queue', source: 'push' }).channel;
  hub.channels.ingest(channel.id, { external_id: 'one', body: 'original evidence' });
  const entryId = hub.channels.entries(channel.id).entries[0].id;
  const first = hub.sendChannelMessage(channel.id, { project_id: project.id, text: 'first' });
  const queued = hub.sendChannelMessage(channel.id, { text: 'second', entry_ids: [entryId] });
  assert.ok(queued.queued_id);
  hub.channels.ingest(channel.id, { external_id: 'one', body: 'edited evidence' });
  runner.say({ type: 'busy', sessionId: runner.last('start')!.sessionId, busy: false });
  assert.equal(runner.last('send')!.steer, false);
  assert.equal(JSON.parse(runner.last('send')!.text.split('\n').at(-1)!).entries[0].body, 'original evidence');
  const event = hub.store.listEvents(first.task.id).filter((event) => event.kind === 'user').at(-1)!;
  assert.equal((event.payload as any).text, 'second');
  assert.equal((event.payload as any).channel_context.entries[0].body, 'original evidence');
  assert.equal(hub.store.listTasks().length, 1);
});
