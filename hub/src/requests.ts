// Questions between agents (desk_request, see mcp.ts): one agent asks another task's agent through
// the desk, the user allows it unless they named the target, and the target explicitly replies by ID.

import { randomBytes, randomUUID } from 'node:crypto';
import { credentialDigest, verifyRequest, toolFields } from './request-proof.ts';
import type { Approval, Task } from '../../shared/api.ts';
import { REQUEST_TOOL, mentionsIn } from '../../shared/compose.ts';
import type { DeskCore } from './core.ts';
import { now, type AgentRequest, type Session } from './db.ts';
import { HttpError } from './errors.ts';

const BACKGROUND_CONTINUATION_MS = 15_000;

/** How a question reaches the target's session: the hub's message delivery (hub.ts). */
export interface Delivery {
  /** Sends `body` to the session now, resuming it if it isn't live. */
  dispatch(sessionId: string, body: string, skills: string[], steer?: boolean): void;
  /** Sends the session's oldest waiting message if it has no turn running. */
  drain(sessionId: string): void;
  scheduleResume(sessionId:string): void;
  ready(sessionId: string): boolean;
  connected(sessionId: string): boolean;
  bindApproval?(approvalId: string, sessionId: string): void;
}

export interface CrossPeer {
  requireSignedReply?: boolean;
  task_id: string; session_id: string; project_name: string; seq: number; title: string; cwd: string;
}

export class AgentRequests {
  private core: DeskCore;
  private delivery: Delivery;
  private backgroundFinishing = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  constructor(core: DeskCore, delivery: Delivery) {
    this.core = core;
    this.delivery = delivery;
    core.store.database.exec(`CREATE TABLE IF NOT EXISTS request_cross (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, peer_json TEXT NOT NULL, target_label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_origin_peer(id TEXT PRIMARY KEY REFERENCES request(id) ON DELETE CASCADE,peer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_verified(id TEXT PRIMARY KEY REFERENCES request(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS request_identity(session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,digest TEXT NOT NULL,bound INTEGER NOT NULL DEFAULT 0,stopped_at_input INTEGER);
      CREATE INDEX IF NOT EXISTS request_cross_role ON request_cross(role);
      CREATE TABLE IF NOT EXISTS request_dedupe (
        from_task_id TEXT NOT NULL, user_event_id INTEGER NOT NULL, to_task_id TEXT NOT NULL,
        text TEXT NOT NULL, request_id TEXT NOT NULL,
        PRIMARY KEY (from_task_id,user_event_id,to_task_id,text),
        FOREIGN KEY (request_id) REFERENCES request(id) ON DELETE CASCADE);`);
  }

  /** A managed engine receives this credential through its private MCP headers. */
  sessionCredential(sessionId: string) {
    const token = randomBytes(32).toString('base64url');
    this.core.store.database.prepare('INSERT INTO request_identity(session_id,digest) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET digest=excluded.digest,bound=0')
      .run(sessionId, credentialDigest(token));
    return token;
  }

  proven(session: Session, fields: readonly unknown[], proof: unknown) {
    const row = this.core.store.database.prepare('SELECT digest FROM request_identity WHERE session_id=?').get(session.id);
    return typeof row?.digest === 'string' && verifyRequest(row.digest,fields,proof);
  }

  bindEngine(session: Session, proof: unknown) {
    if (this.proven(session,['bound',session.id],proof))
      this.core.store.database.prepare('UPDATE request_identity SET bound=1 WHERE session_id=?').run(session.id);
  }

  private authorizeResume(id: string, session: Session, fields: readonly unknown[], proof: unknown) {
    if (session.source !== 'app' || this.core.store.latestSession(session.task_id)?.id !== session.id
      || !this.proven(session,fields,proof)) return false;
    const db = this.core.store.database;
    const stopped = db.prepare('SELECT stopped_at_input FROM request_identity WHERE session_id=?').get(session.id)?.stopped_at_input;
    if (typeof stopped === 'number' && stopped >= (this.core.store.lastUserMessageId(session.task_id) ?? 0)) return false;
    const request = this.core.store.getRequest(id);
    if (request && (request.from_session_id !== session.id || this.crossRole(id) === 'target')) return false;
    db.prepare("INSERT OR IGNORE INTO request_resume(id,session_id,state,proof) VALUES (?,?,'waiting',?)").run(id,session.id,proof as string);
    this.core.store.origins.with(this.core.store.origins.run(session.id),()=>this.core.store.origins.remember('resume:'+id));
    return this.resumeState(id) === 'waiting';
  }

