import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_ENGINE, DEFAULT_MODE, ENGINE_EFFORTS, ENGINE_LABEL, ENGINE_MODELS, ENGINES, REQUEST_TOOL, engineOf, modelProblem, parseCompose, wantedEngine,
  type Composed, type Effort, type EngineName, type ModelName, type PermissionMode,
} from '../../shared/compose.ts';
import type { Approval, ChannelContext, ChannelMessageInput, MessageReceipt, Settings, TaskView } from '../../shared/api.ts';
import { channelContext, channelPrompt } from './channel-context.ts';
import { DeskCore, OWNER } from './core.ts';
import { HttpError } from './errors.ts';
import { ExternalSessions } from './external.ts';
import { Channels, type ChannelOptions } from './channels.ts';
import { AgentRequests } from './requests.ts';
import { expandHome } from './paths.ts';
import { Store, now, type Queued, type Session } from './db.ts';
import { draftPrompt, quoteEvent, revisePrompt, type Quoted } from '../../shared/handoff.ts';
import { RunnerClient, type RunnerFactory } from './runner/client.ts';
import { SkillStore } from './skills.ts';
import type { Answers, LiveSession, RunnerToHub } from '../../shared/protocol.ts';

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

export class Hub extends DeskCore {
  /** Questions between agents (desk_request). */
  readonly requests: AgentRequests;
  /** Terminal sessions attached over MCP, and sessions handed over to the desk. */
  readonly external: ExternalSessions;
  /** Read-only sources, independent of the runner. */
  readonly channels: Channels;
  /** Whether the connected runner can close a session on request (runners before it ignore the command). */
  private runnerCloses = false;
  /**
   * Sessions shown as lost because no runner connected in time after startup. Their queued messages
   * and open requests wait for the runner's actual report: it may still have them.
   */
  private presumedLost = new Set<string>();

  /**
   * `runner`: makes the runner connection (by default the daemon's, started if need be).
   * `graceMs`: how long after startup to wait for the runner before showing its sessions as lost.
   */
  constructor(store: Store, opts: { skills?: SkillStore; runner?: RunnerFactory; graceMs?: number; channelOptions?: ChannelOptions } = {}) {
    super(store, opts.skills ?? new SkillStore());
    this.requests = new AgentRequests(this, {
      dispatch: (sessionId, body, skills) => this.dispatch(sessionId, body, skills),
      drain: (sessionId) => this.drain(sessionId),
    });
    this.external = new ExternalSessions(this, (name, rootPath) => this.createProject(name, rootPath));
    this.channels = new Channels(store, (message) => this.publish(message), opts.channelOptions);
    this.runner = (opts.runner ?? ((onMessage, onConnection) => new RunnerClient(onMessage, onConnection)))(
      (m) => this.onRunnerMessage(m),
      (connected) => this.publish({ type: 'runner', connected }),
    );
    setTimeout(() => { if (!this.runner.connected) this.reconcile([], true); }, opts.graceMs ?? RUNNER_GRACE_MS).unref();
  }

  /** Compose syntax with the desk's skills as known #tags; `route`: the compose box's leading @mention. */
  parse(text: string, route = false) { return parseCompose(text ?? '', this.skills.names(), route); }

  /**
   * Applies the runner's view of live sessions after a (re)connect. `presumed`: no runner has
   * reported yet; sessions are only marked lost, and what waits on them is settled on the report.
   */
  private reconcile(sessions: LiveSession[], presumed = false) {
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
    const live = new Set(sessions.map((s) => s.sessionId));
    const gone = lost.map((r) => ({ id: r.id, task_id: r.task_id }));
    if (presumed) { for (const r of gone) this.presumedLost.add(r.id); gone.length = 0; }
    else {
      for (const id of this.presumedLost) {
        const s = this.store.getSession(id);
        if (s && !live.has(id)) gone.push({ id, task_id: s.task_id });
      }
      this.presumedLost.clear();
    }
    for (const r of gone) { this.requests.answerRequests(r.id, '대상 작업의 세션이 끝나'); this.dropQueue(r.id, r.task_id, '세션이 종료되어'); }
    for (const taskId of touched) this.publishTask(taskId);
    for (const sessionId of new Set(this.store.queued().map((q) => q.session_id))) this.drain(sessionId);
  }

