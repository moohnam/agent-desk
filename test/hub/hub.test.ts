import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubToRunner, LiveSession, RunnerToHub } from '../../shared/protocol.ts';
import { Store, feedEvent } from '../../hub/src/db.ts';
import { CHANNEL_CONTEXT_MAX_ENTRIES, type HubMessage } from '../../shared/api.ts';
import { Hub } from '../../hub/src/hub.ts';
import { workspaceApi } from '../../hub/src/workspace-api.ts';
import type { RunnerPort } from '../../hub/src/runner/client.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { parseScheduledReply, scheduledReplyDraft } from '../../shared/scheduled-reply.ts';
import { HttpError } from '../../hub/src/errors.ts';

/** A runner that records the hub's commands; the test plays the runner's side with `say`. */
class FakeRunner implements RunnerPort {
  connected = false;
  id: string | null = null;
  engines = new Set(['claude', 'codex', 'agy']);
  sent: HubToRunner[] = [];
  sendError?: Error;
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
    if (cmd.type === 'send' && this.sendError) throw this.sendError;
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

test('scheduled reply syntax resolves on the authoring device and validates the calendar', () => {
  const clock = new Date(2026, 10, 18, 16, 40).getTime();
  const at = new Date(2026, 10, 18, 16, 43).toISOString();
  assert.deepEqual(parseScheduledReply('#later {2026-11-18 16:43} continue', clock), { text: 'continue', at });
  assert.equal(scheduledReplyDraft(at, 'continue'), '#later {2026-11-18 16:43} continue');
  assert.deepEqual(parseScheduledReply('#later {+2m}\ncontinue', clock), {
    text: 'continue', at: new Date(clock + 120_000).toISOString(), relativeMinutes: 2,
  });
  assert.equal(parseScheduledReply('#later continue', clock), undefined);
  assert.equal(parseScheduledReply('예시: #later {+2m}', clock), undefined);
  for (const text of ['#later {2026-02-30 16:43} continue', '#later {2026-11-18 16:40} continue', '#later {+0m} continue',
    '#later {+2m}', '#later {+2m continue', '#now #later {+2m} continue',
    '#now\n#later {+2m} continue', '#later\n{+2m} continue']) {
    assert.ok('error' in (parseScheduledReply(text, clock) ?? {}), text);
  }
});

test('scheduled replies join the end of the normal queue once due and dispatch once', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-18T07:40:00Z') });
  const { hub, runner, dir, taskId, sessionId } = started();
  t.after(() => { hub.dispose(); hub.store.database.close(); rmSync(dir, { recursive: true }); });
  const scheduledAt = new Date(Date.now() + 2000).toISOString();
  const res = workspaceApi(hub, 'POST', new URL(`/tasks/${taskId}/scheduled-replies`, 'http://workspace'), {
    text: 'continue', scheduled_at: scheduledAt,
  });
  assert.equal(res.status, 202);
  assert.deepEqual(hub.taskView(hub.store.getTask(taskId)!).queued.map(q => [q.text, q.scheduled_at]), [['continue', scheduledAt]]);
  hub.sendMessage(taskId, '#later first');
  t.mock.timers.tick(1999);
  assert.deepEqual(hub.store.queued().map(q => q.body), ['first']);
  assert.equal(runner.last('send'), undefined);
  t.mock.timers.tick(1);
  assert.deepEqual(hub.store.queued().map(q => q.body), ['first', 'continue']);
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(runner.last('send')?.text, 'first');
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(runner.last('send')?.text, 'continue');
  runner.say({ type: 'busy', sessionId, busy: false });
  t.mock.timers.tick(5000);
  assert.equal(runner.sent.filter(c => c.type === 'send' && c.text === 'continue').length, 1);
});

test('scheduled replies support cancel and send now without changing plain later', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-18T07:40:00Z') });
  const { hub, runner, dir, taskId, sessionId } = started();
  t.after(() => { hub.dispose(); hub.store.database.close(); rmSync(dir, { recursive: true }); });
  const at = new Date(Date.now() + 1000).toISOString();
  const cancelled = hub.scheduleReply(taskId, 'cancelled', at);
  const immediate = hub.scheduleReply(taskId, 'immediate', at);
  assert.throws(() => hub.scheduleReply(taskId, '#now invalid', at), /예약할 메시지/);
  assert.throws(() => hub.scheduleReply(taskId, 'invalid', new Date(Date.now()).toISOString()), /지났습니다/);
  assert.throws(() => hub.scheduleReply(taskId, 'invalid', '+010000-01-01T00:00:00.000Z'), /형식/);
  assert.throws(() => hub.scheduleReply(taskId, 'invalid', at, undefined, 'replaced'), /세션이 바뀌었습니다/);
  assert.throws(() => hub.sendMessage(taskId, '#later {+2m} continue'), /예약으로/);
  hub.cancelQueued(taskId, cancelled.queued_id);
  hub.sendQueuedNow(taskId, immediate.queued_id);
  assert.equal(runner.last('send')?.text, 'immediate');
  assert.equal(runner.last('send')?.steer, true);
  hub.scheduleReply(taskId, 'stop this too', at);
  hub.interrupt(taskId);
  t.mock.timers.tick(1000);
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.deepEqual(hub.taskView(hub.store.getTask(taskId)!).queued, []);
  hub.sendMessage(taskId, '#later plain');
  assert.equal(runner.last('send')?.text, 'plain');
});