  resumeState(id: string) {
    return (this.core.store.database.prepare('SELECT state FROM request_resume WHERE id=?').get(id) as {state:string}|undefined)?.state;
  }

  cancelResumes(sessionId: string) {
    const session = this.core.store.getSession(sessionId);
    if (session) this.core.store.database.prepare('UPDATE request_identity SET stopped_at_input=? WHERE session_id=?')
      .run(this.core.store.lastUserMessageId(session.task_id) ?? 0,sessionId);
    return !!this.core.store.database.prepare("UPDATE request_resume SET state='cancelled' WHERE session_id=? AND state IN ('waiting','pending','sent','received','uncertain','held')").run(sessionId).changes;
  }

  unconfirmed() {
    return this.core.store.database.prepare("SELECT id,session_id FROM request_resume WHERE state IN ('sent','received','uncertain','held')")
      .all() as {id:string;session_id:string}[];
  }

  markUncertain(id:string,sessionId:string) {
    return !!this.core.store.database.prepare("UPDATE request_resume SET state=CASE state WHEN 'received' THEN 'held' ELSE 'uncertain' END WHERE id=? AND session_id=? AND state IN ('received','sent')")
      .run(id,sessionId).changes;
  }

  retryMissing(id:string,sessionId:string,stream?:string) {
    // A lost receipt after a known acceptance is ambiguous, even with an empty runner journal.
    return !!this.core.store.database.prepare("UPDATE request_resume SET state='pending' WHERE id=? AND session_id=? AND state='uncertain' AND stream=?")
      .run(id,sessionId,stream ?? null).changes;
  }

  pendingSessions() {
    return (this.core.store.database.prepare("SELECT DISTINCT session_id FROM request_resume WHERE state='pending'").all() as {session_id:string}[]).map(r=>r.session_id);
  }

  nextResume(sessionId: string) {
    const row = this.core.store.database.prepare("SELECT id FROM request_resume WHERE session_id=? AND state='pending' ORDER BY rowid LIMIT 1").get(sessionId) as {id:string}|undefined;
    return row && this.core.store.getRequest(row.id);
  }

  markResume(id: string, state: 'sent'|'received'|'started'|'cancelled', sessionId: string, stream?:string) {
    const before = state === 'sent' ? ['pending'] : state === 'received' ? ['sent','uncertain'] : state === 'started' ? ['sent','received','uncertain','held'] : ['waiting','pending','sent','received'];
    return !!this.core.store.database.prepare(`UPDATE request_resume SET state=?,stream=coalesce(?,stream) WHERE id=? AND session_id=? AND state IN (${before.map(()=>'?').join(',')})`)
      .run(state,stream ?? null,id,sessionId,...before).changes;
  }

  dispose() {
    for (const timer of this.backgroundFinishing.values()) clearTimeout(timer);
    this.backgroundFinishing.clear();
  }

  cancelBackgroundFinish(sessionId: string) {
    clearTimeout(this.backgroundFinishing.get(sessionId));
    this.backgroundFinishing.delete(sessionId);
  }

  awaitsContinuation(sessionId: string) { return this.backgroundFinishing.has(sessionId); }
  hasContinuation() { return this.backgroundFinishing.size > 0; }

  backgroundFinished(sessionId: string, pending?: ReadonlySet<string>) {
    if (this.core.busy.has(sessionId) || this.backgroundFinishing.get(sessionId)) return;
    if (!(pending?.has(sessionId) ?? this.core.store.openRequests().some(r => r.status === 'running' && r.to_session_id === sessionId))) return;
    // The engine may announce completion before it starts a separate turn to read the results.
    const timer = setTimeout(() => {
      if (!this.delivery.connected(sessionId)) {
        // Reconciliation will restart the wait after the runner reports its current state.
        this.backgroundFinishing.set(sessionId, undefined);
        return;
      }
      this.backgroundFinishing.delete(sessionId);
      if (this.core.busy.has(sessionId) || this.core.background.has(sessionId)) return;
      this.answerRequests(sessionId);
      this.delivery.drain(sessionId);
    }, BACKGROUND_CONTINUATION_MS);
    timer.unref();
    this.backgroundFinishing.set(sessionId, timer);
  }