  settings(): Settings {
    const get = (e: EngineName) => ({
      model: (this.store.setting(`${e}_model`) ?? null) as ModelName | null,
      effort: (this.store.setting(`${e}_effort`) ?? null) as Effort | null,
    });
    return Object.fromEntries(ENGINES.map((e) => [e, get(e)])) as Settings;
  }
  /** Only the engines and keys given change; null clears one. */
  setSettings(s: Partial<Record<EngineName, { model?: ModelName | null; effort?: Effort | null }>>): Settings {
    const engines = ENGINES.filter((e) => s[e]);
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
      const path = resolve(expandHome(c.mention.path));
      if (project && project.root_path !== path) {
        throw new HttpError(409, `@${project.name}은 이미 ${project.root_path}로 등록되어 있습니다`);
      }
      // Checked before the directory and project are made, so a request that fails leaves nothing behind.
      this.checkNewTask(c);
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

  /** Throws what would stop a new task from starting; returns its engine. */
  private checkNewTask(c: Composed, engine0?: EngineName): EngineName {
    this.requireRunner();
    if (!c.body && !c.skills.length) throw new HttpError(400, 'prompt is required');
    const engine = wantedEngine(c) ?? engine0 ?? DEFAULT_ENGINE;
    if (!this.runner.engines.has(engine)) {
      throw new HttpError(409, `지금 러너는 ${ENGINE_LABEL[engine]} 엔진을 실행하지 못합니다. 러너를 재시작하세요`);
    }
    const problem = modelProblem(engine, c);
    if (problem) throw new HttpError(400, problem);
    return engine;
  }

  /**
   * `text` may carry compose syntax; the agent receives it with the mention and mode tag removed.
   * `engine`: the engine when no tag picks one (else the default). `routed`: the compose box's text.
   */
  createTask(projectId: string, title: string, text: string, mode: PermissionMode = DEFAULT_MODE, engine0?: EngineName, routed = false, context?: ChannelContext) {
    const project = this.store.getProject(projectId);
    if (!project) throw new HttpError(404, 'project not found');
    const c = this.parse(text, routed);
    const engine = this.checkNewTask(c, engine0);
    const prompt = channelPrompt(c.body, context);
    const permissionMode = c.mode ?? mode;
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
      source: 'app', status: 'running', runner_id: this.runnerId, created_at: ts, permission_mode: permissionMode,
      model, effort,
    });
    this.addEvent(sessionId, task.id, 'user', {
      text: text.trim(), mode: permissionMode, skills: c.skills, delivery: c.delivery === 'new' ? 'new' : undefined,
      ...(context && { channel_context: context }),
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
   * Returns the id of the task that got the message. `routed`: the compose box's text.
   */
  sendMessage(taskId: string, text: string, routed = false, receipt?: MessageReceipt, context?: ChannelContext): string {
    const c = this.parse(text, routed);
    if (!c.body && !c.mode && !c.model && !c.effort && !c.skills.length) throw new HttpError(400, 'text is required');
    const session = this.store.latestSession(taskId);
    if (!session) throw new HttpError(404, 'task has no session');
    if (session.source !== 'app') throw new HttpError(409, 'external sessions are view-only');
    const engine = engineOf(session.engine);
    if (c.delivery === 'new') {
      if (!c.body && !c.skills.length) throw new HttpError(400, '#new로 맡길 지시를 함께 쓰세요');
      return this.createTask(this.store.getTask(taskId)!.project_id, '', text, c.mode, engine, routed).id;
    }
    if (c.engine && c.engine !== engine) {
      throw new HttpError(400, `이 작업은 ${ENGINE_LABEL[engine]}로 진행 중입니다. 엔진은 새 작업에서만 고를 수 있습니다`);
    }
    const problem = modelProblem(engine, c);
    if (problem) throw new HttpError(400, problem);
    this.requireRunner();
    if (c.delivery === 'fork') return this.fork(taskId, session, c, text);
    if (c.body || c.skills.length) c.body = channelPrompt(c.body, context);
    const live = this.runner.has(session.id);
    const busy = live && this.busy.has(session.id);
    const content = !!(c.body || c.skills.length);
    // Behind messages already waiting too, so they keep their order.
    const wait = content && c.delivery !== 'now' && (busy || this.store.queued({ sessionId: session.id }).length > 0);
    if (!wait) this.addEvent(session.id, taskId, 'user', { text: text.trim(), mode: c.mode, skills: c.skills, delivery: c.delivery, ...(context && { channel_context: context }) });

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
      const id = randomUUID();
      this.store.enqueue({
        id, task_id: taskId, session_id: session.id, text: text.trim(), body: c.body,
        skills: c.skills, mode: c.mode ?? null, created_at: now(),
        ...(context && { channel_context: context }),
      });
      if (receipt) receipt.queued_id = id;
      this.publishTask(taskId);
      this.drain(session.id);
    } else {
      this.dispatch(session.id, c.body, c.skills, busy && c.delivery === 'now');
    }
    return taskId;
  }

  /** One conversation per channel; source snapshots never go through compose/tag parsing. */
  sendChannelMessage(channelId: string, input: ChannelMessageInput) {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 32 * 1024)
      throw new HttpError(400, '질문을 입력해 주세요 (최대 32 KiB)');
    const context = channelContext(this.store, channelId, input.entry_ids);
    const c = this.parse(input.text);
    if (c.delivery === 'new' || c.delivery === 'fork') throw new HttpError(400, '채널 대화는 하나로 이어집니다. 별도 작업은 일반 작성창에서 시작해 주세요');
    if (!c.body && !c.skills.length) throw new HttpError(400, '자료에 대해 질문할 내용을 입력해 주세요');
    const channel = this.store.getChannel(channelId)!;
    const existing = channel.conversation_task_id && this.store.getTask(channel.conversation_task_id);
    const receipt: MessageReceipt = {};
    if (existing) {
      if (input.project_id && input.project_id !== existing.project_id) throw new HttpError(409, '이 채널의 대화는 이미 다른 프로젝트에 연결되어 있습니다');
      this.sendMessage(existing.id, input.text, false, receipt, context);
      return { task: this.taskView(this.store.getTask(existing.id)!), ...receipt };
    }
    if (typeof input.project_id !== 'string' || !input.project_id) throw new HttpError(400, '처음 대화할 프로젝트를 선택해 주세요');
    const task = this.createTask(input.project_id, `${channel.name} · 채널 대화`, input.text, DEFAULT_MODE, undefined, false, context);
    this.store.updateChannel(channelId, { conversation_task_id: task.id, updated_at: now() });
    this.publish({ type: 'channel', channel: this.store.getChannel(channelId)! });
    return { task };
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
    if (r) { this.requests.startRequest(r, q.session_id, delivery); return; }
    this.addEvent(q.session_id, q.task_id, 'user', {
      text: q.text, mode: q.mode ?? undefined, skills: q.skills, delivery, queued_at: q.created_at, ...(q.kind === 'handoff' && { handoff: 'request' }),
      ...(q.channel_context && { channel_context: q.channel_context }),
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
      this.requests.settleRequest(r, 'failed', `대상 작업에서 ${why} 질문을 전달하지 못했습니다.`);
    }
  }

  cancelQueued(taskId: string, queuedId: string) {
    const q = this.store.queued({ taskId }).find((x) => x.id === queuedId);
    if (!q || !this.store.dequeue(q.id)) throw new HttpError(404, '대기 중인 메시지가 없습니다. 이미 보냈을 수 있습니다');
    const r = this.store.openRequests().find((x) => x.queued_id === q.id);
    if (r) this.requests.settleRequest(r, 'denied', '사용자가 대기 중이던 질문을 취소했습니다.');
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
    const engine = engineOf(parent.engine);
    this.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: null, cwd: parent.cwd,
      source: 'app', status: 'running', runner_id: this.runnerId, created_at: ts, permission_mode: permissionMode,
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
      runner_id: this.runnerId, created_at: ts, permission_mode: old.permission_mode, model: old.model, effort: old.effort,
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
    const linkedChannels = this.channels.list().filter((channel) => channel.conversation_task_id && gone.has(channel.conversation_task_id));
    for (const r of this.store.openRequests()) {
      if (gone.has(r.to_task_id) && !gone.has(r.from_task_id)) this.requests.settleRequest(r, 'failed', '대상 작업이 삭제되었습니다.');
      else if (gone.has(r.from_task_id) && !gone.has(r.to_task_id)) {
        // The asker is gone: its question waiting in the target must not be sent as if from the user.
        if (r.queued_id && this.store.dequeue(r.queued_id)) this.publishTask(r.to_task_id);
        this.requests.settleRequest(r, 'failed', '질문한 작업이 삭제되었습니다.');
      }
    }
    for (const q of this.store.pendingQuestions()) if (gone.has(q.task_id)) this.external.settleQuestion(q, 'cancelled', null);
    this.store.deleteTasks(taskIds);
    if (projectId) this.store.deleteProject(projectId);
    this.publish({ type: 'removed', taskIds, projectIds: projectId ? [projectId] : [] });
    for (const channel of linkedChannels) this.publish({ type: 'channel', channel: this.store.getChannel(channel.id)! });
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
    if (approval.tool_name === REQUEST_TOOL) { this.requests.resolveRequest(approval, allow, message); return; }
    this.requireRunner();
    this.store.setApprovalStatus(approvalId, allow ? 'allowed' : 'denied');
    this.publish({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    this.addEvent(approval.session_id, approval.task_id, 'approval',
      { approvalId, toolName: approval.tool_name, decision: allow ? 'allowed' : 'denied', message,
        answers: maskSecretAnswers(approval.input, answers) });
    this.runner.handle({ type: 'approval_result', sessionId: approval.session_id, approvalId, allow, message, answers });
    if (this.store.pendingApprovals().every((a) => a.task_id !== approval.task_id)) {
      this.transition(approval.task_id, approval.session_id, 'approvals_cleared');
    }
  }

  private onRunnerMessage(m: RunnerToHub) {
    if (m.type === 'hello') {
      this.store.upsertRunner(m.runnerId, m.host, m.capabilities);
      this.runnerCloses = !!m.capabilities.close;
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
        if (m.event.kind === 'status' && m.event.state === 'error') this.transition(taskId, session.id, 'failed');
        if (m.event.kind === 'status' && m.event.state === 'interrupted') this.transition(taskId, session.id, 'interrupted');
        break;
      case 'busy':
        if (m.busy) {
          this.busy.add(session.id);
          this.transition(taskId, session.id, 'turn_started');
          break;
        }
        this.busy.delete(session.id);
        this.transition(taskId, session.id, 'turn_ended');
        this.requests.answerRequests(session.id);
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
        this.transition(taskId, session.id, 'approval_pending');
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
        this.requests.answerRequests(session.id, '대상 작업의 세션이 끝나');
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
          if (!this.transition(taskId, session.id, 'closed_by_user')) this.publishTask(taskId);
          break;
        }
        const midTurn = m.reason !== 'idle' && (m.busy ?? (status === 'running' || status === 'waiting'));
        if (m.error || midTurn) this.dropQueue(session.id, taskId, '세션이 종료되어');
        if (m.error) {
          this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'error', detail: { message: m.error } });
          this.transition(taskId, session.id, 'failed');
        } else if (midTurn) {
          this.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'error', detail: {
            message: '작업 도중 세션이 예기치 않게 종료되었습니다. 답글을 보내면 이어서 재개합니다.', reason: 'closed_mid_turn',
          } });
          this.transition(taskId, session.id, 'failed');
        } else {
          // Idle close or a finished session: status stays, the task just stops being live.
          this.publishTask(taskId);
        }
        break;
      }
    }
  }
}