test('a scheduled reply retries a definite pre-dispatch rejection and survives a preceding turn closing', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-18T07:40:00Z') });
  const { hub, runner, dir, taskId, sessionId } = started();
  t.after(() => { hub.dispose(); hub.store.database.close(); rmSync(dir, { recursive: true }); });
  runner.say({ type: 'engine_session', sessionId, engineSessionId: 'existing-engine-session' });
  const at = new Date(Date.now() + 1000).toISOString();
  hub.scheduleReply(taskId, 'retry me', at);
  hub.scheduleReply(taskId, 'resume me', at);
  t.mock.timers.tick(1000);
  runner.sendError = new HttpError(409, 'pre-dispatch rejection');
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.deepEqual(hub.store.queued().map(q => q.body), ['retry me', 'resume me']);
  runner.sendError = undefined;
  t.mock.timers.tick(5000);
  assert.equal(runner.last('send')?.text, 'retry me');
  runner.say({ type: 'closed', sessionId, error: 'another turn closed' });
  assert.deepEqual(hub.store.queued().map(q => q.body), ['resume me']);
  t.mock.timers.tick(5000);
  assert.equal(runner.last('start')?.prompt, 'resume me');
  assert.equal(runner.last('start')?.resume, 'existing-engine-session');
});

test('compose starts a task in a new project and sends the runner a start', () => {
  const { hub, runner, dir } = setup();
  const view = hub.compose(`@web:${dir} #codex #astra 테스트 고쳐 줘`);
  assert.equal(view.status, 'running');
  assert.equal(hub.store.listProjects()[0].root_path, dir);
  const start = runner.last('start')!;
  assert.deepEqual([start.engine, start.model, start.prompt, start.cwd], ['codex', 'astra', '테스트 고쳐 줘', dir]);
  assert.equal(view.permission_mode, 'auto');
  assert.equal(start.permissionMode, 'auto');
});

test('an explicit ask task keeps its permission mode when continued without a tag', () => {
  const { hub, runner, dir } = setup();
  const ask = hub.compose(`@web:${dir} #ask 먼저 확인해 줘`);
  assert.equal(runner.last('start')?.permissionMode, 'default');
  assert.equal(hub.compose('@web 기존 작업을 이어 줘').permission_mode, 'default');
  const fresh = hub.compose('@web #new 새 작업을 시작해 줘');
  assert.notEqual(fresh.id, ask.id);
  assert.equal(runner.last('start')?.permissionMode, 'auto');
});

