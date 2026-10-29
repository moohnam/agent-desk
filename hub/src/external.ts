// Terminal sessions (see mcp.ts): an agent running in a terminal attaches its work as a task, posts
// to it and asks the user; or hands the session over (desk_handoff), and the desk resumes it.

import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { Project, Question, Task, TaskView } from '../../shared/api.ts';
import { DEFAULT_ENGINE, DEFAULT_MODE, ENGINE_LABEL, HANDOFF_ENGINES, engineOf, type HandoffEngine } from '../../shared/compose.ts';
import { OWNER, type DeskCore } from './core.ts';
import { now } from './db.ts';
import { HttpError } from './errors.ts';
import { findSession } from './importer.ts';
import { expandHome } from './paths.ts';

export class ExternalSessions {
  private core: DeskCore;
  private createProject: (name: string, rootPath: string) => Project;
  constructor(core: DeskCore, createProject: (name: string, rootPath: string) => Project) {
    this.core = core;
    this.createProject = createProject;
  }


  /** The external session of `taskId`; app tasks cannot be driven over MCP. */
  private externalSession(taskId: string) {
    const session = this.core.store.latestSession(taskId);
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
    const cwd = resolve(expandHome(a.cwd));
    const engine = engineOf(a.engine);
    if (a.taskId) {
      const session = this.externalSession(a.taskId);
      if (a.title?.trim()) this.core.store.setTaskTitle(a.taskId, a.title.trim().slice(0, 120));
      this.core.addEvent(session.id, a.taskId, 'status', { kind: 'status', state: 'started', detail: { source: 'external', engine, cwd } });
      this.core.addEvent(session.id, a.taskId, 'assistant', { text: a.summary.trim(), via: 'mcp' });
      this.core.setStatus(a.taskId, session.id, 'running');
      return this.core.taskView(this.core.store.getTask(a.taskId)!);
    }
    const project = this.core.store.projectsContaining(cwd)[0] ?? this.createProject(this.freeProjectName(basename(cwd) || 'root'), cwd);
    const ts = now();
    const task = this.core.store.createTask({
      id: randomUUID(), project_id: project.id, title: (a.title?.trim() || a.summary.trim()).slice(0, 120),
      status: 'running', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
    });
    const sessionId = randomUUID();
    this.core.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: null, cwd, source: 'external',
      status: 'running', runner_id: 'mcp', created_at: ts, permission_mode: DEFAULT_MODE,
      model: null, effort: null,
    });
    this.core.addEvent(sessionId, task.id, 'status', { kind: 'status', state: 'started', detail: { source: 'external', engine, cwd } });
    this.core.addEvent(sessionId, task.id, 'assistant', { text: a.summary.trim(), via: 'mcp' });
    return this.core.taskView(this.core.store.getTask(task.id)!);
  }

  private freeProjectName(base: string) {
    let name = base;
    for (let i = 2; this.core.store.findProjectByName(name); i++) name = `${base}-${i}`;
    return name;
  }

  postExternal(taskId: string, text: string) {
    if (!text?.trim()) throw new HttpError(400, 'text가 필요합니다');
    const session = this.externalSession(taskId);
    this.core.addEvent(session.id, taskId, 'assistant', { text: text.trim(), via: 'mcp' });
    if (this.core.store.getTask(taskId)?.status !== 'waiting') this.core.setStatus(taskId, session.id, 'running');
  }

  checkpoint(taskId: string, summary: string, nextSteps: string[] = []) {
    if (!summary?.trim()) throw new HttpError(400, 'summary가 필요합니다');
    const session = this.externalSession(taskId);
    const md = [`**체크포인트**`, summary.trim(), ...(nextSteps.length ? ['**다음 단계**', nextSteps.map((s) => `- ${s}`).join('\n')] : [])].join('\n\n');
    this.core.store.setCheckpoint(taskId, md);
    this.core.addEvent(session.id, taskId, 'assistant', { text: md, via: 'mcp', checkpoint: true });
  }

  ask(taskId: string, text: string): Question {
    if (!text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const session = this.externalSession(taskId);
    const question: Question = {
      id: randomUUID(), session_id: session.id, task_id: taskId, text: text.trim(),
      status: 'pending', answer: null, created_at: now(), answered_at: null,
    };
    this.core.store.createQuestion(question);
    this.core.publish({ type: 'question', question });
    this.core.addEvent(session.id, taskId, 'question', { questionId: question.id, text: question.text, decision: 'pending' });
    this.core.setStatus(taskId, session.id, 'waiting');
    return question;
  }

  /** Resolves with the question once it is no longer pending, or as is after `timeoutMs`. */
  waitAnswer(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<Question> {
    return this.core.waitFor(questionId, () => this.core.store.getQuestion(questionId), (q) => q.status !== 'pending', timeoutMs, signal);
  }

  answerQuestion(questionId: string, answer: string) {
    const q = this.core.store.getQuestion(questionId);
    if (!q || q.status !== 'pending') throw new HttpError(404, '대기 중인 질문이 없습니다');
    if (!answer?.trim()) throw new HttpError(400, 'answer가 필요합니다');
    this.settleQuestion(q, 'answered', answer.trim());
    this.core.addEvent(q.session_id, q.task_id, 'user', { text: answer.trim(), answers: questionId });
    if (!this.core.store.pendingQuestions().some((x) => x.task_id === q.task_id)) this.core.setStatus(q.task_id, q.session_id, 'running');
  }

  settleQuestion(q: Question, status: 'answered' | 'cancelled', answer: string | null) {
    this.core.store.setQuestionStatus(q.id, status, answer);
    const settled = this.core.store.getQuestion(q.id)!;
    this.core.publish({ type: 'question', question: settled });
    this.core.wake(q.id);
  }

  /** Ends an attached task; questions still open are cancelled. */
  finishExternal(taskId: string, summary?: string) {
    const session = this.externalSession(taskId);
    for (const q of this.core.store.pendingQuestions().filter((x) => x.task_id === taskId)) {
      this.settleQuestion(q, 'cancelled', null);
      this.core.addEvent(session.id, taskId, 'question', { questionId: q.id, text: q.text, decision: 'cancelled' });
    }
    if (summary?.trim()) this.core.addEvent(session.id, taskId, 'assistant', { text: summary.trim(), via: 'mcp' });
    this.core.addEvent(session.id, taskId, 'status', { kind: 'status', state: 'finished', detail: { summary: summary?.trim() } });
    this.core.setStatus(taskId, session.id, 'done');
  }

  /**
   * Takes over a terminal Claude Code or Codex session: a desk task that resumes the same engine
   * conversation, with its history (tool calls as names only) in the thread. `id`: the engine's
   * session id; without it, the newest session that ran in `cwd`. With `taskId` (an attached task)
   * that task continues as the desk's instead of a new one, keeping its posts and skipping the history.
   */
  handoff(a: { engine?: string; sessionId?: string; cwd: string; title?: string; summary?: string; taskId?: string }) {
    if (!a.cwd?.trim()) throw new HttpError(400, 'cwd가 필요합니다');
    const engine = (a.engine ?? DEFAULT_ENGINE) as HandoffEngine;
    if (!HANDOFF_ENGINES.includes(engine)) throw new HttpError(400, `${engine} 세션은 넘겨받을 수 없습니다 (${HANDOFF_ENGINES.join(', ')}만 지원)`);
    const cwd0 = resolve(expandHome(a.cwd));
    let found;
    try { found = findSession(engine, a.sessionId?.trim() || undefined, cwd0); }
    catch (err) { throw new HttpError(404, err instanceof Error ? err.message : String(err)); }
    const existing = this.core.store.sessionByEngineId(found.id);
    if (existing?.source === 'app') {
      return { task: this.core.taskView(this.core.store.getTask(existing.task_id)!), sessionId: found.id, imported: 0, already: true };
    }
    // The engine resumes a conversation from the directory it ran in.
    const cwd = found.cwd ?? cwd0;
    const ts = now();
    let task: Task;
    if (a.taskId) {
      const old = this.externalSession(a.taskId);
      for (const q of this.core.store.pendingQuestions().filter((x) => x.task_id === a.taskId)) {
        this.settleQuestion(q, 'cancelled', null);
        this.core.addEvent(old.id, a.taskId, 'question', { questionId: q.id, text: q.text, decision: 'cancelled' });
      }
      this.core.store.updateSession(old.id, { status: 'done' });
      if (a.title?.trim()) this.core.store.setTaskTitle(a.taskId, a.title.trim().slice(0, 120));
      task = this.core.store.getTask(a.taskId)!;
    } else {
      const project = this.core.store.projectsContaining(cwd)[0] ?? this.createProject(this.freeProjectName(basename(cwd) || 'root'), cwd);
      const firstUser = found.events.find((e) => e.kind === 'user')?.text ?? '';
      task = this.core.store.createTask({
        id: randomUUID(), project_id: project.id,
        title: (a.title?.trim() || firstUser.split('\n')[0] || `${ENGINE_LABEL[engine]} 세션`).slice(0, 120),
        status: 'idle', checkpoint_md: null, created_by: OWNER, created_at: ts, updated_at: ts,
      });
    }
    const sessionId = randomUUID();
    this.core.store.createSession({
      id: sessionId, task_id: task.id, engine, engine_session_id: found.id, cwd,
      source: 'app', status: 'idle', runner_id: this.core.runnerId, created_at: ts,
      permission_mode: DEFAULT_MODE, model: null, effort: null,
    });
    const history = a.taskId ? [] : found.events;
    this.core.store.importEvents(sessionId, task.id, history.map((e) => ({
      ts: e.ts, kind: e.kind, payload: e.kind === 'tool' ? { kind: 'tool', name: e.name } : { text: e.text },
    })));
    this.core.addEvent(sessionId, task.id, 'status', { kind: 'status', state: 'handoff', detail: {
      engine, engine_session_id: found.id, cwd, imported: history.length,
    } });
    const note = `터미널 ${ENGINE_LABEL[engine]} 세션을 넘겨받았습니다${history.length ? ` (기록 ${history.length}건)` : ''}. 답글을 쓰면 같은 대화로 이어집니다.`;
    this.core.addEvent(sessionId, task.id, 'assistant', { text: a.summary?.trim() ? `${note}\n\n${a.summary.trim()}` : note, via: 'handoff' });
    this.core.setStatus(task.id, sessionId, 'idle');
    return { task: this.core.taskView(this.core.store.getTask(task.id)!), sessionId: found.id, imported: history.length, already: false };
  }
}
