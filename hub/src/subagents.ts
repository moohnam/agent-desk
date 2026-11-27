// The subagents and background commands of a task's sessions, and what each was told, said and did.
// Kept apart from the thread's events (so they never crowd its pages, the feed or its search) but
// alike: the same event kinds and payloads, cut the same way live, kept until the task is deleted.

import type { BackgroundTask, SubagentEvent as RunnerSubagentEvent, SubagentInfo } from '../../shared/protocol.ts';
import type { HubMessage, Subagent, SubagentEvent } from '../../shared/api.ts';
import { feedEvent, now, type Session, type Store } from './db.ts';

export const SUBAGENT_PAGE_SIZE = 30;

interface Row {
  session_id: string; id: string; task_id: string; status: string; detailed: number; listed: number;
  info_json: string; created_at: string; updated_at: string;
}
type EventRow = Omit<SubagentEvent, 'payload'> & { payload_json: string };

const readRow = (r: Row): Subagent => ({
  ...JSON.parse(r.info_json) as SubagentInfo, session_id: r.session_id, task_id: r.task_id,
  detailed: r.detailed === 1, created_at: r.created_at, updated_at: r.updated_at,
});
const readEvent = ({ payload_json, ...e }: EventRow): SubagentEvent => ({ ...e, payload: JSON.parse(payload_json) });

export class Subagents {
  private store: Store;
  private publish: (m: HubMessage) => void;
  constructor(store: Store, publish: (m: HubMessage) => void) {
    this.store = store;
    this.publish = publish;
  }
  private get db() { return this.store.database; }

  private row(sessionId: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM subagent WHERE session_id = ? AND id = ?').get(sessionId, id) as unknown as Row | undefined;
  }
  private save(session: Session, full: SubagentInfo, detailed: boolean, listed: boolean, at: string) {
    const info = { ...full, description: full.description.slice(0, 500), ...(full.summary && { summary: full.summary.slice(0, 8000) }),
      ...(full.command && { command: full.command.slice(0, 2000) }), ...(full.output && { output: full.output.slice(-4000) }) };
    const created = this.row(session.id, info.id)?.created_at ?? at;
    this.db.prepare(`INSERT INTO subagent (session_id, id, task_id, status, detailed, listed, info_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, id) DO UPDATE SET status = excluded.status,
      detailed = excluded.detailed, listed = excluded.listed, info_json = excluded.info_json, updated_at = excluded.updated_at`)
      .run(session.id, info.id, session.task_id, info.status, detailed ? 1 : 0, listed ? 1 : 0, JSON.stringify(info), created, at);
    this.publish({ type: 'subagent', subagent: readRow(this.row(session.id, info.id)!) });
  }

  /**
   * A runner's report replaces what was known of the subagent, but for where it came from: a runner
   * that resumed the session meets it first at a follow-up, not at the call that started it.
   */
  report(session: Session, info: SubagentInfo, at = now()) {
    const row = this.row(session.id, info.id);
    const known: Partial<SubagentInfo> = row ? JSON.parse(row.info_json) : {};
    this.save(session, { ...info, toolUseId: known.toolUseId ?? info.toolUseId, agent: info.agent ?? known.agent,
      parentId: info.parentId ?? known.parentId, command: info.command ?? known.command, output: info.output ?? (info.status === 'running' ? undefined : known.output) }, true, row?.listed === 1, at);
  }