test('task title updates trim, publish, reject empty or missing tasks, and keep long explicit titles', () => {
  const { hub, dir } = setup();
  const task = hub.compose(`@title:${dir} #codex 시작`);
  const published: string[] = [];
  hub.bus.on('message', (message) => { if (message.type === 'task') published.push(message.task.title); });
  const changed = workspaceApi(hub, 'PATCH', new URL(`/tasks/${task.id}`, 'http://workspace'), { title: '  바꾼 제목  ' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.title, '바꾼 제목');
  assert.equal(changed.body.title_revision, 1);
  assert.equal(hub.store.getTask(task.id)?.title, '바꾼 제목');
  assert.deepEqual(published, ['바꾼 제목']);
  const same = workspaceApi(hub, 'PATCH', new URL(`/tasks/${task.id}`, 'http://workspace'), { title: '바꾼 제목' });
  assert.equal(same.body.title, '바꾼 제목');
  assert.equal(same.body.title_revision, 2, 'saving the same title still advances its version');
  assert.deepEqual(published, ['바꾼 제목', '바꾼 제목']);
  assert.throws(() => hub.renameTask(task.id, '  '), { status: 400 });
  assert.throws(() => hub.renameTask('missing', '제목'), { status: 404 });
  assert.equal(hub.store.getTask(task.id)?.title, '바꾼 제목');
  const long = '긴'.repeat(150);
  assert.equal(hub.renameTask(task.id, long).title, long);
});

test('notes use an existing project, accept literal posts without a runner, and publish edits and deletes', () => {
  const { hub, runner, dir } = setup({ connect: false });
  const project = hub.createProject('web', dir);
  const api = (method: string, path: string, body?: Record<string, unknown>) =>
    workspaceApi(hub, method, new URL(path, 'http://workspace'), body);
  assert.throws(() => hub.compose('#note 제목'), { status: 400 });
  assert.throws(() => hub.compose('@missing #note 제목'), { status: 404 });
  assert.throws(() => hub.compose(`@web:${dir} #note 제목`), { status: 400 });
  assert.throws(() => hub.compose('@web #note'), { status: 400 });
  const note = api('POST', '/compose', { text: '@web #note 진행 #auto #slack' }).body;
  assert.equal(note.kind, 'note');
  assert.equal(note.title, '진행 #auto #slack');
  assert.equal(note.project_id, project.id);
  assert.equal(note.engine, null);
  assert.equal(note.source, null);
  assert.equal(hub.cwdOf(note.id), undefined);
  assert.deepEqual(hub.store.listSessions(note.id), []);
  const messages: HubMessage[] = [];
  hub.bus.on('message', message => messages.push(message));
  const route = `/tasks/${note.id}`;
  const literal = '    들여쓰기\n#codex #new #slack @다른';
  assert.equal(api('POST', `${route}/messages`, { text: literal }).status, 202);
  assert.equal(hub.compose(`@web#${note.seq} #note #fork 원문`, {}, true).id, note.id);
  const [first, second] = hub.store.listEvents(note.id);
  assert.deepEqual(first.payload, { text: literal, revision: 0 });
  assert.deepEqual(second.payload, { text: '#note #fork 원문', revision: 0 });
  assert.equal(api('GET', `/feed/count?task=${note.id}`).body.posts, 2);
  const row = `${route}/notes/${first.id}`;
  const edited = api('PATCH', row, { text: '#now 수정' }).body;
  assert.deepEqual(edited, { ...first, payload: { text: '#now 수정', revision: 1 } });
  assert.deepEqual(messages.find(m => m.type === 'event_updated'), { type: 'event_updated', event: edited });
  assert.throws(() => api('PATCH', row, { text: '   ' }), { status: 400 });
  assert.throws(() => api('DELETE', `${route}/notes/0`), { status: 400 });
  assert.throws(() => api('POST', `${row}/cut`, {}), { status: 400 });
  assert.throws(() => api('POST', `${row}/cut`, { revision: 0 }), { status: 409 });
  assert.deepEqual(hub.store.listEvents(note.id), [edited, second]);
  assert.equal(api('POST', `${row}/cut`, { revision: 1 }).status, 200);
  assert.equal(api('POST', `${row}/cut`, { revision: 1 }).status, 200);
  assert.deepEqual(messages.find(m => m.type === 'event_removed'), { type: 'event_removed', task_id: note.id, event_id: first.id });
  assert.deepEqual(hub.store.listEvents(note.id), [second]);
  assert.equal(api('GET', '/feed/count').body.posts, 1);
  assert.throws(() => api('PATCH', row, { text: '이미 삭제됨' }), { status: 404 });
  assert.equal(runner.sent.length, 0);

  runner.hello();
  const task = hub.compose('@web 에이전트 첫 작업');
  assert.notEqual(task.id, note.id);
  assert.equal(task.seq, note.seq + 1);
  hub.compose('#note @web 최신 메모');
  assert.equal(hub.compose('@web 에이전트 계속').id, task.id);
  assert.throws(() => api('POST', `/tasks/${task.id}/messages`, { text: '#new 실행', note_only: true }), { status: 409 });
  const agentPost = hub.store.listEvents(task.id)[0];
  assert.throws(() => api('PATCH', `/tasks/${task.id}/notes/${agentPost.id}`, { text: '변경 금지' }), { status: 404 });
});

test('attached notes are immutable across edits and preserve literal tags when queued to an agent', () => {
  const { hub, runner, taskId } = started();
  const live: HubMessage[] = [];
  hub.bus.on('message', message => live.push(message));
  const note = hub.compose('@web #note 결정');
  hub.sendMessage(note.id, '  #auto #fork #slack @다른');
  const post = hub.store.listEvents(note.id)[0];
  const note_context = [{ title: note.title, text: (post.payload as { text: string }).text }];
  const sent = workspaceApi(hub, 'POST', new URL(`/tasks/${taskId}/messages`, 'http://workspace'), { text: '검토', note_context });
  assert.ok(sent.body.queued_id);
  const queue = hub.store.queued({ taskId })[0];
  assert.deepEqual(queue.note_context, note_context);
  assert.equal(hub.state().tasks.find(t => t.id === taskId)?.queued[0].note_context_count, 1);
  hub.updateNote(note.id, post.id, '수정 뒤 본문');
  hub.deleteNote(note.id, post.id);
  hub.sendQueuedNow(taskId, queue.id);
  const event = hub.store.listEvents(taskId).filter(e => e.kind === 'user').at(-1)!;
  assert.deepEqual((event.payload as { note_context: unknown }).note_context, note_context);
  const brief = workspaceApi(hub, 'GET', new URL(`/feed?task=${taskId}`, 'http://workspace')).body.at(-1);
  assert.equal(brief.id, event.id);
  assert.equal(brief.payload.text, '검토');
  assert.equal(brief.payload.clipped, true);
  assert.deepEqual(brief.payload.note_context, [{ title: note.title, text: '' }]);
  const broadcast = live.find(message => message.type === 'event' && message.event.id === event.id);
  assert.deepEqual(JSON.parse(JSON.stringify(broadcast)), { type: 'event', event: brief });
  const whole = workspaceApi(hub, 'GET', new URL(`/tasks/${taskId}/events?ids=${event.id}`, 'http://workspace')).body.events[0];
  assert.deepEqual(whole, event);
  assert.match(runner.last('send')?.text ?? '', /#auto #fork #slack @다른/);
  assert.equal(hub.store.listTasks().length, 2);
  const next = workspaceApi(hub, 'POST', new URL('/compose', 'http://workspace'), { text: '@web #new 시작', note_context });
  assert.notEqual(next.body.id, taskId);
  assert.match(runner.last('start')?.prompt ?? '', /#auto #fork #slack @다른/);
});

test('external titles update on reattach until a user pins one, including an unchanged title and handoff', () => {
  const { hub, dir } = setup();
  const external = hub.external.attachExternal({ title: '자동 제목', summary: '시작', cwd: dir });
  assert.equal(hub.external.attachExternal({ taskId: external.id, title: '새 자동 제목', summary: '재연결', cwd: dir }).title, '새 자동 제목');
  hub.renameTask(external.id, '새 자동 제목');
  assert.equal(hub.store.taskTitleRevision(external.id), 1, 'explicitly saving the same title pins it');
  assert.equal(hub.external.attachExternal({ taskId: external.id, title: '다른 자동 제목', summary: '재연결', cwd: dir }).title, '새 자동 제목');
  assert.equal(hub.taskView(hub.store.getTask(external.id)!).title_revision, 1);

  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), 'desk-handoff-title-'));
  const sessionId = 'session1234';
  const sessionDir = join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'user', sessionId, cwd: dir, timestamp: '2026-01-01T00:00:00.000Z', message: { content: '처음 지시' },
  }) + '\n');
  const otherSessionId = 'session5678';
  writeFileSync(join(sessionDir, `${otherSessionId}.jsonl`), JSON.stringify({
    type: 'user', sessionId: otherSessionId, cwd: dir, timestamp: '2026-01-01T00:00:01.000Z', message: { content: '다음 지시' },
  }) + '\n');
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const handed = hub.external.handoff({ taskId: external.id, title: '인계 제목', cwd: dir, engine: 'claude', sessionId });
    assert.equal(handed.task.title, '새 자동 제목');
    assert.equal(handed.task.source, 'app');
    const unpinned = hub.external.attachExternal({ title: '인계 전 제목', summary: '시작', cwd: dir });
    const ordinary = hub.external.handoff({ taskId: unpinned.id, title: '인계에서 지정한 제목', cwd: dir, engine: 'claude', sessionId: otherSessionId });
    assert.equal(ordinary.task.title, '인계에서 지정한 제목', 'explicit handoff titles still update unpinned tasks');
  } finally {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('task views keep the stored local runner host when disconnected and distinguish missing sessions', () => {
  const { hub, runner, dir } = setup();
  const local = hub.compose(`@web:${dir} #codex 시작`);
  assert.equal(local.runner_id, 'fake');
  assert.equal(local.runner_label, 'test', 'the saved hello host identifies the runner');
  runner.connected = false;
  runner.id = null;
  const offline = hub.taskView(hub.store.getTask(local.id)!);
  assert.equal(offline.runner_label, 'test', 'the label survives a lost connection');
  assert.equal(offline.runner_connected, false);
  const unstarted = hub.store.createTask({
    id: 'not-started', project_id: local.project_id, title: '아직 시작하지 않음', status: 'done',
    checkpoint_md: null, created_by: 'local', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const empty = hub.taskView(unstarted);
  assert.equal(empty.source, null);
  assert.equal(empty.runner_id, undefined);
  assert.equal(empty.runner_label, undefined);
  const external = hub.external.attachExternal({ title: '외부', summary: '외부 세션', cwd: dir });
  assert.equal(external.source, 'external');
  assert.equal(external.runner_label, undefined);
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
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '그다음 이것도', skills: [], steer: false, skillSnapshot: undefined });
  assert.equal(hub.taskView(hub.store.getTask(taskId)!).queued.length, 0);
  assert.equal(status(hub, taskId), 'running');
});

test('#now joins the running turn instead of waiting', () => {
  const { hub, runner, taskId, sessionId } = started();
  hub.sendMessage(taskId, '#now 이것도 같이');
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '이것도 같이', skills: [], steer: true, skillSnapshot: undefined });
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
  assert.deepEqual(runner.last('send'), { type: 'send', sessionId, text: '같은 내용', skills: [], steer: true, skillSnapshot: undefined });
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

test('a message answers a single open question instead of waiting for the turn', () => {
  const { hub, runner, taskId, sessionId } = started();
  runner.say({ type: 'approval_request', sessionId, approvalId: 'q1', toolName: 'AskUserQuestion',
    input: { questions: [{ question: '어떻게 할까요?' }] } });
  hub.sendMessage(taskId, 'C로 해 줘');
  const r = runner.last('approval_result')!;
  assert.equal(r.allow, false);
  assert.match(r.message!, /직접 답했습니다[\s\S]*C로 해 줘/);
  assert.equal(hub.taskView(hub.store.getTask(taskId)!).queued.length, 0);
  assert.equal(runner.last('send'), undefined);
  const events = hub.store.listEvents(taskId);
  assert.ok(events.some((e) => e.kind === 'user' && (e.payload as { text: string }).text === 'C로 해 줘'));
  assert.equal((events.findLast((e) => e.kind === 'approval')!.payload as { replied?: boolean }).replied, true);
  assert.equal(status(hub, taskId), 'running');
});

test('in Codex a message answers its single open question', () => {
  const t = setup();
  const view = t.hub.compose(`@web:${t.dir} #codex 고쳐 줘`);
  const sessionId = t.runner.last('start')!.sessionId;
  t.runner.say({ type: 'busy', sessionId, busy: true });
  t.runner.say({ type: 'approval_request', sessionId, approvalId: 'q2', toolName: 'AskUserQuestion',
    input: { questions: [{ question: '이름?', options: [] }] } });
  t.hub.sendMessage(view.id, '데스크');
  const r = t.runner.last('approval_result')!;
  assert.equal(r.allow, true);
  assert.deepEqual(r.answers, { '이름?': '데스크' });
});

test('replies do not answer choices, question batches, secrets or ambiguous pending questions', () => {
  const open = { question: '이름?' };
  const option = { question: '방향?', options: [{ label: '왼쪽' }] };
  for (const waiting of [[{ questions: [option] }], [{ questions: [option, open] }],
    [{ questions: [{ ...open, secret: true }] }], [{ questions: [open] }, { questions: [option] }]]) {
    const { hub, runner, taskId, sessionId } = started();
    waiting.forEach((input, index) => runner.say({ type: 'approval_request', sessionId,
      approvalId: `q${index}`, toolName: 'AskUserQuestion', input }));
    const receipt: { answered?: boolean; queued_id?: string } = {};
    hub.sendMessage(taskId, '일반 지시 #now', false, receipt);
    assert.equal(receipt.answered, undefined);
    assert.ok(receipt.queued_id);
    assert.equal(runner.last('approval_result'), undefined);
    assert.equal(hub.state().approvals.length, waiting.length);
  }
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

test('an approved request steers a busy target and only its receiving session can reply', () => {
  const { hub, runner, taskId: target, sessionId, dir } = started();
  hub.store.updateSession(sessionId, { engine_session_id: 'receiving-thread' });
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const request = hub.requests.request({ to: target, text: '상태는? #auto', fromTaskId: asker.id });
  assert.equal(request.status, 'approval');
  assert.equal(runner.last('send'), undefined);
  hub.resolveApproval(request.approval_id!, true);
  const sent = runner.last('send')!;
  assert.equal(sent.steer, true);
  assert.match(sent.text, new RegExp(request.id));
  assert.match(sent.text, /#auto/);
  assert.equal(hub.store.getRequest(request.id)?.status, 'running');
  hub.addEvent(sessionId, target, 'assistant', { text: '원래 작업의 응답' });
  assert.equal(hub.store.getRequest(request.id)?.status, 'running');
  assert.throws(() => hub.requests.replyRequest(request.id, '답', 'wrong-thread'), /받은 세션만/);
  assert.equal(hub.requests.replyRequest(request.id, '정확한 답', 'receiving-thread').answer, '정확한 답');
  assert.equal(hub.requests.replyRequest(request.id, '정확한 답', 'receiving-thread').answer, '정확한 답');
  assert.throws(() => hub.requests.replyRequest(request.id, '다른 답', 'receiving-thread'), /이미 다른 답/);
  hub.requests.answerRequests(sessionId);
  assert.equal(hub.store.getRequest(request.id)?.answer, '정확한 답');
});

test('an Antigravity target is rejected before a local request is created', () => {
  const { hub, taskId, dir } = started(setup(), '#agy 진행');
  const asker = hub.external.attachExternal({ title: 'asker', summary: '질문', cwd: dir });
  assert.throws(() => hub.requests.request({ to: taskId, text: '질문', fromTaskId: asker.id }), /desk_reply 연결을 지원하지 않아/);
  assert.equal(hub.store.openRequests().length, 0);
});

test('a project request does not silently target an older Codex task when the newest runs Antigravity', () => {
  const { hub, taskId, dir } = started(setup(), '#codex 첫 작업');
  const project = hub.store.getTask(taskId)!;
  const newest = hub.createTask(project.project_id, '새 작업', '#agy 다음 작업');
  hub.store.database.prepare('UPDATE task SET updated_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', taskId);
  hub.store.database.prepare('UPDATE task SET updated_at=? WHERE id=?').run('2026-12-01T00:00:00.000Z', newest.id);
  const asker = hub.external.attachExternal({ title: 'asker', summary: '질문', cwd: dir });
  assert.throws(() => hub.requests.request({ to: '@web', text: '질문', fromTaskId: asker.id }), /desk_reply 연결을 지원하지 않아/);
  assert.throws(() => hub.requests.request({ to: newest.id, text: '질문', fromTaskId: asker.id }), /desk_reply 연결을 지원하지 않아/);
  assert.equal(hub.store.openRequests().length, 0);
});

test('repeating a request after an inbound agent prompt reuses it; a new user message may ask again', () => {
  const { hub, taskId: target, dir } = started();
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  hub.addEvent(hub.store.latestSession(asker.id)!.id, asker.id, 'user', { text: '물어봐 주세요' });
  const ask = () => hub.requests.request({ to: target, text: '상태는?', fromTaskId: asker.id });
  const first = ask();
  hub.addEvent(hub.store.latestSession(asker.id)!.id, asker.id, 'user', { text: '다른 에이전트의 질문',
    request: { id: 'inbound', task_id: target, from: 'target', title: 'target' } });
  assert.equal(ask().id, first.id);
  assert.equal(hub.store.pendingApprovals().length, 1);
  hub.resolveApproval(first.approval_id!, false);
  assert.equal(ask().id, first.id, 'a completed retry still belongs to the same user message');
  hub.addEvent(hub.store.latestSession(asker.id)!.id, asker.id, 'user', { text: '다시 물어봐 주세요' });
  assert.notEqual(ask().id, first.id);
  hub.deleteTask(asker.id);
  assert.equal((hub.store.database.prepare('SELECT count(*) AS n FROM request_dedupe').get() as { n: number }).n, 0);
});

test('an attached task without a user message reuses a completed identical request', () => {
  const { hub, taskId: target, dir } = started();
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const ask = () => hub.requests.request({ to: target, text: '상태는?', fromTaskId: asker.id });
  const first = ask();
  hub.resolveApproval(first.approval_id!, false);
  assert.equal(ask().id, first.id);
});

test('a context reset does not replay a failed steered request in the new session', () => {
  const { hub, runner, taskId: target, sessionId: oldSession, dir } = started();
  hub.store.updateSession(oldSession, { engine_session_id: 'old-engine' });
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '재확인 부탁합니다', fromTaskId: asker.id });
  hub.resolveApproval(r.approval_id!, true);
  assert.equal(hub.store.getRequest(r.id)?.status, 'running');
  assert.equal(hub.resetContext(target, '새 문맥').queued, true);
  hub.addEvent(oldSession, target, 'status', { kind: 'status', state: 'turn_done' });
  runner.say({ type: 'busy', sessionId: oldSession, busy: false });
  const replacement = hub.store.latestSession(target)!;
  assert.notEqual(replacement.id, oldSession);
  assert.equal(hub.store.getRequest(r.id)?.status, 'failed');
  assert.equal(hub.store.queued({ sessionId: replacement.id }).length, 0);
  assert.throws(() => hub.requests.replyRequest(r.id, '오래된 답', 'old-engine'), /답변을 기다리는 질문이 아닙니다/);
});

test('an unanswered steered request fails without using the original final or replaying it', () => {
  const { hub, runner, taskId: target, sessionId, dir } = started();
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '독립적으로 답해 주세요', fromTaskId: asker.id });
  hub.resolveApproval(r.approval_id!, true);
  hub.addEvent(sessionId, target, 'assistant', { text: '원래 작업의 최종 응답' });
  hub.addEvent(sessionId, target, 'status', { kind: 'status', state: 'turn_done' });
  const sends = runner.sent.length;
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(hub.store.getRequest(r.id)?.status, 'failed');
  assert.notEqual(hub.store.getRequest(r.id)?.answer, '원래 작업의 최종 응답');
  assert.equal(runner.sent.length, sends);
  assert.equal(hub.store.listEvents(target).filter(e => (e.payload as any).request?.id === r.id).length, 1);
});

