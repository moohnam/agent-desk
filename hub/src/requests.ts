// Questions between agents (desk_request, see mcp.ts): one agent asks another task's agent through
// the desk, the user allows it unless they named the target, and the target's last reply in the turn
// that takes the question is the answer.

import { randomUUID } from 'node:crypto';
import type { Approval, Task } from '../../shared/api.ts';
import { REQUEST_TOOL, mentionsIn } from '../../shared/compose.ts';
import type { DeskCore } from './core.ts';
import { now, type AgentRequest, type Session } from './db.ts';
import { HttpError } from './errors.ts';

/** How a question reaches the target's session: the hub's message delivery (hub.ts). */
export interface Delivery {
  /** Sends `body` to the session now, resuming it if it isn't live. */
  dispatch(sessionId: string, body: string, skills: string[]): void;
  /** Sends the session's oldest waiting message if it has no turn running. */
  drain(sessionId: string): void;
}

export class AgentRequests {
  private core: DeskCore;
  private delivery: Delivery;
  constructor(core: DeskCore, delivery: Delivery) {
    this.core = core;
    this.delivery = delivery;
  }


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
      throw new HttpError(409, `@${this.core.taskLabel(to.task)}가 이 작업의 답을 기다리는 중이라, 물으면 서로 기다리게 됩니다. 그 질문에 먼저 답하세요`);
    }
    this.core.requireRunner(to.session.id);
    const r: AgentRequest = {
      id: randomUUID(), from_task_id: from.task_id, from_session_id: from.id, to_task_id: to.task.id, to_session_id: to.session.id,
      text: a.text.trim(), status: 'approval', answer: null, approval_id: null, queued_id: null, prompt_event_id: null,
      created_at: now(), answered_at: null,
    };
    if (this.allowedByUser(from.task_id, to.task)) {
      this.core.store.createRequest(r);
      this.deliverRequest(r);
    } else {
      const approval: Approval = {
        id: randomUUID(), session_id: from.id, task_id: from.task_id, tool_name: REQUEST_TOOL,
        input: { to: `@${this.core.taskLabel(to.task)}`, title: to.task.title, description: r.text }, status: 'pending', created_at: now(),
      };
      this.core.store.createApproval(approval);
      this.core.store.createRequest({ ...r, approval_id: approval.id });
      this.core.publish({ type: 'approval', approval });
      this.core.addEvent(from.id, from.task_id, 'approval',
        { approvalId: approval.id, toolName: REQUEST_TOOL, input: approval.input, decision: 'pending' });
      this.core.transition(from.task_id, from.id, 'approval_pending');
    }
    return this.core.store.getRequest(r.id)!;
  }

  private requester(a: { fromTaskId?: string; sessionId?: string }): Session {
    if (!a.fromTaskId?.trim() && !a.sessionId?.trim()) {
      throw new HttpError(400, 'task_id(데스크에 붙은 작업) 또는 session_id(데스크가 실행한 작업의 세션 ID)가 필요합니다');
    }
    const s = a.fromTaskId?.trim() ? this.core.store.latestSession(a.fromTaskId.trim()) : this.core.store.sessionByEngineId(a.sessionId!.trim());
    if (!s) throw new HttpError(404, '묻는 작업을 데스크에서 찾지 못했습니다. 데스크에 붙은 작업이면 task_id를, 데스크가 실행한 작업이면 session_id를 확인하세요');
    return s;
  }

  private requestTarget(to: string): { task: Task; session: Session } {
    const t = to?.trim() ?? '';
    let task = this.core.store.getTask(t);
    if (!task) {
      const m = /^@?([^\s:@#]+)(?:#(\d+))?$/.exec(t);
      if (!m) throw new HttpError(400, 'to에는 @프로젝트, @프로젝트#번호 또는 task_id를 쓰세요');
      const project = this.core.store.findProjectByName(m[1]);
      if (!project) throw new HttpError(404, `등록되지 않은 프로젝트입니다: @${m[1]}`);
      task = m[2] ? this.core.store.taskBySeq(project.id, Number(m[2]))
        : this.core.store.listTasks().filter((x) => x.project_id === project.id && this.core.store.latestSession(x.id)?.source === 'app')
          .sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
      if (!task) {
        throw new HttpError(404, m[2] ? `@${project.name}#${m[2]} 작업이 없습니다` : `@${project.name}에는 데스크가 실행하는 작업이 없어 물을 곳이 없습니다`);
      }
    }
    const session = this.core.store.latestSession(task.id);
    if (!session) throw new HttpError(404, `@${this.core.taskLabel(task)}에 세션이 없습니다`);
    if (session.source !== 'app') {
      throw new HttpError(409, `@${this.core.taskLabel(task)}는 터미널에서 붙은 작업이라 데스크가 질문을 넣을 수 없습니다. 데스크가 실행하는 작업을 지정하세요`);
    }
    return { task, session };
  }

  /** Whether task `a` waits, through open requests, on an answer from task `b`. */
  private waitsOn(a: string, b: string): boolean {
    const open = this.core.store.openRequests();
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
    const p = this.core.store.lastEventOf(fromTaskId, 'user')?.payload as { text?: string; request?: unknown } | undefined;
    if (!p?.text || p.request) return false;
    const own = this.core.store.getTask(fromTaskId)!.project_id;
    return mentionsIn(p.text).some((m) => {
      const project = this.core.store.findProjectByName(m.name);
      if (!project || project.id !== to.project_id) return false;
      return m.no ? m.no === to.seq : project.id !== own;
    });
  }

  /** What the target agent receives. */
  private requestPrompt(r: AgentRequest) {
    const from = this.core.store.getTask(r.from_task_id)!;
    const cwd = this.core.store.getSession(r.from_session_id)?.cwd;
    return `데스크를 통해 다른 작업(@${this.core.taskLabel(from)} "${from.title}"${cwd ? `, ${cwd}` : ''})의 에이전트가 질문을 보냈습니다. `
      + '이번 응답의 마지막 메시지가 그대로 그 에이전트에게 답으로 전달되니, 마지막 메시지에 답을 완결해서 쓰세요. '
      + `답하는 데 필요한 만큼만 확인하고, 하던 작업의 방향은 바꾸지 마세요.\n\n질문:\n${r.text}`;
  }

  /** Sends an allowed request to the target: now when it is free, else after the messages waiting there. */
  deliverRequest(r: AgentRequest) {
    const session = this.core.store.latestSession(r.to_task_id)!;
    const busy = this.core.runner.has(session.id) && this.core.busy.has(session.id);
    if (!(this.core.runner.ready?.(session.id) ?? this.core.runner.connected) || busy || this.core.store.queued({ sessionId: session.id }).length) {
      const id = randomUUID();
      this.core.store.enqueue({
        id, task_id: r.to_task_id, session_id: session.id, text: `@${this.core.taskLabel(this.core.store.getTask(r.from_task_id)!)}의 질문: ${r.text}`,
        body: this.requestPrompt(r), skills: [], mode: null, created_at: now(),
      });
      this.core.store.updateRequest(r.id, { status: 'queued', queued_id: id, to_session_id: session.id });
      this.core.publishTask(r.to_task_id);
      this.delivery.drain(session.id);
    } else {
      this.startRequest(r, session.id);
      this.delivery.dispatch(session.id, this.requestPrompt(r), []);
    }
  }

  /** Records the request as the target's `user` message; the turn it starts answers it. */
  startRequest(r: AgentRequest, sessionId: string, delivery?: 'now' | 'later') {
    const from = this.core.store.getTask(r.from_task_id)!;
    const e = this.core.addEvent(sessionId, r.to_task_id, 'user', {
      text: r.text, delivery, request: { id: r.id, task_id: from.id, from: this.core.taskLabel(from), title: from.title },
    });
    this.core.store.updateRequest(r.id, { status: 'running', prompt_event_id: e.id, to_session_id: sessionId });
  }

  /**
   * A turn of `sessionId` ended: the requests it took get its last reply as their answer. `endedWhy`:
   * the session ended instead, so they get no answer.
   */
  answerRequests(sessionId: string, endedWhy?: string) {
    for (const r of this.core.store.openRequests().filter((x) => x.status === 'running' && x.to_session_id === sessionId)) {
      if (endedWhy) { this.settleRequest(r, 'failed', `${endedWhy} 답을 받지 못했습니다.`); continue; }
      const after = this.core.store.listEvents(r.to_task_id, 0, (r.prompt_event_id ?? 0) + 1);
      const stopped = after.find((e) => e.kind === 'status' && ['error', 'interrupted'].includes((e.payload as { state?: string }).state ?? ''));
      const reply = after.filter((e) => e.kind === 'assistant').at(-1)?.payload as { text?: string } | undefined;
      if (stopped) {
        this.settleRequest(r, 'failed', `대상 작업이 ${(stopped.payload as { state: string }).state === 'error' ? '오류로 멈춰' : '중단되어'} 답을 받지 못했습니다.`);
      } else if (reply?.text?.trim()) this.settleRequest(r, 'answered', reply.text.trim());
      else this.settleRequest(r, 'failed', '대상 에이전트가 답 없이 턴을 마쳤습니다.');
    }
  }

  settleRequest(r: AgentRequest, status: 'answered' | 'denied' | 'failed', answer: string) {
    this.core.store.updateRequest(r.id, { status, answer, answered_at: now() });
    this.core.wake(r.id);
  }

  /** The user allowed or denied a request's card. */
  resolveRequest(approval: Approval, allow: boolean, message?: string) {
    const r = this.core.store.openRequests().find((x) => x.approval_id === approval.id);
    if (allow && r) this.core.requireRunner(r.to_session_id);
    this.core.store.setApprovalStatus(approval.id, allow ? 'allowed' : 'denied');
    this.core.publish({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    this.core.addEvent(approval.session_id, approval.task_id, 'approval',
      { approvalId: approval.id, toolName: approval.tool_name, decision: allow ? 'allowed' : 'denied', message });
    if (r && allow) {
      try { this.deliverRequest(r); }
      catch (err) { this.settleRequest(r, 'failed', `전달하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`); }
    } else if (r) this.settleRequest(r, 'denied', message ? `사용자가 거절했습니다: ${message}` : '사용자가 거절했습니다.');
    if (this.core.store.pendingApprovals().every((a) => a.task_id !== approval.task_id)) {
      this.core.transition(approval.task_id, approval.session_id, 'approvals_cleared');
    }
  }

  /** Resolves with the request once it is settled, or as it is after `timeoutMs`. */
  waitRequest(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentRequest> {
    return this.core.waitFor(requestId, () => this.core.store.getRequest(requestId),
      (r) => r.status === 'answered' || r.status === 'denied' || r.status === 'failed', timeoutMs, signal);
  }
}
