import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Approval, Channel, ChannelContext, ChannelEntry, ChannelEntryInput, ChannelIngestReceipt, FeedFilter, Project, QueuedKind, Question, Task, TaskStatus, WireEvent } from '../../shared/api.ts';
import { REQUEST_TOOL, type Effort, type ModelName, type PermissionMode } from '../../shared/compose.ts';
import { ALERT_STATES, type EventKind } from '../../shared/events.ts';

/** An event as stored; its payload is checked where it is read. */
export type Event = WireEvent;

export interface Session {
  id: string; task_id: string; engine: string; engine_session_id: string | null; cwd: string;
  source: 'app' | 'external'; status: TaskStatus; runner_id: string; created_at: string;
  permission_mode: PermissionMode;
  /** Claude model alias and reasoning effort; null leaves the choice to Claude Code. */
  model: ModelName | null; effort: Effort | null;
}
export interface ChannelRecord {
  id: string; name: string; source: 'push' | 'feed'; feed_url: string | null; enabled: number;
  token_hash: string | null; created_at: string; updated_at: string;
  last_checked_at: string | null; last_success_at: string | null; last_error: string | null;
  next_poll_at: string | null; etag: string | null; last_modified: string | null;
  failure_count: number; read_through_id: number;
  conversation_task_id?: string | null;
}
/** A value with long strings, long lists, and deep nesting cut: enough for a one-line summary. */
function clip(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (!v || typeof v !== 'object') return v;
  if (depth >= 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clip(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, depth + 1)]));
}

/**
 * An event as feed columns get it: tool calls and results, nearly all of a history's size, keep
 * what their summary line shows; the thread loads them whole. `clipped` marks a cut payload.
 */
export function feedEvent(e: Event): Event {
  const p = e.payload as Record<string, unknown>;
  if (e.kind === 'user' && p.channel_context) {
    const context = p.channel_context as ChannelContext;
    return { ...e, payload: { ...p, channel_context: { ...context, entries: context.entries.map((entry) => ({ ...entry, body: '' })) }, clipped: true } };
  }
  if (e.kind === 'tool') return { ...e, payload: { ...p, input: clip(p.input), clipped: true } };
  if (e.kind === 'tool_result' && typeof p.text === 'string' && p.text.length > 500) {
    return { ...e, payload: { ...p, text: `${p.text.slice(0, 500)}…`, clipped: true } };
  }
  return e;
}

/** Event kinds whose payload holds text a search should look at (not tool input or output). */
/** How an imported event's payload starts (importEvents). */
const IMPORTED = '{"imported":true';
const TEXT_KINDS = ['user', 'assistant', 'update', 'question', 'approval', 'status'];
/** The text a post shows (web postText), so a search does not match JSON keys or other fields. */
const POST_TEXT = "coalesce(json_extract(e.payload_json, '$.text'), json_extract(e.payload_json, '$.toolName'), json_extract(e.payload_json, '$.detail.message'), '')";

/** Whether an event starts a post (web postKind): the rest attaches to the post before it. */
const IS_POST = `(e.kind IN ('user', 'assistant', 'update')
  OR (e.kind IN ('approval', 'question') AND json_extract(e.payload_json, '$.decision') = 'pending')
  OR (e.kind = 'status' AND json_extract(e.payload_json, '$.state') IN (${ALERT_STATES.map((s) => `'${s}'`).join(', ')})))`;