test('an independent request with mixed input fails instead of taking an unrelated final', () => {
  const { hub, runner, taskId: target, sessionId, dir } = started();
  runner.say({ type: 'busy', sessionId, busy: false });
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '질문', fromTaskId: asker.id });
  hub.resolveApproval(r.approval_id!, true);
  assert.equal(runner.last('send')?.steer, false);
  hub.addEvent(sessionId, target, 'user', { text: '다른 지시', delivery: 'now' });
  hub.addEvent(sessionId, target, 'assistant', { text: '다른 지시의 답' });
  hub.addEvent(sessionId, target, 'status', { kind: 'status', state: 'turn_done' });
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(hub.store.getRequest(r.id)?.status, 'failed');
  assert.notEqual(hub.store.getRequest(r.id)?.answer, '다른 지시의 답');
});

test('an idle request without desk_reply cannot use its final message as the answer', () => {
  const { hub, runner, taskId: target, sessionId, dir } = started();
  runner.say({ type: 'busy', sessionId, busy: false });
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '질문', fromTaskId: asker.id });
  hub.resolveApproval(r.approval_id!, true);
  assert.equal(runner.last('send')?.steer, false);
  hub.addEvent(sessionId, target, 'assistant', { text: 'READY' });
  hub.addEvent(sessionId, target, 'status', { kind: 'status', state: 'turn_done' });
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(hub.store.getRequest(r.id)?.status, 'failed');
  assert.notEqual(hub.store.getRequest(r.id)?.answer, 'READY');
});