  /** One step of a subagent's conversation; live copies come cut like a thread's (feedEvent). */
  event(session: Session, subagentId: string, event: RunnerSubagentEvent, at = now()) {
    // The runner reports a subagent before its steps; steps of none it reported are not kept.
    if (!this.row(session.id, subagentId)) return;
    if (event.sourceId && this.db.prepare("SELECT 1 FROM subagent_event WHERE session_id = ? AND subagent_id = ? AND json_extract(payload_json, '$.sourceId') = ? LIMIT 1").get(session.id, subagentId, event.sourceId)) return;
    // A parent call and a child message can share an explicit client ID.
    // Equal text alone cannot distinguish a retry from an intentional follow-up.
    if(session.engine==='codex' && event.kind==='user' && event.sourceId){
      if(event.codexCallId && this.db.prepare("SELECT 1 FROM subagent_event WHERE session_id=? AND subagent_id=? AND json_extract(payload_json,'$.sourceId')=?").get(session.id,subagentId,'collab-prompt:'+event.codexCallId))return;
      if(event.sourceId.startsWith('collab-prompt:') && this.db.prepare("SELECT 1 FROM subagent_event WHERE session_id=? AND subagent_id=? AND kind='user' AND json_extract(payload_json,'$.codexCallId')=?").get(session.id,subagentId,event.sourceId.slice('collab-prompt:'.length)))return;
    }
    const r = this.db.prepare('INSERT INTO subagent_event (session_id, task_id, subagent_id, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, session.task_id, subagentId, at, event.kind, JSON.stringify(event));
    const stored: SubagentEvent = { id: Number(r.lastInsertRowid), session_id: session.id, task_id: session.task_id,
      subagent_id: subagentId, ts: at, kind: event.kind, payload: event };
    this.publish({ type: 'subagent_event', event: { ...feedEvent(stored), subagent_id: subagentId } });
  }

  /**
   * The session's background list, from every engine. An entry not seen before starts a record; one
   * listed before and now gone has ended. One the runner reports (`detailed`) runs and ends as it
   * says: the list still holds a finished one until the list changes next.
   */
  background(session: Session, tasks: BackgroundTask[], at = now()) {
    // Ordinary Codex/AGY tools and list-status entries are runtime guards, not background work.
    // Legacy shell entries without native background evidence must not create history.
    const work = tasks.filter(t => t.type !== 'status' && t.type !== 'tool' && (t.type !== 'shell' || t.backgroundEvidence === 'native'));
    const listed = new Set(work.map(t => t.id));
    for (const t of work) {
      const row = this.row(session.id, t.id);
      const known: SubagentInfo | undefined = row && JSON.parse(row.info_json);
      if (row?.detailed === 1) { if (row.listed !== 1) this.save(session, known!, true, true, at); continue; }
      if (row?.listed === 1 && row.status === 'running' && known!.description === t.description && known!.agent === t.agent && known!.backgroundEvidence === t.backgroundEvidence) continue;
      this.save(session, { ...known, id: t.id, type: t.type, description: t.description, agent: t.agent, status: 'running', background: true, backgroundEvidence: t.backgroundEvidence }, false, true, at);
    }
    const gone = this.db.prepare("SELECT * FROM subagent WHERE session_id = ? AND status = 'running' AND listed = 1 AND detailed = 0")
      .all(session.id) as unknown as Row[];
    for (const row of gone) if (!listed.has(row.id)) this.save(session, { ...JSON.parse(row.info_json), status: 'ended' }, false, true, at);
  }

  /** The session is gone (closed, or its runner no longer has it): what it still ran stopped with it. */
  stopped(session: Session, at = now()) {
    const rows = this.db.prepare("SELECT * FROM subagent WHERE session_id = ? AND status = 'running'").all(session.id) as unknown as Row[];
    for (const row of rows) this.save(session, { ...JSON.parse(row.info_json), status: 'stopped' }, row.detailed === 1, row.listed === 1, at);
  }
  /** The turn ended: subagents it waited for (not in the background) have ended, even if their last report was lost. */
  turnEnded(session: Session, at = now()) {
    const rows = this.db.prepare("SELECT * FROM subagent WHERE session_id = ? AND status = 'running' AND detailed = 1").all(session.id) as unknown as Row[];
    for (const row of rows) {
      const info: SubagentInfo = JSON.parse(row.info_json);
      if (!info.background) this.save(session, { ...info, status: 'ended' }, true, row.listed === 1, at);
    }
  }
  /** Sessions with a subagent still recorded as running. */
  runningSessions(): string[] {
    return (this.db.prepare("SELECT DISTINCT session_id FROM subagent WHERE status = 'running'").all() as { session_id: string }[])
      .map(r => r.session_id);
  }

  /** The task's subagents, oldest first. */
  list(taskId: string): Subagent[] {
    return (this.db.prepare('SELECT * FROM subagent WHERE task_id = ? ORDER BY created_at, id').all(taskId) as unknown as Row[]).map(readRow);
  }
  /** Non-running agents' newest steps across all task sessions; commands stay out of this history. */
  history(taskId: string, limit = SUBAGENT_PAGE_SIZE, before = Number.MAX_SAFE_INTEGER): { events: SubagentEvent[]; more: boolean } {
    const rows = this.db.prepare(`SELECT e.* FROM subagent_event e
      JOIN subagent s ON s.session_id = e.session_id AND s.id = e.subagent_id AND s.task_id = e.task_id
      WHERE e.task_id = ? AND s.status != 'running'
        AND json_extract(s.info_json, '$.type') NOT IN ('shell', 'local_bash') AND e.id < ?
      ORDER BY e.id DESC LIMIT ?`).all(taskId, before, limit + 1) as unknown as EventRow[];
    return { events: rows.slice(0, limit).reverse().map(readEvent), more: rows.length > limit };
  }
  /** A subagent's newest `limit` steps (before `before`), oldest first; `more`: older ones exist. */
  events(taskId: string, sessionId: string, id: string, limit = SUBAGENT_PAGE_SIZE, before = Number.MAX_SAFE_INTEGER): { events: SubagentEvent[]; more: boolean } {
    const rows = this.db.prepare(`SELECT * FROM subagent_event WHERE task_id = ? AND session_id = ? AND subagent_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?`).all(taskId, sessionId, id, before, limit + 1) as unknown as EventRow[];
    return { events: rows.slice(0, limit).reverse().map(readEvent), more: rows.length > limit };
  }
}
