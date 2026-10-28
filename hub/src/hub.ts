import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  DEFAULT_ENGINE, DEFAULT_MODE, ENGINE_EFFORTS, ENGINE_LABEL, ENGINE_MODELS, ENGINES, REQUEST_TOOL, engineOf, mentionsIn, modelProblem, parseCompose, wantedEngine,
  type Composed, type Effort, type EngineName, type ModelName, type PermissionMode,
} from './compose.ts';
import {
  Store, feedEvent, now, type AgentRequest, type Approval, type Event, type Queued, type QueuedKind, type Question, type Session,
  type Task, type TaskStatus,
} from './db.ts';
import { draftPrompt, quoteEvent, revisePrompt, type Quoted } from './handoff.ts';
import { findSession } from './importer.ts';
import { RunnerClient } from './runner/client.ts';
import { SkillStore } from './skills.ts';
import type { Answers, BackgroundTask, LiveSession, RunnerToHub } from './runner/protocol.ts';

export type HubMessage =
  | { type: 'event'; event: Event }
  | { type: 'task'; task: TaskView }
  | { type: 'approval'; approval: Approval }
  | { type: 'question'; question: Question }
  | { type: 'runner'; connected: boolean };

export interface TaskView extends Task {
  project_name: string;
  engine: string | null;
  permission_mode: PermissionMode | null;
  model: ModelName | null;
  effort: Effort | null;
  live: boolean;
  /** 'external': a terminal session attached over MCP; the app only answers its questions. */
  source: 'app' | 'external' | null;
  last_event: Event | null;
  pending_approvals: number;
  pending_questions: number;
  /** A Codex async question waiting for my next message, which answers it; null when none. */
  pending_ask: { event_id: number; text: string; ts: string } | null;
  /** Messages waiting for the running turn to end (#later), oldest first. */
  queued: { id: string; text: string; created_at: string; kind?: QueuedKind }[];
  /** What the agent left running between turns (subagents, background commands); the session stays open meanwhile. */
  background: BackgroundTask[];
}

/** Desk-wide defaults for new tasks of each engine; null leaves the choice to the engine. */
export type Settings = Record<EngineName, { model: ModelName | null; effort: Effort | null }>;

const OWNER = 'local';
/** Without a runner after this long, sessions left running by an earlier hub are treated as gone. */
const RUNNER_GRACE_MS = 5000;

/**
 * `answers` as recorded and published: answers to questions marked secret (Codex's `isSecret`) are
 * masked. Only the runner gets them as written.
 */