test('an interrupted steered turn fails without starting a new request turn', () => {
  const { hub, runner, taskId: target, sessionId, dir } = started();
  const asker = hub.external.attachExternal({ title: 'asker', summary: '묻는 쪽', cwd: dir });
  const r = hub.requests.request({ to: target, text: '질문', fromTaskId: asker.id });
  hub.resolveApproval(r.approval_id!, true);
  const sends = runner.sent.length;
  hub.addEvent(sessionId, target, 'status', { kind: 'status', state: 'interrupted' });
  runner.say({ type: 'busy', sessionId, busy: false });
  assert.equal(hub.store.getRequest(r.id)?.status, 'failed');
  assert.equal(runner.sent.length, sends);
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

for (const engine of ['codex','claude']) test(`live ${engine} skill steering sends the selected pinned snapshot`,()=>{
  const t=setup();try{
    t.hub.skills.create('parent','fixture');
    const task=t.hub.compose(`@project:${t.dir} #${engine} initial`);
    const session=t.runner.last('start')!;
    t.runner.say({type:'busy',sessionId:session.sessionId,busy:true});
    t.hub.sendMessage(task.id,'#parent 랑 진행을 반복 #now');
    const command=t.runner.last('send')!;
    assert.deepEqual(command.skills,['parent']);assert.equal(command.steer,true);
    assert.deepEqual(command.skillSnapshot?.selected,['parent']);
    assert.ok(command.skillSnapshot?.files.some(file=>file.name==='parent'&&file.path==='SKILL.md'));
    assert.ok(!command.text.includes('[데스크 스킬]'));
    assert.ok(command.text.includes('랑 진행을 반복'));
    const user=t.hub.store.listEvents(task.id).filter(e=>e.kind==='user').at(-1)!;
    assert.equal((user.payload as {text:string}).text,'#parent 랑 진행을 반복 #now');
    t.hub.sendMessage(task.id,'#parent');
    const queued=t.hub.store.queued({taskId:task.id})[0];assert.ok(queued);
    t.hub.sendQueuedNow(task.id,queued.id);
    assert.deepEqual(t.runner.last('send')!.skillSnapshot?.selected,['parent']);
  }finally{t.hub.remotes.close();t.hub.store.database.close();}
});

test('revoking one hub stops only its turn and preserves other hubs queued inputs', async t => {
  const { SharedWorkspace } = await import('../../hub/src/shared-workspace.ts');
  const f=setup();const {hub,runner,dir}=f;
  t.after(()=>{hub.dispose();hub.store.database.close();rmSync(dir,{recursive:true,force:true});});
  const workspace=new SharedWorkspace(hub);
  const a=workspace.grant('A'),b=workspace.grant('B');
  const author=(peerId:string)=>({peerId,ownerId:peerId,ownerName:peerId===a.id?'남무현':'B',fingerprint:'test'});
  const from=<T>(peerId:string,fn:()=>T)=>hub.store.origins.with(author(peerId),fn);
  const task=from(a.id,()=>hub.compose(`@ssh:${dir} first`));
  const id=hub.store.latestSession(task.id)!.id;
  runner.say({type:'busy',sessionId:id,busy:true});
  from(a.id,()=>hub.sendMessage(task.id,'A later'));
  from(b.id,()=>hub.sendMessage(task.id,'#now B later'));
  const bQueue=hub.store.queued({taskId:task.id}).find(q=>q.text.includes('B later'))!;
  assert.throws(()=>from(b.id,()=>hub.sendQueuedNow(task.id,bQueue.id)),/기다려/);
  assert.equal(hub.store.queued({taskId:task.id}).length,2);
  // A network disconnect has no authority to revoke the submitting hub.
  runner.connected=false;
  assert.equal(hub.store.queued({taskId:task.id}).length,2);
  assert.equal(runner.last('close'),undefined);
  runner.connected=true;
  workspace.revoke(a.id);
  assert.equal(runner.last('close')?.sessionId,id);
  assert.deepEqual(hub.store.queued({taskId:task.id}).map(q=>q.id),[bQueue.id]);
  assert.equal(hub.store.origins.stopping(id),true);
  runner.say({type:'closed',sessionId:id,reason:'user',busy:true});
  assert.equal(hub.store.origins.stopping(id),false);
  assert.equal(hub.store.origins.run(id)?.peerId,b.id);
  assert.equal(hub.store.queued({taskId:task.id}).length,0);
  const inputs=hub.store.listEvents(task.id).filter(e=>e.kind==='user');
  assert.equal((inputs[0].payload as any).author.ownerName,'남무현');
  assert.equal((inputs.at(-1)!.payload as any).author.peerId,b.id);
});

test('scheduled inputs keep their original hub despite another hub rearming the timer', async t => {
  const {SharedWorkspace}=await import('../../hub/src/shared-workspace.ts');
  t.mock.timers.enable({apis:['Date','setTimeout'],now:new Date('2026-11-20T00:00:00Z')});
  const {hub,runner,dir,taskId,sessionId}=started();
  t.after(()=>{hub.dispose();hub.store.database.close();rmSync(dir,{recursive:true,force:true});});
  const workspace=new SharedWorkspace(hub),a=workspace.grant('A'),b=workspace.grant('B');
  const from=<T>(peerId:string,fn:()=>T)=>hub.store.origins.with({peerId,ownerId:peerId,ownerName:peerId,fingerprint:'test'},fn);
  const at=new Date(Date.now()+2000).toISOString();
  const qa=from(a.id,()=>hub.scheduleReply(taskId,'A scheduled',at));
  const qb=from(b.id,()=>hub.scheduleReply(taskId,'B scheduled',at));
  t.mock.timers.tick(2100);
  assert.equal(hub.store.origins.queued(qa.queued_id)?.peerId,a.id);
  assert.equal(hub.store.origins.queued(qb.queued_id)?.peerId,b.id);
  workspace.revoke(a.id);
  assert.deepEqual(hub.store.queued({taskId}).map(q=>q.id),[qb.queued_id]);
  runner.say({type:'busy',sessionId,busy:false});
  assert.equal(hub.store.origins.run(sessionId)?.peerId,b.id);
});

test('revocation persists while a runner is disconnected and retries close on reconnect', async t => {
  const {SharedWorkspace}=await import('../../hub/src/shared-workspace.ts');
  const {hub,runner,dir}=setup();
  t.after(()=>{hub.dispose();hub.store.database.close();rmSync(dir,{recursive:true,force:true});});
  const workspace=new SharedWorkspace(hub),peer=workspace.grant('A');
  const author={peerId:peer.id,ownerId:'owner',ownerName:'A',fingerprint:'test'};
  const task=hub.store.origins.with(author,()=>hub.compose(`@offline:${dir} work`));
  const sessionId=hub.store.latestSession(task.id)!.id;
  runner.say({type:'busy',sessionId,busy:true});runner.connected=false;
  assert.doesNotThrow(()=>workspace.revoke(peer.id));
  assert.equal(hub.store.origins.stopping(sessionId),true);
  assert.equal(runner.last('close'),undefined);
  runner.connected=true;
  hub.revokeInputPeer(peer.id);
  assert.equal(runner.last('close')?.sessionId,sessionId);
  const closes=runner.sent.filter(c=>c.type==='close').length;
  runner.hello([{sessionId,busy:false,approvals:[]}]);
  hub.revokeInputPeer(peer.id);
  assert.equal(runner.sent.filter(c=>c.type==='close').length,closes+1,'an unacknowledged close is resent after hello');
});

test('approving another hubs agent request does not change its author',async t=>{
  const {SharedWorkspace}=await import('../../hub/src/shared-workspace.ts');
  const {hub,runner,dir}=setup();
  t.after(()=>{hub.dispose();hub.store.database.close();rmSync(dir,{recursive:true,force:true});});
  const workspace=new SharedWorkspace(hub),a=workspace.grant('A'),b=workspace.grant('B');
  const from=<T>(peerId:string,fn:()=>T)=>hub.store.origins.with({peerId,ownerId:peerId,ownerName:peerId,fingerprint:'test'},fn);
  const target=from(b.id,()=>hub.compose(`@target:${dir} target`));
  const asker=from(a.id,()=>hub.compose(`@asker:${dir} asker`));
  const request=hub.requests.request({to:target.id,text:'question',fromTaskId:asker.id});
  assert.equal(request.status,'approval');
  from(b.id,()=>hub.resolveApproval(request.approval_id!,true));
  assert.equal(hub.store.origins.queued(request.id)?.peerId,a.id);
  const q=hub.store.queued({taskId:target.id})[0];
  assert.equal(hub.store.origins.queued(q.id)?.peerId,a.id);
  workspace.revoke(a.id);
  assert.equal(hub.store.queued({taskId:target.id}).length,0);
  assert.notEqual(runner.last('close')?.sessionId,hub.store.latestSession(target.id)!.id);
});


test('restoring an unattributed input does not inherit the timers revoked author', async t=>{
  const {SharedWorkspace}=await import('../../hub/src/shared-workspace.ts');
  const store=new Store(':memory:');t.after(()=>store.database.close());
  const workspace=new SharedWorkspace(undefined,store),peer=workspace.grant('timer-author');
  store.origins.remember('legacy-input');
  workspace.revoke(peer.id);
  const author={peerId:peer.id,ownerId:peer.id,ownerName:'timer',fingerprint:'test'};
  assert.equal(store.origins.with(author,()=>store.origins.restore('legacy-input',()=>store.origins.current())),undefined);
});


test('a missing closed notification cannot strand other inputs after an idle revoked session disappears',async t=>{
  const {SharedWorkspace}=await import('../../hub/src/shared-workspace.ts');
  const {hub,runner,dir}=setup();
  t.after(()=>{hub.dispose();hub.store.database.close();rmSync(dir,{recursive:true,force:true});});
  const workspace=new SharedWorkspace(hub),peer=workspace.grant('A');
  const author={peerId:peer.id,ownerId:peer.id,ownerName:'A',fingerprint:'test'};
  const task=hub.store.origins.with(author,()=>hub.compose(`@closed:${dir} first`));
  const sessionId=hub.store.latestSession(task.id)!.id;
  hub.sendMessage(task.id,'preserve this input');
  workspace.revoke(peer.id);
  runner.say({type:'busy',sessionId,busy:false});
  assert.equal(hub.store.getTask(task.id)?.status,'done');
  assert.equal(hub.store.origins.stopping(sessionId),true);
  assert.equal(hub.store.queued({taskId:task.id}).length,1);
  runner.hello([]);
  assert.equal(hub.store.origins.stopping(sessionId),false);
  assert.equal(hub.store.queued({taskId:task.id}).length,0);
  assert.match(runner.last('start')!.prompt,/preserve this input/);
});
