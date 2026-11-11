import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Hub } from './hub.ts';
import type { CrossPeer } from './requests.ts';
import type { AgentRequest } from './db.ts';
import { HttpError } from './errors.ts';
import { expandHome } from './paths.ts';
import type { WorkspaceLinks } from './workspace-links.ts';

type Lookup = { peer: CrossPeer; source: 'app' | 'external'; last_user_event_id: number | null };
type LocalEdge = { from: string; to: string };
type Call = { status: number; body: any };
type BrokerRow = { id: string; fingerprint: string; origin: string; target: string; from_json: string;
  to_json: string; text: string; status: string; answer: string | null };
const terminal = (s: string) => ['answered', 'denied', 'failed'].includes(s);

/** Runs only in a canonical workspace. Local rows remain the source of truth for approval and delivery. */
export function handleWorkspaceBroker(hub: Hub, action: string, body: Record<string, any>): Call {
  const peerOf = (taskId: string): Lookup | undefined => {
    const task = hub.store.getTask(taskId), session = task && hub.store.latestSession(task.id);
    if (!task || !session) return undefined;
    return { peer: { task_id: task.id, session_id: session.id,
      project_name: hub.store.getProject(task.project_id)?.name ?? '?', seq: task.seq,
      title: task.title, cwd: session.cwd }, source: session.source,
      last_user_event_id: hub.store.lastEventOf(task.id, 'user')?.id ?? null };
  };
  if (action === 'lookup') {
    const kind = String(body.kind ?? '');
    if (kind === 'request' || kind === 'question') {
      const id = String(body.id ?? '');
      const found = kind === 'request' && hub.requests.crossRole(id) === 'target' ? undefined
        : kind === 'request' ? hub.store.getRequest(id) : hub.store.getQuestion(id);
      return { status: found ? 200 : 404, body: found ? { id } : { error: '질문이 없습니다' } };
    }
    if (kind === 'list') {
      const cwd = typeof body.cwd === 'string' && body.cwd ? resolve(expandHome(body.cwd)) : null;
      const projects = cwd ? new Set(hub.store.projectsContaining(cwd).map(p => p.id)) : null;
      return { status: 200, body: hub.state().tasks.filter(t => !projects || projects.has(t.project_id)) };
    }
    if (kind === 'edges') {
      return { status: 200, body: hub.store.openRequests()
        .filter(r => !hub.requests.crossRole(r.id))
        .map(r => ({ from: r.from_task_id, to: r.to_task_id })) satisfies LocalEdge[] };
    }
    if (kind === 'origin') {
      const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
      const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
      const session = taskId ? hub.store.latestSession(taskId) : sessionId ? hub.store.sessionByEngineId(sessionId) : undefined;
      const found = session && peerOf(session.task_id);
      return { status: found ? 200 : 404, body: found ?? { error: '묻는 작업을 찾지 못했습니다' } };
    }
    if (kind === 'target') {
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      let task = hub.store.getTask(to);
      if (!task) {
        const m = /^@?([^\s:@#]+)(?:#(\d+))?$/.exec(to);
        if (!m) throw new HttpError(400, 'to에는 @프로젝트, @프로젝트#번호 또는 task_id를 쓰세요');
        const project = hub.store.findProjectByName(m[1]);
        if (project) task = m[2] ? hub.store.taskBySeq(project.id, Number(m[2]))
          : hub.store.listTasks().filter(t => t.project_id === project.id && hub.store.latestSession(t.id)?.source === 'app')
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      }
      const found = task && peerOf(task.id);
      return { status: found ? 200 : 404, body: found ?? { error: '대상 작업을 찾지 못했습니다' } };
    }
    throw new HttpError(400, '지원하지 않는 조회입니다');
  }
  const id = String(body.id ?? '');
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(id)) throw new HttpError(400, '요청 ID가 잘못되었습니다');
  if (action === 'submit') {
    if (!body.target || typeof body.target !== 'object') throw new HttpError(400, '대상 정보가 필요합니다');
    if (body.user_event_id !== null && !Number.isSafeInteger(body.user_event_id))
      throw new HttpError(400, '질문을 시작한 사용자 메시지 ID가 필요합니다');
    const r = hub.requests.requestCross(id, { text: body.text, fromTaskId: body.task_id, sessionId: body.session_id,
      target: body.target as CrossPeer, explicitMention: true, userEventId: body.user_event_id });
    return { status: 200, body: r };
  }
  if (action === 'receive') {
    if (!body.from || typeof body.from !== 'object' || typeof body.to_task_id !== 'string')
      throw new HttpError(400, '전달 정보가 필요합니다');
    return { status: 200, body: hub.requests.receiveCross(id, { text: body.text, from: body.from as CrossPeer,
      toTaskId: body.to_task_id }) };
  }
  if (action === 'status' || action === 'answer') {
    const r = hub.store.getRequest(id);
    if (!r) throw new HttpError(404, '질문이 없습니다');
    return { status: 200, body: r };
  }
  if (action === 'settle') {
    if (!['answered', 'denied', 'failed'].includes(body.status) || typeof body.answer !== 'string')
      throw new HttpError(400, '답변 형식이 잘못되었습니다');
    return { status: 200, body: hub.requests.settleCrossOrigin(id, body.status, body.answer) };
  }
  throw new HttpError(404, '지원하지 않는 중계 요청입니다');
}

class RequestBroker {
  private db: DatabaseSync;
  private timer: NodeJS.Timeout;
  private active = new Map<string, Promise<void>>();
  private waits = new Set<Promise<BrokerRow>>();
  private actions = new Set<Promise<unknown>>();
  private closing = false;
  private closed = new AbortController();
  private links: WorkspaceLinks;
  constructor(links: WorkspaceLinks, _local: string) {
    this.links = links;
    this.db = links.database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS broker_request (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, target TEXT NOT NULL,
      from_json TEXT NOT NULL, to_json TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
      answer TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS broker_request_status ON broker_request(status,created_at);`);
    this.timer = setInterval(() => {
      if (this.closing) return;
      for (const row of this.pending()) void this.drive(row.id);
    }, 1500);
    this.timer.unref();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.closed.abort();
    await Promise.allSettled([...this.active.values(), ...this.waits, ...this.actions]);
  }
  run<T>(perform: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new HttpError(503, '질문 중계를 종료하는 중입니다'));
    const task = perform();
    this.actions.add(task);
    void task.then(() => this.actions.delete(task), () => this.actions.delete(task));
    return task;
  }
  private sources() { return this.links.list().map(l => l.id); }
  private row(id: string) { return this.db.prepare('SELECT * FROM broker_request WHERE id=?').get(id) as BrokerRow | undefined; }
  private pending() { return this.db.prepare("SELECT * FROM broker_request WHERE status NOT IN ('answered','denied','failed')")
    .all() as BrokerRow[]; }
  private set(id: string, status: string, answer: string | null = null) {
    this.db.prepare('UPDATE broker_request SET status=?,answer=?,updated_at=? WHERE id=?')
      .run(status, answer, new Date().toISOString(), id);
  }
  private async call(source: string, action: string, body: unknown): Promise<any> {
    const r = await this.links.trustedCall(source, `/v1/broker/${action}`, body);
    if (r.status >= 400) throw new HttpError(r.status, r.body?.error ?? `작업공간 중계에 실패했습니다 (${r.status})`);
    return r.body;
  }
  async lookup(kind: 'origin' | 'target' | 'request' | 'question', query: Record<string, unknown>) {
    const outcomes = await Promise.all(this.sources().map(async source => {
      try { return { source, result: await this.call(source, 'lookup', { kind, ...query }) as Lookup }; }
      catch (error) { return { source, error }; }
    }));
    const matches = outcomes.filter(x => 'result' in x) as { source: string; result: Lookup }[];
    if (matches.length > 1) throw new HttpError(409, '여러 작업공간에서 일치하는 작업을 찾았습니다. 작업 ID를 확인하세요');
    const unavailable = outcomes.some(x => 'error' in x && !(x.error instanceof HttpError && x.error.status === 404));
    const namedTarget = kind === 'target' && typeof query.to === 'string'
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.to.trim());
    if (unavailable && namedTarget)
      throw new HttpError(503, '연결이 끊긴 작업공간이 있어 @프로젝트 대상을 확인할 수 없습니다. 대상 task_id를 지정하거나 연결을 복구하세요');
    if (matches.length === 1) return matches[0];
    if (unavailable) throw new HttpError(503, '작업공간 연결을 확인할 수 없어 대상을 안전하게 찾지 못했습니다');
    throw new HttpError(404, kind === 'origin' ? '묻는 작업을 데스크에서 찾지 못했습니다' : '대상 작업을 찾지 못했습니다');
  }
  async list(cwd: unknown) {
    const outcomes = await Promise.all(this.sources().map(async source => {
      try { return await this.call(source, 'lookup', { kind: 'list', cwd }) as any[]; }
      catch { return null; }
    }));
    return outcomes.flatMap(x => x ?? []).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50);
  }
  async begin(a: Record<string, any>): Promise<BrokerRow | { proxy: string }> {
    if (typeof a.question !== 'string' || !a.question.trim()) throw new HttpError(400, 'question이 필요합니다');
    if (!a.task_id?.trim?.() && !a.session_id?.trim?.())
      throw new HttpError(400, 'task_id 또는 session_id가 필요합니다');
    const from = await this.lookup('origin', { task_id: a.task_id, session_id: a.session_id });
    const to = await this.lookup('target', { to: a.to });
    if (from.source === to.source) return { proxy: from.source };
    if (to.result.source !== 'app') throw new HttpError(409, '대상은 터미널에서 붙은 작업이라 질문을 넣을 수 없습니다');
    const input = [from.source, from.result.peer.task_id, from.result.last_user_event_id,
      to.source, to.result.peer.task_id, String(a.question ?? '').trim()];
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let row = this.db.prepare('SELECT * FROM broker_request WHERE fingerprint=?').get(fingerprint) as BrokerRow | undefined;
    if (!row) {
      const id = randomUUID(), at = new Date().toISOString();
      this.db.prepare('INSERT INTO broker_request VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, fingerprint, from.source, to.source,
          JSON.stringify({ ...from.result.peer, user_event_id: from.result.last_user_event_id }), JSON.stringify(to.result.peer),
          String(a.question ?? '').trim(), 'new', null, at, at);
      row = this.row(id)!;
    }
    await this.drive(row.id);
    return this.row(row.id)!;
  }
  private async hasCycle(row: BrokerRow) {
    const edges = this.pending().filter(x => x.id !== row.id).map(x => ({
      from: `${x.origin}:${(JSON.parse(x.from_json) as CrossPeer).task_id}`,
      to: `${x.target}:${(JSON.parse(x.to_json) as CrossPeer).task_id}`,
    }));
    const local = new Map<string, LocalEdge[]>();
    const from = `${row.origin}:${(JSON.parse(row.from_json) as CrossPeer).task_id}`;
    const target = `${row.target}:${(JSON.parse(row.to_json) as CrossPeer).task_id}`;
    const stack = [target], seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const source = current.slice(0, current.indexOf(':'));
      if (!local.has(source)) local.set(source, await this.call(source, 'lookup', { kind: 'edges' }) as LocalEdge[]);
      for (const edge of local.get(source)!) if (`${source}:${edge.from}` === current) stack.push(`${source}:${edge.to}`);
      for (const edge of edges) if (edge.from === current) stack.push(edge.to);
    }
    return false;
  }
  drive(id: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    const running = this.active.get(id);
    if (running) return running;
    const task = this.driveOnce(id).finally(() => this.active.delete(id));
    this.active.set(id, task);
    return task;
  }
  private async driveOnce(id: string) {
    try {
      let row = this.row(id);
      if (!row || terminal(row.status)) return;
      const from = JSON.parse(row.from_json) as CrossPeer, to = JSON.parse(row.to_json) as CrossPeer;
      if (row.status === 'new') {
        if (await this.hasCycle(row)) { this.set(id, 'failed', '서로 답을 기다리는 질문이 생겨 전달하지 못했습니다.'); return; }
        const origin = await this.call(row.origin, 'submit', { id, text: row.text, task_id: from.task_id, target: to,
          user_event_id: (from as CrossPeer & { user_event_id?: number | null }).user_event_id ?? null }) as AgentRequest;
        this.set(id, origin.status);
      }
      row = this.row(id)!;
      if (row.status === 'approval') {
        const origin = await this.call(row.origin, 'status', { id }) as AgentRequest;
        if (terminal(origin.status)) { this.set(id, origin.status, origin.answer); return; }
        if (origin.status === 'approval') return;
        this.set(id, origin.status);
      }
      row = this.row(id)!;
      if (row.status === 'queued' || row.status === 'running') {
        if (row.status === 'queued') {
          let delivered = true;
          try { await this.call(row.target, 'status', { id }); }
          catch (error) {
            if (!(error instanceof HttpError && error.status === 404)) throw error;
            delivered = false;
          }
          if (!delivered && await this.hasCycle(row)) {
            const answer = '서로 답을 기다리는 질문이 생겨 전달하지 못했습니다.';
            const origin = await this.call(row.origin, 'settle', { id, status: 'failed', answer }) as AgentRequest;
            this.set(id, origin.status, origin.answer);
            return;
          }
        }
        const target = await this.call(row.target, 'receive', { id, text: row.text, from, to_task_id: to.task_id }) as AgentRequest;
        this.set(id, target.status === 'answered' || target.status === 'failed' ? 'settling' : 'running');
      }
      row = this.row(id)!;
      if (row.status === 'running' || row.status === 'settling') {
        const target = await this.call(row.target, 'answer', { id }) as AgentRequest;
        if (!terminal(target.status)) return;
        await this.call(row.origin, 'settle', { id, status: target.status, answer: target.answer ?? '답을 받지 못했습니다.' });
        this.set(id, target.status, target.answer);
      }
    } catch (error) {
      // A disconnected owner leaves the durable row pending for the next timer or wait call.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 409) {
        const row = this.row(id);
        if (row?.status !== 'new' && row?.status !== 'approval') {
          try {
            await this.call(row!.origin, 'settle', { id, status: 'failed', answer: error.message });
            this.set(id, 'failed', error.message);
          } catch { /* retry when the origin reconnects */ }
        }
      }
    }
  }
  wait(id: string, timeoutMs: number, signal: AbortSignal): Promise<BrokerRow> {
    const pending = this.waitOnce(id, timeoutMs, signal);
    this.waits.add(pending);
    void pending.then(() => this.waits.delete(pending), () => this.waits.delete(pending));
    return pending;
  }
  private async waitOnce(id: string, timeoutMs: number, signal: AbortSignal) {
    const until = Date.now() + timeoutMs;
    do {
      await this.drive(id);
      const row = this.row(id);
      if (!row) throw new HttpError(404, '질문이 없습니다');
      if (terminal(row.status) || signal.aborted || this.closing) return row;
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(500, Math.max(1, until - Date.now())));
        const closed = this.closed.signal;
        function done() { clearTimeout(timer); signal.removeEventListener('abort', done); closed.removeEventListener('abort', done); resolve(); }
        signal.addEventListener('abort', done, { once: true });
        closed.addEventListener('abort', done, { once: true });
      });
    } while (Date.now() < until && !this.closing);
    return this.row(id)!;
  }
  find(id: string) { return this.row(id); }
}

const brokers = new WeakMap<WorkspaceLinks, RequestBroker>();
function broker(links: WorkspaceLinks, local: string) {
  let held = brokers.get(links);
  if (!held) { held = new RequestBroker(links, local); brokers.set(links, held); }
  return held;
}
export async function closeRequestBroker(links: WorkspaceLinks) {
  const held = brokers.get(links);
  if (!held) return;
  await held.close();
  brokers.delete(links);
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
function mcpText(value: string) { return { content: [{ type: 'text', text: value }] }; }
function mcpReply(res: ServerResponse, req: Rpc, result: unknown, error = false) {
  if (req.id === undefined) { res.writeHead(202).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, result: error ? { ...mcpText(String(result)), isError: true } : result }));
}
function result(row: BrokerRow) {
  const to = JSON.parse(row.to_json) as CrossPeer;
  if (row.status === 'answered') return mcpText(`@${to.project_name}#${to.seq} 에이전트의 답:\n${row.answer}`);
  if (row.status === 'denied' || row.status === 'failed') return mcpText(row.answer ?? '답을 받지 못했습니다.');
  const waiting: Record<string, string> = { new: '전달 대기', approval: '사용자 승인 대기', queued: '대상 작업 대기', running: '대상 에이전트가 답하는 중', settling: '답변 전달 중' };
  return mcpText(`아직 답이 없습니다 (${waiting[row.status] ?? row.status}). desk_wait_answer(question_id: "${row.id}")로 계속 기다리세요.`);
}

/** Gateway MCP interception. Unrelated tools keep the existing owner MCP implementation. */
export async function handleBrokerMcp(links: WorkspaceLinks, localAuthorityId: string, body: unknown,
  req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || !body) return false;
  if (Array.isArray(body)) {
    if (!body.length || body.length > 32) return false;
    const captures = body.map(() => {
      const reply = new EventEmitter() as ServerResponse & { output?: string };
      reply.writeHead = (() => reply) as ServerResponse['writeHead'];
      reply.end = ((chunk?: string) => { reply.output = chunk; reply.emit('close'); return reply; }) as ServerResponse['end'];
      return reply;
    });
    const abort = () => captures.forEach(c => c.emit('close'));
    res.on('close', abort);
    try {
      const replies = await Promise.all(body.map(async (one, index) => {
        const handled = await handleBrokerMcp(links, localAuthorityId, one, req, captures[index]);
        if (!handled) await links.proxyMcp(localAuthorityId, req, captures[index], one);
        return captures[index].output ? JSON.parse(captures[index].output!) : null;
      }));
      const values = replies.filter(value => value !== null);
      if (!values.length) res.writeHead(202).end();
      else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(values)); }
    } finally { res.off('close', abort); }
    return true;
  }
  if (typeof body !== 'object') return false;
  const rpc = body as Rpc;
  if (rpc.method !== 'tools/call') return false;
  const name = rpc.params?.name;
  if (!['desk_attach', 'desk_post', 'desk_checkpoint', 'desk_ask', 'desk_wait_answer',
    'desk_request', 'desk_finish', 'desk_handoff', 'desk_list_tasks'].includes(name)) return false;
  const work = broker(links, localAuthorityId);
  const args = rpc.params?.arguments ?? {};
  return work.run(async () => {
  try {
    if (name === 'desk_list_tasks') {
      const tasks = await work.list(args.cwd);
      const lines = tasks.map(t => `- ${t.id} [${t.status}${t.source === 'external' ? ', 터미널' : ''}] @${t.project_name} › ${t.title} (갱신 ${t.updated_at})`);
      mcpReply(res, rpc, mcpText(lines.length ? lines.join('\n') : '작업이 없습니다.'));
      return true;
    }
    if (name === 'desk_wait_answer') {
      const held = work.find(String(args.question_id ?? ''));
      if (!held) {
        let owner: { source: string };
        try { owner = await work.lookup('request', { id: args.question_id }); }
        catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
          owner = await work.lookup('question', { id: args.question_id });
        }
        await links.proxyMcp(owner.source, req, res, body);
        return true;
      }
      const abort = new AbortController(); res.on('close', () => abort.abort());
      const ms = Math.min(Math.max(Number(args.timeout_sec) || 300, 1), 600) * 1000;
      mcpReply(res, rpc, result(await work.wait(held.id, ms, abort.signal)));
      return true;
    }
    if (name !== 'desk_request') {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
      const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
      const source = taskId || sessionId
        ? (await work.lookup('origin', { task_id: taskId, session_id: sessionId })).source
        : localAuthorityId;
      await links.proxyMcp(source, req, res, body);
      return true;
    }
    const started = await work.begin(args);
    if ('proxy' in started) { await links.proxyMcp(started.proxy, req, res, body); return true; }
    const abort = new AbortController(); res.on('close', () => abort.abort());
    const ms = Math.min(Math.max(Number(args.timeout_sec) || 300, 1), 600) * 1000;
    mcpReply(res, rpc, result(await work.wait(started.id, ms, abort.signal)));
  } catch (error) { mcpReply(res, rpc, error instanceof Error ? error.message : String(error), true); }
  return true;
  });
}