  private cross(id: string): { role: string; peer: CrossPeer; target_label: string } | undefined {
    const row = this.core.store.database.prepare('SELECT role,peer_json,target_label FROM request_cross WHERE id=?').get(id) as
      { role: string; peer_json: string; target_label: string } | undefined;
    return row && { role: row.role, peer: JSON.parse(row.peer_json) as CrossPeer, target_label: row.target_label };
  }

  /** The origin owns the approval and final answer, even when the target belongs to another workspace. */
  requestCross(id: string, a: { text: string; fromTaskId?: string; sessionId?: string; target: CrossPeer;
    proof?: unknown; originSession?: string; explicitMention: boolean; userEventId?: number | null }): AgentRequest {
    if (!a.text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const from = this.requester(a);
    if (from.task_id === a.target.task_id) throw new HttpError(400, '자기 작업에는 물을 수 없습니다');
    const label = `${a.target.project_name}#${a.target.seq}`;
    const old = this.core.store.getRequest(id);
    if (old) {
      const meta = this.cross(id);
      if (meta?.role !== 'origin' || old.from_task_id !== from.task_id || old.to_task_id !== a.target.task_id || old.text !== a.text.trim())
        throw new HttpError(409, '같은 요청 ID의 내용이 바뀌었습니다');
      return old;
    }
    const r: AgentRequest = {
      id, from_task_id: from.task_id, from_session_id: from.id, to_task_id: a.target.task_id,
      to_session_id: a.target.session_id, text: a.text.trim(), status: 'approval', answer: null,
      approval_id: null, queued_id: null, prompt_event_id: null, created_at: now(), answered_at: null,
    };
    if (a.originSession && from.id !== a.originSession) throw new HttpError(410,'문의를 시작한 세션이 교체되었습니다');
    if (from.id === a.originSession && a.userEventId === (this.core.store.lastEventOf(from.task_id,'user')?.id ?? null))
      this.authorizeResume(id,from,['cross',id,from.id,a.target.task_id,r.text],a.proof);
    // Only a verified mention in the user's current message can skip approval.
    const allowed = a.explicitMention && this.allowedCrossMention(from.task_id, a.target, a.userEventId);
    if (allowed) r.status = 'queued';
    else {
      const approval: Approval = { id: randomUUID(), session_id: from.id, task_id: from.task_id,
        tool_name: REQUEST_TOOL, input: { to: `@${label}`, title: a.target.title, description: r.text },
        status: 'pending', created_at: now() };
      r.approval_id = approval.id;
      this.core.store.createApproval(approval);
      this.delivery.bindApproval?.(approval.id, from.id);
      this.core.publish({ type: 'approval', approval });
      this.core.addEvent(from.id, from.task_id, 'approval',
        { approvalId: approval.id, toolName: REQUEST_TOOL, input: approval.input, decision: 'pending' });
      this.core.transition(from.task_id, from.id, 'approval_pending');
    }
    this.core.store.origins.with(this.core.store.origins.current() ?? this.core.store.origins.run(r.from_session_id),()=>this.core.store.origins.remember(r.id));
    this.core.store.createRequest(r);
    this.core.store.database.prepare('INSERT INTO request_cross VALUES (?,?,?,?)')
      .run(id, 'origin', JSON.stringify(a.target), label);
    return this.core.store.getRequest(id)!;
  }

  private allowedCrossMention(fromTaskId: string, target: CrossPeer, userEventId?: number | null) {
    const event = this.core.store.lastEventOf(fromTaskId, 'user');
    if (event && this.resumedAfter(fromTaskId,event.id)) return false;
    if (userEventId !== undefined && event?.id !== userEventId) return false;
    const p = event?.payload as { text?: string; request?: unknown } | undefined;
    if (!p?.text || p.request) return false;
    const own = this.core.store.getTask(fromTaskId);
    const ownName = own && this.core.store.getProject(own.project_id)?.name;
    return mentionsIn(p.text).some(m => m.name.toLowerCase() === target.project_name.toLowerCase()
      && (m.no ? m.no === target.seq : ownName?.toLowerCase() !== target.project_name.toLowerCase()));
  }

  /** The target owns the delivery queue and resulting turn. Replayed receives never dispatch twice. */
  receiveCross(id: string, a: { text: string; from: CrossPeer; toTaskId: string }): AgentRequest {
    if (!a.text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const task = this.core.store.getTask(a.toTaskId);
    if (!task) throw new HttpError(404, '대상 작업이 없습니다');
    const session = this.core.store.latestSession(task.id);
    if (!session) throw new HttpError(404, '대상 세션이 없습니다');
    if (session.source !== 'app') throw new HttpError(409, '대상은 데스크가 실행하는 작업이어야 합니다');
    const old = this.core.store.getRequest(id);
    if (old) {
      const meta = this.cross(id);
      if (meta?.role !== 'target' || old.from_task_id !== a.from.task_id || old.to_task_id !== task.id || old.text !== a.text.trim())
        throw new HttpError(409, '같은 요청 ID의 내용이 바뀌었습니다');
      return old;
    }
    if (session.engine === 'agy') throw new HttpError(409, 'Antigravity 작업은 desk_reply 연결을 지원하지 않아 문의를 받을 수 없습니다');
    const r: AgentRequest = { id, from_task_id: a.from.task_id, from_session_id: a.from.session_id,
      to_task_id: task.id, to_session_id: session.id, text: a.text.trim(), status: 'queued', answer: null,
      approval_id: null, queued_id: null, prompt_event_id: null, created_at: now(), answered_at: null };
    this.core.store.origins.with(this.core.store.origins.current() ?? this.core.store.origins.run(r.from_session_id),()=>this.core.store.origins.remember(r.id));
    this.core.store.createRequest(r);
    this.core.store.database.prepare('INSERT INTO request_cross VALUES (?,?,?,?)')
      .run(id, 'target', JSON.stringify(a.from), this.core.taskLabel(task));
    this.deliverRequest(r);
    return this.core.store.getRequest(id)!;
  }

  crossRole(id: string) { return this.cross(id)?.role; }

  settleCrossOrigin(id: string, status: 'answered' | 'denied' | 'failed', answer: string, verified = false) {
    const r = this.core.store.getRequest(id);
    if (!r || this.cross(id)?.role !== 'origin') throw new HttpError(404, '요청한 작업의 질문이 없습니다');
    if (r.status === 'answered' || r.status === 'denied' || r.status === 'failed') return r;
    if (status === 'answered' && !verified) this.markResume(id,'cancelled',r.from_session_id);
    if (r.status === 'approval') throw new HttpError(409, '사용자 승인을 기다리는 질문입니다');
    this.settleRequest(r, status, answer);
    return this.core.store.getRequest(id)!;
  }


  /**
   * One agent asks another task's agent. `to`: '@project' (its latest desk-run task), '@project#N' or a
   * task id. The asker is `fromTaskId` (an attached task) or the engine session `sessionId` (a task the
   * desk runs). It goes to the target after the user names it with @ or allows it on a card.
   * A live target receives it in its current turn; the target replies by request ID.
   */
  request(a: { to: string; text: string; fromTaskId?: string; sessionId?: string; resumeProof?: unknown }): AgentRequest {
    if (!a.text?.trim()) throw new HttpError(400, 'question이 필요합니다');
    const from = this.requester(a);
    const to = this.requestTarget(a.to);
    if (to.task.id === from.task_id) throw new HttpError(400, '자기 작업에는 물을 수 없습니다');
    const userEventId = this.core.store.lastUserMessageId(from.task_id) ?? 0;
    const question = a.text.trim();
    const open = this.core.store.openRequests().find((r) => r.from_task_id === from.task_id
      && r.to_task_id === to.task.id && r.text === question);
    if (open) return open;
    const previous = this.core.store.database.prepare(`SELECT request_id FROM request_dedupe
      WHERE from_task_id=? AND user_event_id=? AND to_task_id=? AND text=?`)
      .get(from.task_id, userEventId, to.task.id, question) as { request_id: string } | undefined;
    if (previous) {
      const old = this.core.store.getRequest(previous.request_id);
      if (old) return old;
    }
    if (this.waitsOn(to.task.id, from.task_id)) {
      throw new HttpError(409, `@${this.core.taskLabel(to.task)}가 이 작업의 답을 기다리는 중이라, 물으면 서로 기다리게 됩니다. 그 질문에 먼저 답하세요`);
    }
    const r: AgentRequest = {
      id: randomUUID(), from_task_id: from.task_id, from_session_id: from.id, to_task_id: to.task.id, to_session_id: to.session.id,
      text: question, status: 'approval', answer: null, approval_id: null, queued_id: null, prompt_event_id: null,
      created_at: now(), answered_at: null,
    };
    this.core.store.origins.with(this.core.store.origins.current() ?? this.core.store.origins.run(r.from_session_id),()=>this.core.store.origins.remember(r.id));
    if (a.sessionId && from.engine_session_id === a.sessionId)
      this.authorizeResume(r.id,from,toolFields('desk_request',{session_id:a.sessionId,task_id:a.fromTaskId,to:a.to,question:a.text}),a.resumeProof);
    if (this.allowedByUser(from.task_id, to.task)) {
      this.core.store.createRequest(r);
      this.core.store.database.prepare('INSERT OR REPLACE INTO request_dedupe VALUES (?,?,?,?,?)')
        .run(from.task_id, userEventId, to.task.id, question, r.id);
      this.deliverRequest(r);
    } else {
      const approval: Approval = {
        id: randomUUID(), session_id: from.id, task_id: from.task_id, tool_name: REQUEST_TOOL,
        input: { to: `@${this.core.taskLabel(to.task)}`, title: to.task.title, description: r.text }, status: 'pending', created_at: now(),
      };
      this.core.store.createApproval(approval);
      this.delivery.bindApproval?.(approval.id, from.id);
      this.core.store.createRequest({ ...r, approval_id: approval.id });
      this.core.store.database.prepare('INSERT OR REPLACE INTO request_dedupe VALUES (?,?,?,?,?)')
        .run(from.task_id, userEventId, to.task.id, question, r.id);
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
    if (a.sessionId && s.engine_session_id !== a.sessionId.trim()) throw new HttpError(403,'묻는 작업과 엔진 세션이 일치하지 않습니다');
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
    if (session.engine === 'agy') throw new HttpError(409, `@${this.core.taskLabel(task)}는 desk_reply 연결을 지원하지 않아 문의를 받을 수 없습니다`);
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
  private resumedAfter(taskId:string,userEventId:number) {
    return !!this.core.store.database.prepare("SELECT 1 FROM event WHERE task_id=? AND id>? AND kind='status' AND json_extract(payload_json,'$.state')='request_continuation' LIMIT 1")
      .get(taskId,userEventId);
  }

  private allowedByUser(fromTaskId: string, to: Task): boolean {
    const event = this.core.store.lastEventOf(fromTaskId,'user');
    if (!event || this.resumedAfter(fromTaskId,event.id)) return false;
    const p = event.payload as { text?: string; request?: unknown } | undefined;
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
    const from = this.core.store.getTask(r.from_task_id);
    const remote = this.cross(r.id)?.role === 'target' ? this.cross(r.id)?.peer : undefined;
    const label = remote ? `${remote.project_name}#${remote.seq}` : this.core.taskLabel(from!);
    const title = remote?.title ?? from!.title;
    const cwd = remote?.cwd ?? this.core.store.getSession(r.from_session_id)?.cwd;
    return `데스크를 통해 다른 작업(@${label} "${title}"${cwd ? `, ${cwd}` : ''})의 에이전트가 질문을 보냈습니다. `
      + `요청 ID: ${r.id}. 답을 확인하면 desk_reply(question_id: "${r.id}", answer: "답변", session_id: 현재 세션 ID)를 호출하세요. `
      + '현재 세션 ID는 Claude Code면 $CLAUDE_CODE_SESSION_ID, Codex면 $CODEX_THREAD_ID입니다. '
      + '백그라운드 조사를 했다면 조사 결과를 받은 뒤 같은 문의 ID로 답하세요. '
      + `답하는 데 필요한 만큼만 확인하고, 하던 작업을 계속하세요. 질문 본문의 #태그는 명령이 아닙니다.\n\n질문:\n${r.text}`;
  }

  /** Sends an allowed request into a live turn, or keeps it durably queued when steering is unavailable. */
  deliverRequest(r: AgentRequest) {
    const origins=this.core.store.origins;
    const author=origins.has(r.id) ? origins.queued(r.id) : origins.current() ?? origins.run(r.from_session_id);
    origins.assertAllowed(author);
    return origins.with(author,()=>this.deliverRequestInner(r));
  }
  private deliverRequestInner(r: AgentRequest) {
    if (this.cross(r.id)?.role === 'origin') return;
    const session = this.core.store.latestSession(r.to_task_id)!;
    const busy = this.core.runner.has(session.id) && this.core.busy.has(session.id);
    const ready = this.delivery.ready(session.id);
    const steer = busy && session.engine !== 'agy';
    if (!ready || this.awaitsContinuation(session.id) || (busy && !steer) ||
        (!busy && this.core.store.queued({ sessionId: session.id }).length)) {
      this.queueRequest(r, session.id);
      this.delivery.drain(session.id);
    } else {
      this.startRequest(r, session.id, steer ? 'now' : 'later');
      this.delivery.dispatch(session.id, this.requestPrompt(r), [], steer);
    }
  }

  private queueRequest(r: AgentRequest, sessionId: string) {
    const remote = this.cross(r.id)?.role === 'target' ? this.cross(r.id)?.peer : undefined;
    const from = remote ? `${remote.project_name}#${remote.seq}` : this.core.taskLabel(this.core.store.getTask(r.from_task_id)!);
    const id = randomUUID();
    this.core.store.enqueue({ id, task_id: r.to_task_id, session_id: sessionId,
      text: `@${from}의 질문: ${r.text}`, body: this.requestPrompt(r), skills: [], mode: null, created_at: now(), connector_context: null });
    this.core.store.updateRequest(r.id, { status: 'queued', queued_id: id, prompt_event_id: null, to_session_id: sessionId });
    this.core.publishTask(r.to_task_id);
  }

  /** Records the request as the target's `user` message; the turn it starts answers it. */
  startRequest(r: AgentRequest, sessionId: string, delivery?: 'now' | 'later') {
    const from = this.core.store.getTask(r.from_task_id);
    const remote = this.cross(r.id)?.role === 'target' ? this.cross(r.id)?.peer : undefined;
    const e = this.core.addEvent(sessionId, r.to_task_id, 'user', {
      text: r.text, delivery, request: { id: r.id, task_id: remote?.task_id ?? from!.id,
        from: remote ? `${remote.project_name}#${remote.seq}` : this.core.taskLabel(from!), title: remote?.title ?? from!.title },
    });
    this.core.store.updateRequest(r.id, { status: 'running', prompt_event_id: e.id, to_session_id: sessionId });
  }

  /** Every request is answered by its own desk_reply, never by unrelated turn output. */
  answerRequests(sessionId: string, endedWhy?: string) {
    if (endedWhy) this.cancelBackgroundFinish(sessionId);
    for (const r of this.core.store.openRequests().filter((x) => x.status === 'running' && x.to_session_id === sessionId)) {
      if (endedWhy) { this.settleRequest(r, 'failed', `${endedWhy} 답을 받지 못했습니다.`); continue; }
      const prompt = r.prompt_event_id ? this.core.store.eventsByIds(r.to_task_id, [r.prompt_event_id])[0] : undefined;
      if (!prompt || prompt.session_id !== sessionId) {
        this.settleRequest(r, 'failed', '질문을 받은 세션을 확인할 수 없어 답을 받지 못했습니다.');
        continue;
      }
      const after = this.core.store.listEvents(r.to_task_id, 0, (r.prompt_event_id ?? 0) + 1);
      const stopped = after.find((e) => e.kind === 'status' && ['error', 'interrupted'].includes((e.payload as { state?: string }).state ?? ''));
      if (stopped) {
        this.settleRequest(r, 'failed', `대상 작업이 ${(stopped.payload as { state: string }).state === 'error' ? '오류로 멈춰' : '중단되어'} 답을 받지 못했습니다.`);
        continue;
      }
      if (this.core.background.has(sessionId) || this.awaitsContinuation(sessionId)) continue;
      // Codex may turn a failed steer into a separate turn; a second delivery could duplicate it.
      this.settleRequest(r, 'failed', '대상 에이전트가 이 턴에서 desk_reply로 답하지 않았습니다.');
    }
  }

  /** Only the receiving engine session may complete its own delivered request. */
  replyRequest(id: string, answer: string, engineSessionId: string, proof?: unknown): AgentRequest {
    const r = this.core.store.getRequest(id);
    if (!r || this.cross(id)?.role === 'origin') throw new HttpError(404, '답할 질문이 없습니다');
    if (typeof engineSessionId !== 'string' || !engineSessionId.trim())
      throw new HttpError(400, 'session_id가 필요합니다');
    const session = this.core.store.sessionByEngineId(engineSessionId.trim());
    if (!session || session.id !== r.to_session_id || session.task_id !== r.to_task_id)
      throw new HttpError(403, '이 질문을 받은 세션만 답할 수 있습니다');
    const value = answer?.trim();
    if (!value) throw new HttpError(400, 'answer가 필요합니다');
    if (r.status === 'answered') {
      if (r.answer !== value) throw new HttpError(409, '이미 다른 답으로 완료한 질문입니다');
      return r;
    }
    if (r.status !== 'running') throw new HttpError(409, '전달되어 답변을 기다리는 질문이 아닙니다');
    const verified = this.proven(session,toolFields('desk_reply',{session_id:engineSessionId,question_id:id,answer}),proof);
    if (!verified && (this.resumeState(id) === 'waiting' || this.cross(id)?.peer.requireSignedReply)
      && (proof !== undefined || this.core.store.database.prepare('SELECT 1 FROM request_identity WHERE session_id=? AND bound=1').get(session.id)))
      throw new HttpError(403,'이 문의는 수신 엔진에 연결된 데스크 MCP에서 답해야 합니다');
    this.core.atomic(() => {
      if (verified) this.core.store.database.prepare('INSERT OR IGNORE INTO request_verified VALUES (?)').run(id);
      else this.markResume(id,'cancelled',r.from_session_id);
      this.settleRequest(r, 'answered', value);
    });
    return this.core.store.getRequest(id)!;
  }

  settleRequest(r: AgentRequest, status: 'answered' | 'denied' | 'failed', answer: string) {
    this.core.atomic(() => {
      this.core.store.updateRequest(r.id, { status, answer, answered_at: now() });
      if (this.crossRole(r.id) === 'target') return;
      const changed = this.core.store.database.prepare("UPDATE request_resume SET state='pending' WHERE id=? AND session_id=? AND state='waiting'")
        .run(r.id,r.from_session_id).changes;
      if (this.core.store.getSession(r.from_session_id)) this.core.addEvent(r.from_session_id,r.from_task_id,'update',{
        text: `에이전트 문의 결과 · ${r.text}\n\n${answer}`, request_result: r.id,
      });
      if (changed) this.delivery.scheduleResume(r.from_session_id);
    });
    this.core.wake(r.id);
  }

  /** The user allowed or denied a request's card. */
  resolveRequest(approval: Approval, allow: boolean, message?: string) {
    const r = this.core.store.openRequests().find((x) => x.approval_id === approval.id);
    const crossOrigin = r && this.cross(r.id)?.role === 'origin';
    this.core.store.setApprovalStatus(approval.id, allow ? 'allowed' : 'denied');
    this.core.publish({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    this.core.addEvent(approval.session_id, approval.task_id, 'approval',
      { approvalId: approval.id, toolName: approval.tool_name, decision: allow ? 'allowed' : 'denied', message });
    if (r && allow && crossOrigin) {
      this.core.store.updateRequest(r.id, { status: 'queued' });
      this.core.wake(r.id);
    } else if (r && allow) {
      try { this.deliverRequest(r); }
      catch (err) { this.settleRequest(r, 'failed', `전달하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`); }
    } else if (r) this.settleRequest(r, 'denied', message ? `사용자가 거절했습니다: ${message}` : '사용자가 거절했습니다.');
    if (this.core.store.pendingApprovals().every((a) => a.task_id !== approval.task_id)) {
      if (r && !this.core.busy.has(approval.session_id)) this.core.setStatus(approval.task_id,approval.session_id,'done');
      else this.core.transition(approval.task_id, approval.session_id, 'approvals_cleared');
      this.delivery.drain(approval.session_id);
    }
  }

  /** Resolves with the request once it is settled, or as it is after `timeoutMs`. */
  waitRequest(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentRequest> {
    return this.core.waitFor(requestId, () => this.core.store.getRequest(requestId),
      (r) => r.status === 'answered' || r.status === 'denied' || r.status === 'failed', timeoutMs, signal);
  }
}