export function maskSecretAnswers(input: unknown, answers: Answers | undefined): Answers | undefined {
  const qs = (input as { questions?: { question: string; secret?: boolean }[] } | null)?.questions ?? [];
  const secret = new Set(qs.filter((q) => q.secret).map((q) => q.question));
  if (!answers || !secret.size) return answers;
  return Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, secret.has(q) ? '••••' : a]));
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class Hub {
  readonly bus = new EventEmitter();
  readonly store: Store;
  readonly skills: SkillStore;
  private runner: RunnerClient;
  /** Sessions with a turn in progress (runner `busy`), set as soon as the hub sends them work. */
  private busy = new Set<string>();
  /** Per live session, its background work (runner's last list). */
  private background = new Map<string, BackgroundTask[]>();
  /** Whether the connected runner can close a session on request (runners before it ignore the command). */
  private runnerCloses = false;

  constructor(store: Store, skills = new SkillStore()) {
    this.store = store;
    this.skills = skills;
    this.runner = new RunnerClient(
      (m) => this.onRunnerMessage(m),
      (connected) => this.publish({ type: 'runner', connected }),
    );
    setTimeout(() => { if (!this.runner.connected) this.reconcile([]); }, RUNNER_GRACE_MS).unref();
  }

  /** Compose syntax with the desk's skills as known #tags; `route`: the compose box's leading @mention. */
  parse(text: string, route = false) { return parseCompose(text ?? '', this.skills.names(), route); }

  private requireRunner() {
    if (!this.runner.connected) throw new HttpError(503, 'Runner에 연결되어 있지 않습니다. 잠시 후 다시 시도하세요');
  }

  /** Applies the runner's view of live sessions after a (re)connect. */
  private reconcile(sessions: LiveSession[]) {
    const approvals = sessions.flatMap((s) => s.approvals.map((a) => ({ ...a, sessionId: s.sessionId })));
    const { lost, touched } = this.store.reconcile(
      new Set(sessions.map((s) => s.sessionId)), new Set(approvals.map((a) => a.approvalId)));
    // App sessions the runner no longer has died with it (runner restart, crash): say so instead of going quiet.
    for (const r of lost) {
      this.addEvent(r.id, r.task_id, 'status', { kind: 'status', state: 'error', detail: {
        message: '세션이 비정상 종료되었습니다. 답글을 보내면 이어서 재개합니다.', reason: 'session_lost',
      } });
    }
    for (const a of approvals) this.onRunnerMessage({ type: 'approval_request', ...a });
    for (const s of sessions) {
      const session = this.store.getSession(s.sessionId);
      if (!session) continue;
      if (s.approvals.length) this.setStatus(session.task_id, session.id, 'waiting');
      else if (s.busy) this.setStatus(session.task_id, session.id, 'running');
    }
    this.busy = new Set(sessions.filter((s) => s.busy).map((s) => s.sessionId));
    this.background = new Map(sessions.filter((s) => s.background?.length).map((s) => [s.sessionId, s.background!]));
    for (const s of sessions) if (s.background?.length) { const t = this.store.getSession(s.sessionId)?.task_id; if (t) touched.push(t); }
    // Messages that waited for a session the runner no longer has will not be sent.
    for (const r of lost) { this.answerRequests(r.id, '대상 작업의 세션이 끝나'); this.dropQueue(r.id, r.task_id, '세션이 종료되어'); }
    for (const taskId of touched) this.publishTask(taskId);
    for (const sessionId of new Set(this.store.queued().map((q) => q.session_id))) this.drain(sessionId);
  }

  private publish(m: HubMessage) { this.bus.emit('message', m); }

  settings(): Settings {
    const get = (e: EngineName) => ({
      model: (this.store.setting(`${e}_model`) ?? null) as ModelName | null,
      effort: (this.store.setting(`${e}_effort`) ?? null) as Effort | null,
    });
    return { claude: get('claude'), codex: get('codex') };
  }
  /** Only the engines and keys given change; null clears one. */
  setSettings(s: Partial<Record<EngineName, { model?: ModelName | null; effort?: Effort | null }>>): Settings {
    const engines = (['claude', 'codex'] as const).filter((e) => s[e]);
    for (const e of engines) {
      const { model, effort } = s[e]!;
      if (model != null && !ENGINE_MODELS[e].includes(model)) throw new HttpError(400, `${ENGINE_LABEL[e]} 모델이 아닙니다: ${model}`);
      if (effort != null && !ENGINE_EFFORTS[e].includes(effort)) throw new HttpError(400, `${ENGINE_LABEL[e]}에서 쓸 수 없는 effort입니다: ${effort}`);
    }
    for (const e of engines) {
      if (s[e]!.model !== undefined) this.store.setSetting(`${e}_model`, s[e]!.model);
      if (s[e]!.effort !== undefined) this.store.setSetting(`${e}_effort`, s[e]!.effort);
    }
    return this.settings();
  }

  taskView(task: Task): TaskView {
    const session = this.store.latestSession(task.id);
    return {
      ...task,
      project_name: this.store.getProject(task.project_id)?.name ?? '?',
      engine: session?.engine ?? null,
      permission_mode: session?.permission_mode ?? null,
      model: session?.model ?? null,
      effort: session?.effort ?? null,
      live: session ? (session.source === 'external' ? task.status !== 'done' : this.runner.has(session.id)) : false,
      source: session?.source ?? null,
      last_event: this.store.lastEvent(task.id) ?? null,
      pending_approvals: this.store.pendingApprovals().filter((a) => a.task_id === task.id).length,
      pending_questions: this.store.pendingQuestions().filter((q) => q.task_id === task.id).length,
      pending_ask: this.store.openAsyncQuestion(task.id),
      queued: this.store.queued({ taskId: task.id }).map((q) => ({ id: q.id, text: q.text, created_at: q.created_at, ...(q.kind && { kind: q.kind }) })),
      background: (session && this.background.get(session.id)) ?? [],
    };
  }

  state() {
    return {
      projects: this.store.listProjects(),
      tasks: this.store.listTasks().map((t) => this.taskView(t)),
      approvals: this.store.pendingApprovals(),
      questions: this.store.pendingQuestions(),
      runner: { connected: this.runner.connected },
    };
  }

  private publishTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (task) this.publish({ type: 'task', task: this.taskView(task) });
  }

  private setStatus(taskId: string, sessionId: string, status: TaskStatus) {
    this.store.setTaskStatus(taskId, status);
    this.store.updateSession(sessionId, { status });
    this.publishTask(taskId);
  }

  private addEvent(sessionId: string, taskId: string, kind: Event['kind'], payload: unknown): Event {
    const event = this.store.addEvent(sessionId, taskId, kind, payload);
    this.store.touchTask(taskId);
    // Live events come cut like the feed's (feedEvent); an open thread fetches clipped ones whole.
    this.publish({ type: 'event', event: feedEvent(event) });
    this.publishTask(taskId);
    return event;
  }

  /** With `create`, a missing directory is made (with its parents) instead of refused. */
  createProject(name: string, rootPath: string, create = false) {
    if (!name?.trim() || !rootPath?.trim()) throw new HttpError(400, 'name and root_path are required');
    let st;
    try { st = statSync(rootPath); } catch { /* missing */ }
    if (!st && create) {
      try { mkdirSync(rootPath, { recursive: true }); } catch (e) { throw new HttpError(400, `디렉터리를 만들지 못했습니다: ${rootPath} (${(e as Error).message})`); }
    } else if (!st?.isDirectory()) {
      throw new HttpError(400, st ? `디렉터리가 아니라 파일입니다: ${rootPath}` : `디렉터리가 없습니다: ${rootPath}`);
    }
    const project = { id: randomUUID(), name: name.trim(), root_path: rootPath, created_at: now() };
    this.store.createProject(project);
    return project;
  }

  /**
   * Handles the compose box: `@name` continues that project's latest task, `@name#N` its task N,
   * `@name:/path` defines the project and starts a new task there, `#new` starts a new task in the
   * project, `#auto`/`#ask` switch the permission mode from then on.
   * `#claude`/`#codex` picks the engine of a new task; naming another engine than the latest task's
   * starts a new task with it instead of continuing.
   */
  compose(text: string): TaskView {
    const c = this.parse(text, true);
    if (!c.mention) throw new HttpError(400, '@프로젝트로 대상을 지정하거나 @이름:/경로로 새 프로젝트를 정의하세요');
    let project = this.store.findProjectByName(c.mention.name);
    if (c.mention.path) {
      if (c.mention.no) throw new HttpError(400, '작업 번호와 경로는 함께 쓸 수 없습니다');
      const path = resolve(c.mention.path.replace(/^~(?=\/|$)/, homedir()));
      if (project && project.root_path !== path) {
        throw new HttpError(409, `@${project.name}은 이미 ${project.root_path}로 등록되어 있습니다`);
      }
      // Naming a new directory there is how a new project starts: it is made, and the thread says so.
      let made = false;
      if (!project) { try { statSync(path); } catch { made = true; } }
      project ??= this.createProject(c.mention.name, path, true);
      const view = this.createTask(project.id, '', text, c.mode, undefined, true);
      const session = made ? this.store.latestSession(view.id) : undefined;
      if (session) this.addEvent(session.id, view.id, 'status', { kind: 'status', state: 'mkdir', detail: { path } });
      return view;
    }
    if (!project) throw new HttpError(404, `등록되지 않은 프로젝트입니다: @${c.mention.name}. @${c.mention.name}:/경로로 정의하세요`);
    if (c.delivery === 'new') return this.createTask(project.id, '', text, c.mode, undefined, true);
    if (c.mention.no) {
      const task = this.store.taskBySeq(project.id, c.mention.no);
      if (!task) throw new HttpError(404, `@${project.name}#${c.mention.no} 작업이 없습니다`);
      return this.taskView(this.store.getTask(this.sendMessage(task.id, text, true))!);
    }
    const last = this.store.latestTaskOfProject(project.id);
    if (!last) return this.createTask(project.id, '', text, c.mode, undefined, true);
    const lastEngine = this.store.latestSession(last.id)?.engine ?? DEFAULT_ENGINE;
    const want = wantedEngine(c);
    if (want && want !== lastEngine) return this.createTask(project.id, '', text, c.mode, undefined, true);
    const target = this.sendMessage(last.id, text, true);
    return this.taskView(this.store.getTask(target)!);
  }

  /**
   * `text` may carry compose syntax; the agent receives it with the mention and mode tag removed.
   * `engine`: the engine when no tag picks one (else the default). `routed`: the compose box's text.
   */
  createTask(projectId: string, title: string, text: string, mode: PermissionMode = DEFAULT_MODE, engine0?: EngineName, routed = false) {
    const project = this.store.getProject(projectId);
    if (!project) throw new HttpError(404, 'project not found');
    this.requireRunner();
    const c = this.parse(text, routed);
    const prompt = c.body;
    if (!prompt && !c.skills.length) throw new HttpError(400, 'prompt is required');
    const permissionMode = c.mode ?? mode;
    const engine = wantedEngine(c) ?? engine0 ?? DEFAULT_ENGINE;
    const problem = modelProblem(engine, c);
    if (problem) throw new HttpError(400, problem);
    const d = this.settings()[engine];
    const model = c.model ?? d.model, effort = c.effort ?? d.effort;
    const ts = now();
    const task = this.store.createTask({
      id: randomUUID(), project_id: projectId, title: title?.trim() || (prompt || c.skills.map((s) => `#${s}`).join(' ')).slice(0, 60),
      status: 'running', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
    });
    const sessionId = randomUUID();
    this.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: null, cwd: project.root_path,
      source: 'app', status: 'running', runner_id: this.runner.id ?? `local-${hostname()}`, created_at: ts, permission_mode: permissionMode,
      model, effort,
    });
    this.addEvent(sessionId, task.id, 'user', {
      text: text.trim(), mode: permissionMode, skills: c.skills, delivery: c.delivery === 'new' ? 'new' : undefined,
    });
    this.runner.handle({
      type: 'start', sessionId, engine, cwd: project.root_path, prompt, permissionMode,
      model: model ?? undefined, effort: effort ?? undefined, skills: c.skills, skillsHome: this.skills.home,
    });
    this.busy.add(sessionId);
    return this.taskView(task);
  }

  /**
   * A mode tag alone (e.g. "#auto") only switches the session's mode, even mid-turn. While the task
   * is working, a message waits until the turn ends (#later, the default), joins the running turn
   * (#now). #new and #fork start a new task instead, busy or not: a fresh one in the same project,
   * or one that continues from a copy of this task's conversation.
   * Returns the id of the task that got the message.
   */
  sendMessage(taskId: string, text: string): string {
    const c = this.parse(text);
    if (!c.body && !c.mode && !c.model && !c.effort && !c.skills.length) throw new HttpError(400, 'text is required');
    const session = this.store.latestSession(taskId);
    if (!session) throw new HttpError(404, 'task has no session');
    if (session.source !== 'app') throw new HttpError(409, 'external sessions are view-only');
    const engine = session.engine === 'codex' ? 'codex' : 'claude';
    if (c.delivery === 'new') {
      if (!c.body && !c.skills.length) throw new HttpError(400, '#new로 맡길 지시를 함께 쓰세요');
      return this.createTask(this.store.getTask(taskId)!.project_id, '', text, c.mode, engine).id;
    }
    if (c.engine && c.engine !== engine) {
      throw new HttpError(400, `이 작업은 ${ENGINE_LABEL[engine]}로 진행 중입니다. 엔진은 새 작업에서만 고를 수 있습니다`);
    }
    const problem = modelProblem(engine, c);
    if (problem) throw new HttpError(400, problem);
    this.requireRunner();
    if (c.delivery === 'fork') return this.fork(taskId, session, c, text);
    const live = this.runner.has(session.id);
    const busy = live && this.busy.has(session.id);
    const content = !!(c.body || c.skills.length);
    // Behind messages already waiting too, so they keep their order.
    const wait = content && c.delivery !== 'now' && (busy || this.store.queued({ sessionId: session.id }).length > 0);
    if (!wait) this.addEvent(session.id, taskId, 'user', { text: text.trim(), mode: c.mode, skills: c.skills, delivery: c.delivery });

    // Like the mode, a model or effort tag changes the session at once; a running turn keeps its
    // model and the change applies from the next turn.
    const model = c.model && c.model !== session.model ? c.model : undefined;
    const effort = c.effort && c.effort !== session.effort ? c.effort : undefined;
    if (model || effort) {
      this.store.updateSession(session.id, { ...(model && { model }), ...(effort && { effort }) });
      if (live) this.runner.handle({ type: 'set_model', sessionId: session.id, model, effort });
      this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'model', detail: {
        model: model ?? session.model, effort: effort ?? session.effort,
      } });
    }

    if (c.mode && c.mode !== session.permission_mode) {
      this.store.updateSession(session.id, { permission_mode: c.mode });
      if (live) this.runner.handle({ type: 'set_mode', sessionId: session.id, permissionMode: c.mode });
      this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'mode', detail: { mode: c.mode } });
    }
    if (!content) return taskId;

    if (wait) {
      this.store.enqueue({
        id: randomUUID(), task_id: taskId, session_id: session.id, text: text.trim(), body: c.body,
        skills: c.skills, mode: c.mode ?? null, created_at: now(),
      });
      this.publishTask(taskId);
      this.drain(session.id);
    } else {
      this.dispatch(session.id, c.body, c.skills, busy && c.delivery === 'now');
    }
    return taskId;
  }

  /** Hands a message to the session: to the live one, or by resuming the conversation. */
  private dispatch(sessionId: string, body: string, skills: string[], steer = false) {
    const session = this.store.getSession(sessionId)!;
    if (this.runner.has(sessionId)) {
      this.runner.handle({ type: 'send', sessionId, text: body, skills, steer });
    } else {
      // A new engine process: whatever ran in the background before went with the old one.
      this.background.delete(sessionId);
      this.runner.handle({
        type: 'start', sessionId, engine: engineOf(session.engine), cwd: session.cwd, prompt: body,
        resume: session.engine_session_id ?? undefined, permissionMode: session.permission_mode,
        model: session.model ?? undefined, effort: session.effort ?? undefined, skills, skillsHome: this.skills.home,
      });
    }
    this.busy.add(sessionId);
    this.setStatus(session.task_id, sessionId, 'running');
  }

  /** Sends the oldest waiting message once the session has no turn in progress. */
  private drain(sessionId: string) {
    if (!this.runner.connected || this.busy.has(sessionId)) return;
    const next = this.store.queued({ sessionId })[0];
    if (!next || !this.store.dequeue(next.id)) return;
    if (next.kind === 'reset') { this.reset(this.store.getSession(sessionId)!, next.body, next.created_at); return; }
    this.sendQueued(next, 'later');
    this.dispatch(sessionId, next.body, next.skills);
  }

  /** Records a waiting message as sent; one carrying an agent's request starts that request's answer. */
  private sendQueued(q: Queued, delivery: 'now' | 'later') {
    const r = this.store.openRequests().find((x) => x.queued_id === q.id);
    if (r) { this.startRequest(r, q.session_id, delivery); return; }
    this.addEvent(q.session_id, q.task_id, 'user', {
      text: q.text, mode: q.mode ?? undefined, skills: q.skills, delivery, queued_at: q.created_at, ...(q.kind === 'handoff' && { handoff: 'request' }),
    });
  }

  /** Discards a session's waiting messages, saying so in the task with their text. */
  private dropQueue(sessionId: string, taskId: string, why: string) {
    const items = this.store.queued({ sessionId });
    if (!items.length) return;
    for (const q of items) this.store.dequeue(q.id);
    this.addEvent(sessionId, taskId, 'status', { kind: 'status', state: 'queue_dropped', detail: {
      message: `${why} 대기 중이던 메시지 ${items.length}개를 보내지 않았습니다.`, texts: items.map((q) => q.text),
    } });
    const ids = new Set(items.map((q) => q.id));
    for (const r of this.store.openRequests().filter((x) => x.queued_id && ids.has(x.queued_id))) {
      this.settleRequest(r, 'failed', `대상 작업에서 ${why} 질문을 전달하지 못했습니다.`);
    }
  }

  cancelQueued(taskId: string, queuedId: string) {
    const q = this.store.queued({ taskId }).find((x) => x.id === queuedId);
    if (!q || !this.store.dequeue(q.id)) throw new HttpError(404, '대기 중인 메시지가 없습니다. 이미 보냈을 수 있습니다');
    const r = this.store.openRequests().find((x) => x.queued_id === q.id);
    if (r) this.settleRequest(r, 'denied', '사용자가 대기 중이던 질문을 취소했습니다.');
    this.publishTask(taskId);
  }

  /**
   * Sends a waiting message right away: into the running turn (as #now does), or as the next turn
   * when none runs.
   */
  sendQueuedNow(taskId: string, queuedId: string) {
    const q = this.store.queued({ taskId }).find((x) => x.id === queuedId);
    if (!q) throw new HttpError(404, '대기 중인 메시지가 없습니다. 이미 보냈을 수 있습니다');
    if (q.kind === 'reset') throw new HttpError(409, '컨텍스트 재구성은 지금 턴이 끝난 뒤에 실행됩니다');
    this.requireRunner();
    if (!this.store.dequeue(q.id)) throw new HttpError(404, '대기 중인 메시지가 없습니다. 이미 보냈을 수 있습니다');
    const steer = this.runner.has(q.session_id) && this.busy.has(q.session_id);
    this.sendQueued(q, steer ? 'now' : 'later');
    this.dispatch(q.session_id, q.body, q.skills, steer);
    this.publishTask(taskId);
  }

  /** Moves a waiting message to position `index` (0 = sent first) among the task's waiting ones. */
  moveQueued(taskId: string, queuedId: string, index: number) {
    const ids = this.store.queued({ taskId }).map((q) => q.id);
    const from = ids.indexOf(queuedId);
    if (from < 0) throw new HttpError(404, '대기 중인 메시지가 없습니다. 이미 보냈을 수 있습니다');
    if (!Number.isInteger(index)) throw new HttpError(400, 'index는 정수여야 합니다');
    ids.splice(from, 1);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, queuedId);
    this.store.reorderQueued(ids);
    this.publishTask(taskId);
  }

  /** #fork: a new task in the same project that continues from a copy of this task's conversation. */
  private fork(parentId: string, parent: Session, c: Composed, text: string): string {
    if (!c.body && !c.skills.length) throw new HttpError(400, '#fork로 맡길 지시를 함께 쓰세요');
    if (!parent.engine_session_id) throw new HttpError(409, '아직 포크할 대화가 없습니다. 첫 응답이 시작된 뒤 다시 시도하세요');
    const parentTask = this.store.getTask(parentId)!;
    const permissionMode = c.mode ?? parent.permission_mode;
    const model = c.model ?? parent.model, effort = c.effort ?? parent.effort;
    const ts = now();
    const task = this.store.createTask({
      id: randomUUID(), project_id: parentTask.project_id, title: (c.body || c.skills.map((s) => `#${s}`).join(' ')).slice(0, 60),
      status: 'running', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
    });
    const sessionId = randomUUID();
    const engine = parent.engine === 'codex' ? 'codex' : 'claude';
    this.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: null, cwd: parent.cwd,
      source: 'app', status: 'running', runner_id: this.runner.id ?? `local-${hostname()}`, created_at: ts, permission_mode: permissionMode,
      model, effort,
    });
    this.addEvent(sessionId, task.id, 'user', {
      text: text.trim(), mode: permissionMode, skills: c.skills, delivery: 'fork', forked_from: { task_id: parentId, title: parentTask.title, seq: parentTask.seq },
    });
    this.addEvent(parent.id, parentId, 'status', { kind: 'status', state: 'forked', detail: { task_id: task.id, title: task.title, seq: task.seq } });
    this.runner.handle({
      type: 'start', sessionId, engine, cwd: parent.cwd, prompt: c.body, resume: parent.engine_session_id, fork: true,
      permissionMode, model: model ?? undefined, effort: effort ?? undefined, skills: c.skills, skillsHome: this.skills.home,
    });
    this.busy.add(sessionId);
    return task.id;
  }

  /** The task's session the desk runs, for the context reset. */
  private appSession(taskId: string): Session {
    const session = this.store.latestSession(taskId);
    if (!session) throw new HttpError(404, 'task has no session');
    if (session.source !== 'app') throw new HttpError(409, '터미널 세션은 데스크에서 컨텍스트를 재구성할 수 없습니다');
    this.requireRunner();
    return session;
  }

  /**
   * Asks the task's agent for a handoff summary keeping the key facts of the `picked` posts, or with
   * `feedback`, to rewrite `current` as asked (handoff.ts). An ordinary message the user sees in the
   * thread, but sent as written: quoted posts may hold #tags. Waits for a running turn like #later.
   */
  requestHandoff(taskId: string, a: { picked?: number[]; feedback?: string; current?: string }) {
    const session = this.appSession(taskId);
    let text: string;
    if (a.feedback?.trim()) {
      if (!a.current?.trim()) throw new HttpError(400, '고칠 정리본이 없습니다');
      text = revisePrompt(a.feedback, a.current);
    } else {
      const picked = this.store.eventsByIds(taskId, (a.picked ?? []).filter(Number.isInteger).slice(0, 200))
        .map(quoteEvent).filter((q): q is Quoted => !!q);
      text = draftPrompt(picked);
    }
    if (this.busy.has(session.id) || this.store.queued({ sessionId: session.id }).length) {
      this.store.enqueue({
        id: randomUUID(), task_id: taskId, session_id: session.id, text, body: text, skills: [], mode: null, created_at: now(), kind: 'handoff',
      });
      this.publishTask(taskId);
      this.drain(session.id);
      return { queued: true };
    }
    this.addEvent(session.id, taskId, 'user', { text, skills: [], handoff: 'request' });
    this.dispatch(session.id, text, []);
    return { queued: false };
  }

  /**
   * Continues the task in a fresh engine session whose first message is `text`: the agent keeps
   * nothing of the conversation so far. Waits for a running turn and the messages queued before it.
   */
  resetContext(taskId: string, text: string) {
    const body = text?.trim();
    if (!body) throw new HttpError(400, '새 세션에 넘길 내용을 쓰세요');
    const session = this.appSession(taskId);
    if (this.busy.has(session.id) || this.store.queued({ sessionId: session.id }).length) {
      this.store.enqueue({
        id: randomUUID(), task_id: taskId, session_id: session.id, text: body, body, skills: [], mode: null, created_at: now(), kind: 'reset',
      });
      this.publishTask(taskId);
      this.drain(session.id);
      return { queued: true };
    }
    this.reset(session, body);
    return { queued: false };
  }

  private reset(old: Session, text: string, queuedAt?: string) {
    const taskId = old.task_id;
    if (this.runner.has(old.id)) this.runner.handle({ type: 'close', sessionId: old.id });
    this.busy.delete(old.id);
    this.background.delete(old.id);
    const ts = now();
    const sessionId = randomUUID();
    const engine = engineOf(old.engine);
    this.store.createSession({
      id: sessionId, task_id: taskId, engine, engine_session_id: null, cwd: old.cwd, source: 'app', status: 'running',
      runner_id: this.runner.id ?? `local-${hostname()}`, created_at: ts, permission_mode: old.permission_mode, model: old.model, effort: old.effort,
    });
    // What was waiting behind the reset, and requests to this task, go on in the new session.
    this.store.moveQueued(old.id, sessionId);
    for (const r of this.store.openRequests().filter((x) => x.to_session_id === old.id)) this.store.updateRequest(r.id, { to_session_id: sessionId });
    this.addEvent(old.id, taskId, 'status', { kind: 'status', state: 'context_reset', detail: { session_id: sessionId } });
    this.addEvent(sessionId, taskId, 'user', { text, skills: [], handoff: 'reset', ...(queuedAt && { queued_at: queuedAt }) });
    this.runner.handle({
      type: 'start', sessionId, engine, cwd: old.cwd ?? '', prompt: text, permissionMode: old.permission_mode,
      model: old.model ?? undefined, effort: old.effort ?? undefined, skills: [], skillsHome: this.skills.home,
    });
    this.busy.add(sessionId);
    this.setStatus(taskId, sessionId, 'running');
  }

  interrupt(taskId: string) {
    const session = this.store.latestSession(taskId);
    if (!session || !this.runner.has(session.id)) throw new HttpError(409, 'no live session');
    // Stopping means stopping: what was waiting to run next does not start either.
    this.dropQueue(session.id, taskId, '중단해서');
    this.runner.handle({ type: 'interrupt', sessionId: session.id });
  }

  /** Ends the task's live session to free its process; the history stays and the next reply resumes it. */
  closeSession(taskId: string) {
    const session = this.store.latestSession(taskId);
    if (!session || session.source !== 'app' || !this.runner.has(session.id)) throw new HttpError(409, '열려 있는 세션이 없습니다');
    if (!this.runnerCloses) throw new HttpError(409, '지금 러너는 세션 닫기를 지원하지 않습니다. 러너를 재시작하면 쓸 수 있습니다');
    this.runner.handle({ type: 'close', sessionId: session.id });
  }

  /**
   * Deletes tasks for good: their open sessions are closed, requests and questions waiting on them
   * end, and their records go. `projectId`: the project goes too (with all its tasks).
   */
  deleteTasks(taskIds: string[], projectId?: string) {
    for (const taskId of taskIds) {
      for (const s of this.store.listSessions(taskId)) {
        if (s.source === 'app' && this.runner.has(s.id)) this.runner.handle({ type: 'close', sessionId: s.id });
        this.busy.delete(s.id);
        this.background.delete(s.id);
      }
    }
    const gone = new Set(taskIds);
    for (const r of this.store.openRequests()) {
      if (gone.has(r.to_task_id) && !gone.has(r.from_task_id)) this.settleRequest(r, 'failed', '대상 작업이 삭제되었습니다.');
    }
    for (const q of this.store.pendingQuestions()) if (gone.has(q.task_id)) this.settleQuestion(q, 'cancelled', null);
    this.store.deleteTasks(taskIds);
    if (projectId) this.store.deleteProject(projectId);
    this.publish({ type: 'removed', taskIds, projectIds: projectId ? [projectId] : [] });
  }

  deleteTask(taskId: string) {
    if (!this.store.getTask(taskId)) throw new HttpError(404, `작업을 찾을 수 없습니다: ${taskId}`);
    this.deleteTasks([taskId]);
  }

  deleteProject(projectId: string) {
    if (!this.store.getProject(projectId)) throw new HttpError(404, `프로젝트를 찾을 수 없습니다: ${projectId}`);
    this.deleteTasks(this.store.listTasks().filter((t) => t.project_id === projectId).map((t) => t.id), projectId);
  }

  /** The working directory of a task's latest session, for resolving relative links in its replies. */
  cwdOf(taskId: string): string | undefined { return this.store.latestSession(taskId)?.cwd ?? undefined; }

  /** `answers`: the user's picks when the approval is an agent's question (ASK_USER). */
  resolveApproval(approvalId: string, allow: boolean, message?: string, answers?: Answers) {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.status !== 'pending') throw new HttpError(404, 'no pending approval');
    if (approval.tool_name === REQUEST_TOOL) { this.resolveRequest(approval, allow, message); return; }
    this.requireRunner();
    this.store.setApprovalStatus(approvalId, allow ? 'allowed' : 'denied');
    this.publish({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    this.addEvent(approval.session_id, approval.task_id, 'approval',
      { approvalId, toolName: approval.tool_name, decision: allow ? 'allowed' : 'denied', message,
        answers: maskSecretAnswers(approval.input, answers) });
    this.runner.handle({ type: 'approval_result', sessionId: approval.session_id, approvalId, allow, message, answers });
    if (this.store.pendingApprovals().every((a) => a.task_id !== approval.task_id)) {
      this.setStatus(approval.task_id, approval.session_id, 'running');
    }
  }

  // --- Questions between agents (desk_request, see mcp.ts) ---

  /** `@project#N` of a task. */
  private taskLabel(task: Task) { return `${this.store.getProject(task.project_id)?.name ?? '?'}#${task.seq}`; }

  /**
   * One agent asks another task's agent. `to`: '@project' (its latest desk-run task), '@project#N' or a
   * task id. The asker is `fromTaskId` (an attached task) or the engine session `sessionId` (a task the
   * desk runs). It goes to the target at once when the user named the target with @ in the message the
   * asker is working on; otherwise the user allows it on a card first. A busy target gets it after its
   * turn, like a waiting message; the target's last reply in the turn that takes it is the answer.
   */
  request(a: { to: string; text: string; fromTaskId?: string; sessionId?: string }): AgentRequest {
    if (!a.text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const from = this.requester(a);
    const to = this.requestTarget(a.to);
    if (to.task.id === from.task_id) throw new HttpError(400, '자기 작업에는 물을 수 없습니다');
    if (this.waitsOn(to.task.id, from.task_id)) {
      throw new HttpError(409, `@${this.taskLabel(to.task)}가 이 작업의 답을 기다리는 중이라, 물으면 서로 기다리게 됩니다. 그 질문에 먼저 답하세요`);
    }
    this.requireRunner();
    const r: AgentRequest = {
      id: randomUUID(), from_task_id: from.task_id, from_session_id: from.id, to_task_id: to.task.id, to_session_id: to.session.id,
      text: a.text.trim(), status: 'approval', answer: null, approval_id: null, queued_id: null, prompt_event_id: null,
      created_at: now(), answered_at: null,
    };
    if (this.allowedByUser(from.task_id, to.task)) {
      this.store.createRequest(r);
      this.deliverRequest(r);
    } else {
      const approval: Approval = {
        id: randomUUID(), session_id: from.id, task_id: from.task_id, tool_name: REQUEST_TOOL,
        input: { to: `@${this.taskLabel(to.task)}`, title: to.task.title, description: r.text }, status: 'pending', created_at: now(),
      };
      this.store.createApproval(approval);
      this.store.createRequest({ ...r, approval_id: approval.id });
      this.publish({ type: 'approval', approval });
      this.addEvent(from.id, from.task_id, 'approval',
        { approvalId: approval.id, toolName: REQUEST_TOOL, input: approval.input, decision: 'pending' });
      this.setStatus(from.task_id, from.id, 'waiting');
    }
    return this.store.getRequest(r.id)!;
  }

  private requester(a: { fromTaskId?: string; sessionId?: string }): Session {
    if (!a.fromTaskId?.trim() && !a.sessionId?.trim()) {
      throw new HttpError(400, 'task_id(데스크에 붙은 작업) 또는 session_id(데스크가 실행한 작업의 세션 ID)가 필요합니다');
    }
    const s = a.fromTaskId?.trim() ? this.store.latestSession(a.fromTaskId.trim()) : this.store.sessionByEngineId(a.sessionId!.trim());
    if (!s) throw new HttpError(404, '묻는 작업을 데스크에서 찾지 못했습니다. 데스크에 붙은 작업이면 task_id를, 데스크가 실행한 작업이면 session_id를 확인하세요');
    return s;
  }

  private requestTarget(to: string): { task: Task; session: Session } {
    const t = to?.trim() ?? '';
    let task = this.store.getTask(t);
    if (!task) {
      const m = /^@?([^\s:@#]+)(?:#(\d+))?$/.exec(t);
      if (!m) throw new HttpError(400, 'to에는 @프로젝트, @프로젝트#번호 또는 task_id를 쓰세요');
      const project = this.store.findProjectByName(m[1]);
      if (!project) throw new HttpError(404, `등록되지 않은 프로젝트입니다: @${m[1]}`);
      task = m[2] ? this.store.taskBySeq(project.id, Number(m[2]))
        : this.store.listTasks().filter((x) => x.project_id === project.id && this.store.latestSession(x.id)?.source === 'app')
          .sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
      if (!task) {
        throw new HttpError(404, m[2] ? `@${project.name}#${m[2]} 작업이 없습니다` : `@${project.name}에는 데스크가 실행하는 작업이 없어 물을 곳이 없습니다`);
      }
    }
    const session = this.store.latestSession(task.id);
    if (!session) throw new HttpError(404, `@${this.taskLabel(task)}에 세션이 없습니다`);
    if (session.source !== 'app') {
      throw new HttpError(409, `@${this.taskLabel(task)}는 터미널에서 붙은 작업이라 데스크가 질문을 넣을 수 없습니다. 데스크가 실행하는 작업을 지정하세요`);
    }
    return { task, session };
  }

  /** Whether task `a` waits, through open requests, on an answer from task `b`. */
  private waitsOn(a: string, b: string): boolean {
    const open = this.store.openRequests();
    const seen = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const r of open) if (r.from_task_id === x) stack.push(r.to_task_id);
    }
    return false;
  }

  /**
   * Whether the user's message the asker is working on names the target: '@project' for a task of
   * another project, or '@project#N' for that task. '@project' of the asker's own project is where the
   * message went, not a target.
   */
  private allowedByUser(fromTaskId: string, to: Task): boolean {
    const p = this.store.lastEventOf(fromTaskId, 'user')?.payload as { text?: string; request?: unknown } | undefined;
    if (!p?.text || p.request) return false;
    const own = this.store.getTask(fromTaskId)!.project_id;
    return mentionsIn(p.text).some((m) => {
      const project = this.store.findProjectByName(m.name);
      if (!project || project.id !== to.project_id) return false;
      return m.no ? m.no === to.seq : project.id !== own;
    });
  }

  /** What the target agent receives. */
  private requestPrompt(r: AgentRequest) {
    const from = this.store.getTask(r.from_task_id)!;
    const cwd = this.store.getSession(r.from_session_id)?.cwd;
    return `데스크를 통해 다른 작업(@${this.taskLabel(from)} "${from.title}"${cwd ? `, ${cwd}` : ''})의 에이전트가 질문을 보냈습니다. `
      + '이번 응답의 마지막 메시지가 그대로 그 에이전트에게 답으로 전달되니, 마지막 메시지에 답을 완결해서 쓰세요. '
      + `답하는 데 필요한 만큼만 확인하고, 하던 작업의 방향은 바꾸지 마세요.\n\n질문:\n${r.text}`;
  }

  /** Sends an allowed request to the target: now when it is free, else after the messages waiting there. */
  private deliverRequest(r: AgentRequest) {
    const session = this.store.latestSession(r.to_task_id)!;
    const busy = this.runner.has(session.id) && this.busy.has(session.id);
    if (busy || this.store.queued({ sessionId: session.id }).length) {
      const id = randomUUID();
      this.store.enqueue({
        id, task_id: r.to_task_id, session_id: session.id, text: `@${this.taskLabel(this.store.getTask(r.from_task_id)!)}의 질문: ${r.text}`,
        body: this.requestPrompt(r), skills: [], mode: null, created_at: now(),
      });
      this.store.updateRequest(r.id, { status: 'queued', queued_id: id, to_session_id: session.id });
      this.publishTask(r.to_task_id);
      this.drain(session.id);
    } else {
      this.startRequest(r, session.id);
      this.dispatch(session.id, this.requestPrompt(r), []);
    }
  }

  /** Records the request as the target's `user` message; the turn it starts answers it. */
  private startRequest(r: AgentRequest, sessionId: string, delivery?: 'now' | 'later') {
    const from = this.store.getTask(r.from_task_id)!;
    const e = this.addEvent(sessionId, r.to_task_id, 'user', {
      text: r.text, delivery, request: { id: r.id, task_id: from.id, from: this.taskLabel(from), title: from.title },
    });
    this.store.updateRequest(r.id, { status: 'running', prompt_event_id: e.id, to_session_id: sessionId });
  }

  /**
   * A turn of `sessionId` ended: the requests it took get its last reply as their answer. `endedWhy`:
   * the session ended instead, so they get no answer.
   */
  private answerRequests(sessionId: string, endedWhy?: string) {
    for (const r of this.store.openRequests().filter((x) => x.status === 'running' && x.to_session_id === sessionId)) {
      if (endedWhy) { this.settleRequest(r, 'failed', `${endedWhy} 답을 받지 못했습니다.`); continue; }
      const after = this.store.listEvents(r.to_task_id, 0, (r.prompt_event_id ?? 0) + 1);
      const stopped = after.find((e) => e.kind === 'status' && ['error', 'interrupted'].includes((e.payload as { state?: string }).state ?? ''));
      const reply = after.filter((e) => e.kind === 'assistant').at(-1)?.payload as { text?: string } | undefined;
      if (stopped) {
        this.settleRequest(r, 'failed', `대상 작업이 ${(stopped.payload as { state: string }).state === 'error' ? '오류로 멈춰' : '중단되어'} 답을 받지 못했습니다.`);
      } else if (reply?.text?.trim()) this.settleRequest(r, 'answered', reply.text.trim());
      else this.settleRequest(r, 'failed', '대상 에이전트가 답 없이 턴을 마쳤습니다.');
    }
  }

  private settleRequest(r: AgentRequest, status: 'answered' | 'denied' | 'failed', answer: string) {
    this.store.updateRequest(r.id, { status, answer, answered_at: now() });
    for (const w of [...(this.waiters.get(r.id) ?? [])]) w();
  }

  /** The user allowed or denied a request's card. */
  private resolveRequest(approval: Approval, allow: boolean, message?: string) {
    const r = this.store.openRequests().find((x) => x.approval_id === approval.id);
    if (allow && r) this.requireRunner();
    this.store.setApprovalStatus(approval.id, allow ? 'allowed' : 'denied');
    this.publish({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    this.addEvent(approval.session_id, approval.task_id, 'approval',
      { approvalId: approval.id, toolName: approval.tool_name, decision: allow ? 'allowed' : 'denied', message });
    if (r && allow) {
      try { this.deliverRequest(r); }
      catch (err) { this.settleRequest(r, 'failed', `전달하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`); }
    } else if (r) this.settleRequest(r, 'denied', message ? `사용자가 거절했습니다: ${message}` : '사용자가 거절했습니다.');
    if (this.store.pendingApprovals().every((a) => a.task_id !== approval.task_id)) {
      this.setStatus(approval.task_id, approval.session_id, 'running');
    }
  }

  /** Resolves with the request once it is settled, or as it is after `timeoutMs`. */
  waitRequest(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentRequest> {
    return this.waitFor(requestId, () => this.store.getRequest(requestId),
      (r) => r.status === 'answered' || r.status === 'denied' || r.status === 'failed', timeoutMs, signal);
  }

  // --- Terminal sessions attached over MCP (see mcp.ts) ---

  /** Waiters of desk_ask / desk_request / desk_wait_answer, by question or request id. */
  private waiters = new Map<string, Set<() => void>>();

  /** The external session of `taskId`; app tasks cannot be driven over MCP. */
  private externalSession(taskId: string) {
    const session = this.store.latestSession(taskId);
    if (!session) throw new HttpError(404, `작업을 찾을 수 없습니다: ${taskId}`);
    if (session.source !== 'external') throw new HttpError(409, '앱에서 시작한 작업에는 붙을 수 없습니다');
    return session;
  }

  /**
   * Registers a terminal agent's work as a task: under the deepest project containing `cwd`, or a new
   * project named after the directory. With `taskId` it re-attaches to that earlier external task.
   */
  attachExternal(a: { title: string; summary: string; cwd: string; engine?: string; taskId?: string }): TaskView {
    if (!a.cwd?.trim() || !a.summary?.trim()) throw new HttpError(400, 'cwd와 summary가 필요합니다');
    const cwd = resolve(a.cwd.replace(/^~(?=\/|$)/, homedir()));
    const engine = a.engine === 'codex' ? 'codex' : 'claude';
    if (a.taskId) {
      const session = this.externalSession(a.taskId);
      if (a.title?.trim()) this.store.setTaskTitle(a.taskId, a.title.trim().slice(0, 120));
      this.addEvent(session.id, a.taskId, 'status', { kind: 'status', state: 'started', detail: { source: 'external', engine, cwd } });
      this.addEvent(session.id, a.taskId, 'assistant', { text: a.summary.trim(), via: 'mcp' });
      this.setStatus(a.taskId, session.id, 'running');
      return this.taskView(this.store.getTask(a.taskId)!);
    }
    const project = this.store.projectsContaining(cwd)[0] ?? this.createProject(this.freeProjectName(basename(cwd) || 'root'), cwd);
    const ts = now();
    const task = this.store.createTask({
      id: randomUUID(), project_id: project.id, title: (a.title?.trim() || a.summary.trim()).slice(0, 120),
      status: 'running', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
    });
    const sessionId = randomUUID();
    this.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: null, cwd, source: 'external',
      status: 'running', runner_id: 'mcp', created_at: ts, permission_mode: DEFAULT_MODE,
      model: null, effort: null,
    });
    this.addEvent(sessionId, task.id, 'status', { kind: 'status', state: 'started', detail: { source: 'external', engine, cwd } });
    this.addEvent(sessionId, task.id, 'assistant', { text: a.summary.trim(), via: 'mcp' });
    return this.taskView(this.store.getTask(task.id)!);
  }

  private freeProjectName(base: string) {
    let name = base;
    for (let i = 2; this.store.findProjectByName(name); i++) name = `${base}-${i}`;
    return name;
  }

  postExternal(taskId: string, text: string) {
    if (!text?.trim()) throw new HttpError(400, 'text가 필요합니다');
    const session = this.externalSession(taskId);
    this.addEvent(session.id, taskId, 'assistant', { text: text.trim(), via: 'mcp' });
    if (this.store.getTask(taskId)?.status !== 'waiting') this.setStatus(taskId, session.id, 'running');
  }

  checkpoint(taskId: string, summary: string, nextSteps: string[] = []) {
    if (!summary?.trim()) throw new HttpError(400, 'summary가 필요합니다');
    const session = this.externalSession(taskId);
    const md = [`**체크포인트**`, summary.trim(), ...(nextSteps.length ? ['**다음 단계**', nextSteps.map((s) => `- ${s}`).join('\n')] : [])].join('\n\n');
    this.store.setCheckpoint(taskId, md);
    this.addEvent(session.id, taskId, 'assistant', { text: md, via: 'mcp', checkpoint: true });
  }

  ask(taskId: string, text: string): Question {
    if (!text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const session = this.externalSession(taskId);
    const question: Question = {
      id: randomUUID(), session_id: session.id, task_id: taskId, text: text.trim(),
      status: 'pending', answer: null, created_at: now(), answered_at: null,
    };
    this.store.createQuestion(question);
    this.publish({ type: 'question', question });
    this.addEvent(session.id, taskId, 'question', { questionId: question.id, text: question.text, decision: 'pending' });
    this.setStatus(taskId, session.id, 'waiting');
    return question;
  }

  /** Resolves with the question once it is no longer pending, or as is after `timeoutMs`. */
  waitAnswer(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<Question> {
    return this.waitFor(questionId, () => this.store.getQuestion(questionId), (q) => q.status !== 'pending', timeoutMs, signal);
  }

  /** Resolves with `get()` once `done` holds for it (checked when its id's waiters are called), or after `timeoutMs`. */
  private waitFor<T>(id: string, get: () => T | undefined, done: (t: T) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const first = get();
    if (!first) return Promise.reject(new HttpError(404, `질문을 찾을 수 없습니다: ${id}`));
    if (done(first)) return Promise.resolve(first);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        waiters.delete(finish);
        // Another wait may have started a new set for this id meanwhile; leave that one be.
        if (!waiters.size && this.waiters.get(id) === waiters) this.waiters.delete(id);
        resolve(get()!);
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
      waiters.add(finish);
    });
  }

  answerQuestion(questionId: string, answer: string) {
    const q = this.store.getQuestion(questionId);
    if (!q || q.status !== 'pending') throw new HttpError(404, '대기 중인 질문이 없습니다');
    if (!answer?.trim()) throw new HttpError(400, 'answer가 필요합니다');
    this.settleQuestion(q, 'answered', answer.trim());
    this.addEvent(q.session_id, q.task_id, 'user', { text: answer.trim(), answers: questionId });
    if (!this.store.pendingQuestions().some((x) => x.task_id === q.task_id)) this.setStatus(q.task_id, q.session_id, 'running');
  }

  private settleQuestion(q: Question, status: 'answered' | 'cancelled', answer: string | null) {
    this.store.setQuestionStatus(q.id, status, answer);
    const settled = this.store.getQuestion(q.id)!;
    this.publish({ type: 'question', question: settled });
    for (const w of [...(this.waiters.get(q.id) ?? [])]) w();
  }

  /** Ends an attached task; questions still open are cancelled. */
  finishExternal(taskId: string, summary?: string) {
    const session = this.externalSession(taskId);
    for (const q of this.store.pendingQuestions().filter((x) => x.task_id === taskId)) {
      this.settleQuestion(q, 'cancelled', null);
      this.addEvent(session.id, taskId, 'question', { questionId: q.id, text: q.text, decision: 'cancelled' });
    }
    if (summary?.trim()) this.addEvent(session.id, taskId, 'assistant', { text: summary.trim(), via: 'mcp' });
    this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'finished', detail: { summary: summary?.trim() } });
    this.setStatus(taskId, session.id, 'done');
  }

  /**
   * Takes over a terminal Claude Code or Codex session: a desk task that resumes the same engine
   * conversation, with its history (tool calls as names only) in the thread. `id`: the engine's
   * session id; without it, the newest session that ran in `cwd`. With `taskId` (an attached task)
   * that task continues as the desk's instead of a new one, keeping its posts and skipping the history.
   */
  handoff(a: { engine?: string; sessionId?: string; cwd: string; title?: string; summary?: string; taskId?: string }) {
    if (!a.cwd?.trim()) throw new HttpError(400, 'cwd가 필요합니다');
    const engine = a.engine === 'codex' ? 'codex' : 'claude';
    const cwd0 = resolve(a.cwd.replace(/^~(?=\/|$)/, homedir()));
    let found;
    try { found = findSession(engine, a.sessionId?.trim() || undefined, cwd0); }
    catch (err) { throw new HttpError(404, err instanceof Error ? err.message : String(err)); }
    const existing = this.store.sessionByEngineId(found.id);
    if (existing?.source === 'app') {
      return { task: this.taskView(this.store.getTask(existing.task_id)!), sessionId: found.id, imported: 0, already: true };
    }
    // The engine resumes a conversation from the directory it ran in.
    const cwd = found.cwd ?? cwd0;
    const ts = now();
    let task: Task;
    if (a.taskId) {
      const old = this.externalSession(a.taskId);
      for (const q of this.store.pendingQuestions().filter((x) => x.task_id === a.taskId)) {
        this.settleQuestion(q, 'cancelled', null);
        this.addEvent(old.id, a.taskId, 'question', { questionId: q.id, text: q.text, decision: 'cancelled' });
      }
      this.store.updateSession(old.id, { status: 'done' });
      if (a.title?.trim()) this.store.setTaskTitle(a.taskId, a.title.trim().slice(0, 120));
      task = this.store.getTask(a.taskId)!;
    } else {
      const project = this.store.projectsContaining(cwd)[0] ?? this.createProject(this.freeProjectName(basename(cwd) || 'root'), cwd);
      const firstUser = found.events.find((e) => e.kind === 'user')?.text ?? '';
      task = this.store.createTask({
        id: randomUUID(), project_id: project.id,
        title: (a.title?.trim() || firstUser.split('\n')[0] || `${ENGINE_LABEL[engine]} 세션`).slice(0, 120),
        status: 'idle', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
      });
    }
    const sessionId = randomUUID();
    this.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: found.id, cwd,
      source: 'app', status: 'idle', runner_id: this.runner.id ?? `local-${hostname()}`, created_at: ts,
      permission_mode: DEFAULT_MODE, model: null, effort: null,
    });
    const history = a.taskId ? [] : found.events;
    this.store.importEvents(sessionId, task.id, history.map((e) => ({
      ts: e.ts, kind: e.kind, payload: e.kind === 'tool' ? { kind: 'tool', name: e.name } : { text: e.text },
    })));
    this.addEvent(sessionId, task.id, 'status', { kind: 'status', state: 'handoff', detail: {
      engine, engine_session_id: found.id, cwd, imported: history.length,
    } });
    const note = `터미널 ${ENGINE_LABEL[engine]} 세션을 넘겨받았습니다${history.length ? ` (기록 ${history.length}건)` : ''}. 답글을 쓰면 같은 대화로 이어집니다.`;
    this.addEvent(sessionId, task.id, 'assistant', { text: a.summary?.trim() ? `${note}\n\n${a.summary.trim()}` : note, via: 'handoff' });
    this.setStatus(task.id, sessionId, 'idle');
    return { task: this.taskView(this.store.getTask(task.id)!), sessionId: found.id, imported: history.length, already: false };
  }

  private onRunnerMessage(m: RunnerToHub) {
    if (m.type === 'hello') {
      this.store.upsertRunner(m.runnerId, m.host, m.capabilities);
      this.runnerCloses = !!(m.capabilities as { close?: boolean } | null)?.close;
      this.reconcile(m.sessions);
      return;
    }
    const session = this.store.getSession(m.sessionId);
    if (!session) return;
    const taskId = session.task_id;
    switch (m.type) {
      case 'engine_session':
        this.store.updateSession(session.id, { engine_session_id: m.engineSessionId });
        break;
      case 'event':
        this.addEvent(session.id, taskId, m.event.kind, m.event);
        if (m.event.kind === 'status' && m.event.state === 'error') this.setStatus(taskId, session.id, 'error');
        if (m.event.kind === 'status' && m.event.state === 'interrupted') this.setStatus(taskId, session.id, 'idle');
        break;
      case 'busy':
        if (m.busy) {
          this.busy.add(session.id);
          // A turn the agent started itself, e.g. once a background subagent finished.
          const status = this.store.getTask(taskId)?.status;
          if (status !== 'running' && status !== 'waiting') this.setStatus(taskId, session.id, 'running');
          break;
        }
        this.busy.delete(session.id);
        if (this.store.getTask(taskId)?.status === 'running') this.setStatus(taskId, session.id, 'done');
        this.answerRequests(session.id);
        this.drain(session.id);
        break;
      case 'approval_request': {
        // Already known when replayed after a reconnect.
        if (this.store.getApproval(m.approvalId)) break;
        const approval: Approval = {
          id: m.approvalId, session_id: session.id, task_id: taskId, tool_name: m.toolName,
          input: m.input, status: 'pending', created_at: now(),
        };
        this.store.createApproval(approval);
        this.publish({ type: 'approval', approval });
        this.addEvent(session.id, taskId, 'approval',
          { approvalId: m.approvalId, toolName: m.toolName, input: m.input, decision: 'pending' });
        this.setStatus(taskId, session.id, 'waiting');
        break;
      }
      case 'approval_cancelled': {
        const approval = this.store.getApproval(m.approvalId);
        if (approval?.status === 'pending') {
          this.store.setApprovalStatus(m.approvalId, 'denied');
          this.publish({ type: 'approval', approval: { ...approval, status: 'denied' } });
          this.addEvent(session.id, taskId, 'approval',
            { approvalId: m.approvalId, toolName: approval.tool_name, decision: 'cancelled' });
        }
        break;
      }
      case 'background':
        if (m.tasks.length) this.background.set(session.id, m.tasks); else this.background.delete(session.id);
        this.publishTask(taskId);
        break;
      case 'closed': {
        this.busy.delete(session.id);
        this.background.delete(session.id);
        if (session.source !== 'app') break;
        this.answerRequests(session.id, '대상 작업의 세션이 끝나');
        // Approvals the closed session was waiting on can no longer be answered.
        for (const approval of this.store.pendingApprovals().filter((x) => x.session_id === session.id)) {
          this.store.setApprovalStatus(approval.id, 'denied');
          this.publish({ type: 'approval', approval: { ...approval, status: 'denied' } });
        }
        // A session a context reset replaced: the task goes on in the new one.
        if (this.store.latestSession(taskId)?.id !== session.id) { this.publishTask(taskId); break; }
        // Older runners do not report `busy`; then the task still running/waiting means mid-turn.
        const status = this.store.getTask(taskId)?.status;
        if (m.reason === 'user') {
          this.dropQueue(session.id, taskId, '세션을 닫아서');
          this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'closed', detail: { busy: !!m.busy } });
          if (status === 'running' || status === 'waiting') this.setStatus(taskId, session.id, 'idle');
          else this.publishTask(taskId);
          break;
        }
        const midTurn = m.reason !== 'idle' && (m.busy ?? (status === 'running' || status === 'waiting'));
        if (m.error || midTurn) this.dropQueue(session.id, taskId, '세션이 종료되어');
        if (m.error) {
          this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'error', detail: { message: m.error } });
          this.setStatus(taskId, session.id, 'error');
        } else if (midTurn) {
          this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'error', detail: {
            message: '작업 도중 세션이 예기치 않게 종료되었습니다. 답글을 보내면 이어서 재개합니다.', reason: 'closed_mid_turn',
          } });
          this.setStatus(taskId, session.id, 'error');
        } else {
          // Idle close or a finished session: status stays, the task just stops being live.
          this.publishTask(taskId);
        }
        break;
      }
    }
  }
}