/** The SQL condition (on `event e JOIN task t`) for a feed column's events, and its arguments. */
function feedWhere(f: FeedFilter): { where: string; args: string[] } {
  const where = ['1'];
  const args: string[] = [];
  const within = (col: string, vals?: string[]) => {
    if (!vals?.length) return;
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
    args.push(...vals);
  };
  // Taken-over history belongs in its thread and a column for that task, not in the timeline.
  if (!f.taskIds?.length) where.push(`e.payload_json NOT LIKE '${IMPORTED}%'`);
  within('e.task_id', f.taskIds);
  within('t.project_id', f.projectIds);
  within('t.status', f.statuses);
  within('e.kind', f.kinds);
  if (f.q) {
    // A task whose title matches brings all its events; otherwise the events whose text does.
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(t.title LIKE ? ESCAPE '\\' OR (e.kind IN (${TEXT_KINDS.map(() => '?').join(',')}) AND ${POST_TEXT} LIKE ? ESCAPE '\\'))`);
    args.push(like, ...TEXT_KINDS, like);
  }
  return { where: where.join(' AND '), args };
}

/**
 * A message sent while its task was busy (#later): it waits here, not in the event log, until the
 * running turn ends; then it is sent and recorded as a `user` event. `text` is what the user wrote,
 * `body`/`skills` what the agent receives; `kind` see QueuedKind.
 */
export interface Queued {
  id: string; task_id: string; session_id: string; text: string; body: string; skills: string[];
  mode: PermissionMode | null; created_at: string; kind?: QueuedKind | null;
  channel_context?: ChannelContext;
}
/**
 * A question one agent asks another task's agent through the desk. `approval_id`: the card the user
 * allows it with (none when the user named the target with @); `queued_id`: the waiting message it
 * rides while the target is busy; `prompt_event_id`: the target's `user` event that delivered it, after
 * which the target's last reply in that turn is the answer.
 */
export interface AgentRequest {
  id: string; from_task_id: string; from_session_id: string; to_task_id: string; to_session_id: string; text: string;
  status: 'approval' | 'queued' | 'running' | 'answered' | 'denied' | 'failed'; answer: string | null;
  approval_id: string | null; queued_id: string | null; prompt_event_id: number | null;
  created_at: string; answered_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), title TEXT NOT NULL,
  status TEXT NOT NULL, checkpoint_md TEXT, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), engine TEXT NOT NULL,
  engine_session_id TEXT, cwd TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
  runner_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
  ts TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS event_task ON event(task_id, id);
CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS question (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
  answer TEXT, created_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE IF NOT EXISTS queued (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, body TEXT NOT NULL,
  skills_json TEXT NOT NULL, mode TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request (
  id TEXT PRIMARY KEY, from_task_id TEXT NOT NULL, from_session_id TEXT NOT NULL, to_task_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, approval_id TEXT, queued_id TEXT,
  prompt_event_id INTEGER, created_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runner (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, capabilities_json TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, feed_url TEXT, enabled INTEGER NOT NULL,
  token_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_checked_at TEXT, last_success_at TEXT, last_error TEXT, next_poll_at TEXT,
  etag TEXT, last_modified TEXT, failure_count INTEGER NOT NULL DEFAULT 0, read_through_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS channel_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT, author TEXT, published_at TEXT,
  received_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(channel_id, external_id));
CREATE INDEX IF NOT EXISTS channel_entry_page ON channel_entry(channel_id, id);
`;

export const now = () => new Date().toISOString();

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    const cols = this.db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'permission_mode')) {
      this.db.exec("ALTER TABLE session ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'");
    }
    for (const c of ['model', 'effort']) {
      if (!cols.some((x) => x.name === c)) this.db.exec(`ALTER TABLE session ADD COLUMN ${c} TEXT`);
    }
    const taskCols = this.db.prepare('PRAGMA table_info(task)').all() as { name: string }[];
    if (!taskCols.some((c) => c.name === 'seq')) {
      // Number the existing tasks of each project in the order they were created.
      this.db.exec(`ALTER TABLE task ADD COLUMN seq INTEGER;
        UPDATE task SET seq = (SELECT count(*) FROM task t WHERE t.project_id = task.project_id
          AND (t.created_at < task.created_at OR (t.created_at = task.created_at AND t.id <= task.id)));`);
    }
    const queuedCols = this.db.prepare('PRAGMA table_info(queued)').all() as { name: string }[];
    if (!queuedCols.some((c) => c.name === 'ord')) {
      // The order messages are sent in; the user can change it. Existing ones keep theirs.
      this.db.exec('ALTER TABLE queued ADD COLUMN ord INTEGER; UPDATE queued SET ord = rowid;');
    }
    if (!queuedCols.some((c) => c.name === 'kind')) this.db.exec('ALTER TABLE queued ADD COLUMN kind TEXT');
    if (!queuedCols.some((c) => c.name === 'channel_context_json')) this.db.exec('ALTER TABLE queued ADD COLUMN channel_context_json TEXT');
    const channelCols = this.db.prepare('PRAGMA table_info(channel)').all() as { name: string }[];
    if (!channelCols.some((c) => c.name === 'conversation_task_id')) this.db.exec('ALTER TABLE channel ADD COLUMN conversation_task_id TEXT REFERENCES task(id) ON DELETE SET NULL');
    // After the migrations above, since some index columns they add.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS session_task ON session(task_id, created_at);
      CREATE INDEX IF NOT EXISTS task_project ON task(project_id, seq);
      CREATE INDEX IF NOT EXISTS approval_status ON approval(status, created_at);
      CREATE INDEX IF NOT EXISTS question_status ON question(status, created_at);
      CREATE INDEX IF NOT EXISTS request_status ON request(status, created_at);
      DROP INDEX IF EXISTS queued_session;
      DROP INDEX IF EXISTS queued_task;
      CREATE INDEX IF NOT EXISTS queued_session_ord ON queued(session_id, ord);
      CREATE INDEX IF NOT EXISTS queued_task_ord ON queued(task_id, ord);`);
  }
  channelRecord(id: string): ChannelRecord | undefined {
    return this.db.prepare('SELECT * FROM channel WHERE id = ?').get(id) as unknown as ChannelRecord | undefined;
  }
  createChannel(c: ChannelRecord) {
    const keys = Object.keys(c);
    this.db.prepare(`INSERT INTO channel (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(c));
  }
  updateChannel(id: string, patch: Partial<Omit<ChannelRecord, 'id'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE channel SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`).run(...keys.map((k) => patch[k]!), id);
  }
  private channelView(c: ChannelRecord): Channel {
    // Keep read history out of the unread scan; both queries use (channel_id, id).
    const { latest } = this.db.prepare('SELECT coalesce(max(id), 0) AS latest FROM channel_entry WHERE channel_id = ?')
      .get(c.id) as { latest: number };
    const { unread } = this.db.prepare('SELECT count(*) AS unread FROM channel_entry WHERE channel_id = ? AND id > ?')
      .get(c.id, c.read_through_id) as { unread: number };
    // Explicit projection: never leak producer hashes or HTTP cache validators to clients.
    return { id: c.id, name: c.name, source: c.source, feed_url: c.feed_url, enabled: !!c.enabled,
      created_at: c.created_at, updated_at: c.updated_at, last_checked_at: c.last_checked_at,
      last_success_at: c.last_success_at, last_error: c.last_error, next_poll_at: c.next_poll_at,
      read_through_id: c.read_through_id, latest_entry_id: latest, unread_count: unread, conversation_task_id: c.conversation_task_id ?? null };
  }
  getChannel(id: string): Channel | undefined {
    const c = this.channelRecord(id);
    return c && this.channelView(c);
  }
  listChannels(): Channel[] {
    return (this.db.prepare('SELECT * FROM channel ORDER BY created_at, id').all() as unknown as ChannelRecord[]).map((c) => this.channelView(c));
  }
  deleteChannel(id: string) { this.db.prepare('DELETE FROM channel WHERE id = ?').run(id); }
  readChannel(id: string, throughId: number) {
    this.db.prepare(`UPDATE channel SET read_through_id = max(read_through_id,
      min(?, coalesce((SELECT max(id) FROM channel_entry WHERE channel_id = ?), 0))) WHERE id = ?`).run(throughId, id, id);
  }
  channelEntries(id: string, limit: number, before: number, q = ''): { entries: ChannelEntry[]; more: boolean; total: number } {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const filter = "channel_id = ?" + (q ? " AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')" : '');
    const args = q ? [id, like, like] : [id];
    const rows = this.db.prepare(`SELECT * FROM channel_entry WHERE ${filter} AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(...args, before, limit + 1) as unknown as ChannelEntry[];
    const { n } = this.db.prepare(`SELECT count(*) AS n FROM channel_entry WHERE ${filter}`).get(...args) as { n: number };
    return { entries: rows.slice(0, limit), more: rows.length > limit, total: n };
  }
  channelEntriesByIds(channelId: string, ids: number[]): ChannelEntry[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM channel_entry WHERE channel_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(channelId, ...ids) as unknown as ChannelEntry[];
    const byId = new Map(rows.map((entry) => [entry.id, entry]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  }
  ingestChannelEntries(id: string, inputs: ChannelEntryInput[]): { receipt: ChannelIngestReceipt; changed: ChannelEntry[] } {
    const receipt = { created: 0, updated: 0, unchanged: 0 }, changed: ChannelEntry[] = [];
    this.db.exec('BEGIN');
    try {
      for (const input of inputs) {
        const prev = this.db.prepare('SELECT * FROM channel_entry WHERE channel_id = ? AND external_id = ?').get(id, input.external_id) as unknown as ChannelEntry | undefined;
        const fields = { external_id: input.external_id, title: input.title ?? '', body: input.body, url: input.url ?? null,
          author: input.author ?? null, published_at: input.published_at ?? null };
        if (prev && Object.entries(fields).every(([k, v]) => prev[k as keyof ChannelEntry] === v)) { receipt.unchanged++; continue; }
        const ts = now();
        if (prev) {
          this.db.prepare('UPDATE channel_entry SET title = ?, body = ?, url = ?, author = ?, published_at = ?, updated_at = ? WHERE id = ?')
            .run(fields.title, fields.body, fields.url, fields.author, fields.published_at, ts, prev.id);
          changed.push({ ...prev, ...fields, updated_at: ts }); receipt.updated++;
        } else {
          const row = this.db.prepare(`INSERT INTO channel_entry (channel_id, external_id, title, body, url, author, published_at, received_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, fields.external_id, fields.title, fields.body, fields.url, fields.author, fields.published_at, ts, ts);
          changed.push({ id: Number(row.lastInsertRowid), channel_id: id, ...fields, received_at: ts, updated_at: ts }); receipt.created++;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { receipt, changed };
  }
  /** Deletes all but the channel's `keep` newest entries; returns how many went. */
  pruneChannelEntries(id: string, keep: number): number {
    const cut = this.db.prepare('SELECT id FROM channel_entry WHERE channel_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(id, keep - 1) as { id: number } | undefined;
    if (!cut) return 0;
    return Number(this.db.prepare('DELETE FROM channel_entry WHERE channel_id = ? AND id < ?').run(id, cut.id).changes);
  }
  findProjectByName(name: string): Project | undefined {
    return this.db.prepare('SELECT * FROM project WHERE lower(name) = lower(?)').get(name) as unknown as Project | undefined;
  }
  latestTaskOfProject(projectId: string): Task | undefined {
    return this.db.prepare('SELECT * FROM task WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(projectId) as unknown as Task | undefined;
  }

  createProject(p: Project) {
    this.db.prepare('INSERT INTO project VALUES (?, ?, ?, ?)').run(p.id, p.name, p.root_path, p.created_at);
  }
  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM project ORDER BY created_at').all() as unknown as Project[];
  }
  getProject(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM project WHERE id = ?').get(id) as unknown as Project | undefined;
  }

  /** Inserts the task with the next number of its project and returns it with that number. */
  createTask(t: Omit<Task, 'seq'>): Task {
    const { seq } = this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM task WHERE project_id = ?')
      .get(t.project_id) as { seq: number };
    this.db.prepare(`INSERT INTO task (id, project_id, title, status, checkpoint_md, created_by, created_at, updated_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.project_id, t.title, t.status, t.checkpoint_md, t.created_by, t.created_at, t.updated_at, seq);
    return { ...t, seq };
  }
  taskBySeq(projectId: string, seq: number): Task | undefined {
    return this.db.prepare('SELECT * FROM task WHERE project_id = ? AND seq = ?').get(projectId, seq) as unknown as Task | undefined;
  }
  listTasks(): Task[] {
    return this.db.prepare('SELECT * FROM task ORDER BY updated_at DESC').all() as unknown as Task[];
  }
  getTask(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as unknown as Task | undefined;
  }
  setTaskStatus(id: string, status: TaskStatus) {
    this.db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }
  touchTask(id: string) {
    this.db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(now(), id);
  }
  setCheckpoint(id: string, md: string) {
    this.db.prepare('UPDATE task SET checkpoint_md = ?, updated_at = ? WHERE id = ?').run(md, now(), id);
  }
  setTaskTitle(id: string, title: string) {
    this.db.prepare('UPDATE task SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
  }

  /**
   * Removes tasks with everything recorded for them: sessions, events, approvals, questions, queued
   * messages, and requests they sent. Requests other tasks sent them stay (settled by the hub first).
   */
  deleteTasks(ids: string[]) {
    if (!ids.length) return;
    const marks = ids.map(() => '?').join(',');
    this.db.exec('BEGIN');
    try {
      for (const table of ['event', 'approval', 'question', 'queued', 'session']) {
        this.db.prepare(`DELETE FROM ${table} WHERE task_id IN (${marks})`).run(...ids);
      }
      this.db.prepare(`DELETE FROM request WHERE from_task_id IN (${marks})`).run(...ids);
      this.db.prepare(`DELETE FROM task WHERE id IN (${marks})`).run(...ids);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  /** Removes a project that has no tasks left. */
  deleteProject(id: string) {
    this.db.prepare('DELETE FROM project WHERE id = ?').run(id);
  }

  createSession(s: Session) {
    this.db.prepare(`INSERT INTO session (id, task_id, engine, engine_session_id, cwd, source, status, runner_id,
      created_at, permission_mode, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.task_id, s.engine, s.engine_session_id, s.cwd, s.source, s.status, s.runner_id, s.created_at,
        s.permission_mode, s.model, s.effort);
  }
  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as unknown as Session | undefined;
  }
  listSessions(taskId: string): Session[] {
    return this.db.prepare('SELECT * FROM session WHERE task_id = ?').all(taskId) as unknown as Session[];
  }
  latestSession(taskId: string): Session | undefined {
    return this.db.prepare('SELECT * FROM session WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as unknown as Session | undefined;
  }
  updateSession(id: string, fields: Partial<Pick<Session, 'status' | 'engine_session_id' | 'permission_mode' | 'model' | 'effort'>>) {
    for (const [k, v] of Object.entries(fields)) {
      this.db.prepare(`UPDATE session SET ${k} = ? WHERE id = ?`).run(v as string | null, id);
    }
  }

  setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  /** `null` removes the setting. */
  setSetting(key: string, value: string | null) {
    if (value == null) this.db.prepare('DELETE FROM setting WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO setting VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  /**
   * Brings stored state in line with what the runner reports as still running: other app sessions
   * marked running/waiting were lost (session and task become 'error'), and other pending approvals
   * of app sessions expire. External (MCP) sessions are not the runner's and are left alone.
   * Returns the lost sessions and every touched task.
   */
  reconcile(liveSessions: Set<string>, liveApprovals: Set<string>): { lost: { id: string; task_id: string }[]; touched: string[] } {
    const lost = (this.db.prepare(
      "SELECT id, task_id FROM session WHERE source = 'app' AND status IN ('running', 'waiting')",
    ).all() as unknown as { id: string; task_id: string }[]).filter((r) => !liveSessions.has(r.id));
    const appSessions = new Set((this.db.prepare("SELECT id FROM session WHERE source = 'app'").all() as
      unknown as { id: string }[]).map((r) => r.id));
    // desk_request cards are the hub's own, not the runner's.
    const expired = this.pendingApprovals().filter((a) => appSessions.has(a.session_id) && !liveApprovals.has(a.id)
      && a.tool_name !== REQUEST_TOOL);
    for (const r of lost) {
      this.db.prepare("UPDATE session SET status = 'error' WHERE id = ?").run(r.id);
      this.db.prepare("UPDATE task SET status = 'error', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')")
        .run(now(), r.task_id);
    }
    for (const a of expired) this.setApprovalStatus(a.id, 'denied');
    return { lost, touched: [...new Set([...lost.map((r) => r.task_id), ...expired.map((a) => a.task_id)])] };
  }

  addEvent(sessionId: string, taskId: string, kind: EventKind, payload: unknown): Event {
    const ts = now();
    const r = this.db.prepare('INSERT INTO event (session_id, task_id, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, taskId, ts, kind, JSON.stringify(payload));
    return { id: Number(r.lastInsertRowid), session_id: sessionId, task_id: taskId, ts, kind, payload };
  }
  /**
   * Adds a taken-over session's history at once, with its original times. The payloads start with
   * `"imported":true`, which keeps them out of the all-tasks feed (IMPORTED); the thread shows them.
   */
  importEvents(sessionId: string, taskId: string, events: { ts: string; kind: EventKind; payload: Record<string, unknown> }[]) {
    const ins = this.db.prepare('INSERT INTO event (session_id, task_id, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const e of events) ins.run(sessionId, taskId, e.ts || now(), e.kind, JSON.stringify({ imported: true, ...e.payload }));
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  /** The desk session already continuing this engine conversation, if any. */
  sessionByEngineId(engineSessionId: string): Session | undefined {
    return this.db.prepare('SELECT * FROM session WHERE engine_session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(engineSessionId) as unknown as Session | undefined;
  }
  /**
   * The task's newest `limit` events, oldest first; `since`: also every event from that id on.
   * `before`: only events below that id, so a client pages further back from its oldest event.
   */
  listEvents(taskId: string, limit = 500, since?: number, before = Number.MAX_SAFE_INTEGER): Event[] {
    const rows = this.db.prepare(
      `SELECT * FROM event WHERE task_id = ? AND id < ? AND (id >= ? OR id IN
         (SELECT id FROM event WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?)) ORDER BY id`,
    ).all(taskId, before, since ?? Number.MAX_SAFE_INTEGER, taskId, before, limit) as unknown as (Omit<Event, 'payload'> & { payload_json: string })[];
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }
  /** The task's events with these ids, oldest first: whole payloads of events a client got cut. */
  eventsByIds(taskId: string, ids: number[]): Event[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM event WHERE task_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(taskId, ...ids) as unknown as (Omit<Event, 'payload'> & { payload_json: string })[];
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }
  /** Whether the task has events below `id` (more history before a page that starts there). */
  hasEventsBefore(taskId: string, id: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM event WHERE task_id = ? AND id < ? LIMIT 1').get(taskId, id);
  }
  /**
   * Most recent events across all tasks, oldest first; `beforeId` pages further back. `f` narrows
   * them to a feed column's tasks, projects, task statuses, event kinds, and a text search.
   */
  listFeed(limit = 1000, beforeId = Number.MAX_SAFE_INTEGER, f: FeedFilter = {}): Event[] {
    const { where, args } = feedWhere(f);
    const rows = this.db.prepare(
      `SELECT * FROM (SELECT e.* FROM event e JOIN task t ON t.id = e.task_id WHERE e.id < ? AND ${where}
         ORDER BY e.id DESC LIMIT ?) ORDER BY id`,
    ).all(beforeId, ...args, limit) as unknown as (Omit<Event, 'payload'> & { payload_json: string })[];
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }
  /**
   * How many posts (web buildPosts) a feed column has in all, and in how many tasks: the events
   * listFeed gives for `f` that start a post rather than fold into the one before.
   */
  countFeed(f: FeedFilter = {}): { posts: number; tasks: number } {
    const { where, args } = feedWhere(f);
    return this.db.prepare(
      `SELECT count(*) AS posts, count(DISTINCT e.task_id) AS tasks FROM event e JOIN task t ON t.id = e.task_id
         WHERE ${where} AND ${IS_POST}`,
    ).get(...args) as unknown as { posts: number; tasks: number };
  }
  /**
   * A task's newest event without its payload: the task list only needs when it happened, and a
   * tool result can be hundreds of KB, sent again with every task update. A status event keeps its
   * state (`{ state }`), so a page can tell a turn that finished from one that was interrupted.
   */
  lastEvent(taskId: string): Event | undefined {
    const row = this.db.prepare(
      `SELECT id, session_id, task_id, ts, kind, CASE WHEN kind = 'status' THEN json_extract(payload_json, '$.state') END AS state
         FROM event WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(taskId) as unknown as (Omit<Event, 'payload'> & { state: string | null }) | undefined;
    if (!row) return undefined;
    const { state, ...e } = row;
    return { ...e, payload: state == null ? null : { state } };
  }

  createApproval(a: Approval) {
    this.db.prepare('INSERT INTO approval VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.session_id, a.task_id, a.tool_name, JSON.stringify(a.input), a.status, a.created_at);
  }
  setApprovalStatus(id: string, status: Approval['status']) {
    this.db.prepare('UPDATE approval SET status = ? WHERE id = ?').run(status, id);
  }
  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approval WHERE id = ?').get(id) as
      unknown as (Omit<Approval, 'input'> & { input_json: string }) | undefined;
    if (!row) return undefined;
    const { input_json, ...a } = row;
    return { ...a, input: JSON.parse(input_json) };
  }
  pendingApprovals(): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approval WHERE status = 'pending' ORDER BY created_at").all() as
      unknown as (Omit<Approval, 'input'> & { input_json: string })[];
    return rows.map(({ input_json, ...a }) => ({ ...a, input: JSON.parse(input_json) }));
  }

  createQuestion(q: Question) {
    this.db.prepare('INSERT INTO question VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(q.id, q.session_id, q.task_id, q.text, q.status, q.answer, q.created_at, q.answered_at);
  }
  getQuestion(id: string): Question | undefined {
    return this.db.prepare('SELECT * FROM question WHERE id = ?').get(id) as unknown as Question | undefined;
  }
  setQuestionStatus(id: string, status: Question['status'], answer: string | null = null) {
    this.db.prepare('UPDATE question SET status = ?, answer = ?, answered_at = ? WHERE id = ?').run(status, answer, now(), id);
  }
  pendingQuestions(): Question[] {
    return this.db.prepare("SELECT * FROM question WHERE status = 'pending' ORDER BY created_at").all() as unknown as Question[];
  }
  createRequest(r: AgentRequest) {
    this.db.prepare(`INSERT INTO request (id, from_task_id, from_session_id, to_task_id, to_session_id, text, status, answer,
      approval_id, queued_id, prompt_event_id, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.from_task_id, r.from_session_id, r.to_task_id, r.to_session_id, r.text, r.status, r.answer,
        r.approval_id, r.queued_id, r.prompt_event_id, r.created_at, r.answered_at);
  }
  getRequest(id: string): AgentRequest | undefined {
    return this.db.prepare('SELECT * FROM request WHERE id = ?').get(id) as unknown as AgentRequest | undefined;
  }
  updateRequest(id: string, r: Partial<Pick<AgentRequest, 'status' | 'answer' | 'queued_id' | 'prompt_event_id' | 'to_session_id' | 'answered_at'>>) {
    const keys = Object.keys(r) as (keyof typeof r)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE request SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => r[k] ?? null), id);
  }
  /** Requests not settled yet: waiting for approval, queued at the target, or being answered. */
  openRequests(): AgentRequest[] {
    return this.db.prepare("SELECT * FROM request WHERE status IN ('approval', 'queued', 'running') ORDER BY created_at")
      .all() as unknown as AgentRequest[];
  }
  /** The task's newest `user` event, or its newest `assistant` one after event `afterId`. */
  lastEventOf(taskId: string, kind: 'user' | 'assistant', afterId = 0): Event | undefined {
    const row = this.db.prepare('SELECT * FROM event WHERE task_id = ? AND kind = ? AND id > ? ORDER BY id DESC LIMIT 1')
      .get(taskId, kind, afterId) as unknown as (Omit<Event, 'payload'> & { payload_json: string }) | undefined;
    if (!row) return undefined;
    const { payload_json, ...e } = row;
    return { ...e, payload: JSON.parse(payload_json) };
  }

  /**
   * The task's Codex async question still unanswered: an agent message with `questions` that no
   * message of mine followed (the next one is the answer).
   */
  openAsyncQuestion(taskId: string): { event_id: number; text: string; ts: string } | null {
    const lastUser = this.lastEventOf(taskId, 'user')?.id ?? 0;
    const row = this.db.prepare(`SELECT id, ts, payload_json FROM event WHERE task_id = ? AND kind = 'assistant' AND id > ?
      AND payload_json LIKE '%"questions":[%' ORDER BY id DESC LIMIT 1`).get(taskId, lastUser) as
      { id: number; ts: string; payload_json: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json) as { text?: string; questions?: unknown[] };
    return p.questions?.length ? { event_id: row.id, text: p.text ?? '', ts: row.ts } : null;
  }

  /** Projects whose root contains `path`, deepest first. */
  projectsContaining(path: string): Project[] {
    return this.listProjects()
      .filter((p) => path === p.root_path || path.startsWith(p.root_path.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.root_path.length - a.root_path.length);
  }

  enqueue(q: Queued) {
    this.db.prepare(`INSERT INTO queued (id, task_id, session_id, text, body, skills_json, mode, created_at, kind, channel_context_json, ord)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(ord), 0) + 1 FROM queued))`)
      .run(q.id, q.task_id, q.session_id, q.text, q.body, JSON.stringify(q.skills), q.mode, q.created_at, q.kind ?? null, q.channel_context ? JSON.stringify(q.channel_context) : null);
  }
  /** Hands a session's waiting messages to the session that replaced it. */
  moveQueued(fromSession: string, toSession: string) {
    this.db.prepare('UPDATE queued SET session_id = ? WHERE session_id = ?').run(toSession, fromSession);
  }
  /** Waiting messages in the order they go out: of one session, of one task, or all. */
  queued(by: { sessionId?: string; taskId?: string } = {}): Queued[] {
    const [where, arg] = by.sessionId ? ['WHERE session_id = ?', by.sessionId] : by.taskId ? ['WHERE task_id = ?', by.taskId] : ['', null];
    const stmt = this.db.prepare(`SELECT * FROM queued ${where} ORDER BY ord, created_at, rowid`);
    const rows = (arg ? stmt.all(arg) : stmt.all()) as unknown as (Omit<Queued, 'skills'> & { skills_json: string; channel_context_json: string | null; ord: number })[];
    return rows.map(({ skills_json, channel_context_json, ord: _, ...q }) => ({ ...q, skills: JSON.parse(skills_json), ...(channel_context_json ? { channel_context: JSON.parse(channel_context_json) } : {}) }));
  }
  /** Puts waiting messages in the order of `ids` (all of one task's), reusing their order slots. */
  reorderQueued(ids: string[]) {
    const slots = (this.db.prepare(`SELECT ord FROM queued WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY ord`)
      .all(...ids) as { ord: number }[]).map((r) => r.ord);
    const set = this.db.prepare('UPDATE queued SET ord = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try { ids.forEach((id, i) => set.run(slots[i], id)); this.db.exec('COMMIT'); }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  /** Removes a waiting message; false when it was already sent or cancelled. */
  dequeue(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM queued WHERE id = ?').run(id).changes) > 0;
  }

  upsertRunner(id: string, host: string, capabilities: unknown) {
    this.db.prepare(`INSERT INTO runner VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host = excluded.host, capabilities_json = excluded.capabilities_json,
      last_seen = excluded.last_seen`).run(id, host, JSON.stringify(capabilities), now());
  }
}
