import type { Capabilities, Engine, EngineAdapter, HubToRunner, LiveSession, RunnerToHub } from '../../../shared/protocol.ts';
import { config } from '../config.ts';
import { startClaude } from './claude.ts';
import type { StartEngine } from './engine.ts';
import { startAgy } from './agy.ts';
import { startCodex } from './codex.ts';
import { materializeSkillSnapshot, pruneSkillSnapshots } from './skill-input.ts';


const ENGINES: Record<Engine, StartEngine> = { claude: startClaude, codex: startCodex, agy: startAgy };

interface Entry {
  adapter: EngineAdapter | null;
  live: LiveSession;
  idleTimer: NodeJS.Timeout | null;
  skillsHome?: string;
  snapshotHomes: Set<string>;
}
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const idle = (e: Entry) => !e.live.busy && !e.live.approvals.length && !e.live.background?.length;

/** Runs engine sessions on this machine. Talks to the hub only through protocol messages. */
export class Runner {
  readonly id: string;
  private emit: (m: RunnerToHub) => void;
  // One entry per session; a replaced or closed adapter's later messages are dropped by identity.
  private sessions = new Map<string, Entry>();
  private idleMs: number;
  /** Test override: one start function for every engine. */
  private start: StartEngine | null;

  constructor(id: string, emit: (m: RunnerToHub) => void, opts: { idleMs?: number; start?: StartEngine } = {}) {
    this.id = id;
    this.emit = emit;
    this.idleMs = opts.idleMs ?? config.runner.idleMs;
    this.start = opts.start ?? null;
  }

  /** `close`: understands the close command (older runners ignore it). */
  get capabilities(): Capabilities { return { engines: Object.keys(ENGINES), close: true, skillSnapshot: true }; }

  /** Sessions still running, so a reconnecting hub can learn what is busy and awaiting approval. */
  snapshot(): LiveSession[] {
    return [...this.sessions.values()].map(({ live: s }) => ({ ...s, approvals: [...s.approvals] }));
  }

  /** Stops this process's engines without treating their queued input as user-cancelled. */
  shutdown() {
    for (const [sessionId, entry] of this.sessions) {
      this.drop(sessionId, entry);
      let error: string | undefined;
      try { entry.adapter?.close(); } catch (e) { error = errorText(e); }
      this.emit({ type: 'closed', sessionId, busy: entry.live.busy, reason: 'shutdown', ...(error && { error }) });
    }
  }

  /**
   * Arms the idle timer when the session has nothing in progress, disarms it otherwise. Work left
   * running in the background (a subagent) counts: closing would end it.
   */
  private schedule(sessionId: string, entry: Entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (!idle(entry)) return;
    entry.idleTimer = setTimeout(() => this.closeIdle(sessionId, entry), this.idleMs);
    entry.idleTimer.unref?.();
  }

  private closeIdle(sessionId: string, entry: Entry) {
    if (this.sessions.get(sessionId) !== entry || !idle(entry)) return;
    this.drop(sessionId, entry);
    entry.adapter?.close();
    this.emit({ type: 'closed', sessionId, busy: false, reason: 'idle' });
  }

  private drop(sessionId: string, entry: Entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
  }

  /** Applies an adapter's message to the session state; false when the message is stale and dropped. */
  private track(entry: Entry, m: RunnerToHub): boolean {
    if (m.type === 'hello') return true;
    if (this.sessions.get(m.sessionId) !== entry) return false;
    const s = entry.live;
    switch (m.type) {
      case 'busy': s.busy = m.busy; this.schedule(m.sessionId, entry); break;
      case 'background': s.background = m.tasks; this.schedule(m.sessionId, entry); break;
      case 'approval_request':
        s.approvals.push({ approvalId: m.approvalId, toolName: m.toolName, input: m.input });
        this.schedule(m.sessionId, entry);
        break;
      case 'approval_cancelled':
        s.approvals = s.approvals.filter((a) => a.approvalId !== m.approvalId);
        this.schedule(m.sessionId, entry);
        break;
      case 'closed':
        this.drop(m.sessionId, entry);
        // Tell the hub whether the session ended mid-turn.
        m.busy = s.busy;
        break;
    }
    return true;
  }

  /**
   * Runs an adapter call whose failure belongs to that session: reported as a warning on it
   * instead of rejecting unhandled, which would take every session of the daemon down.
   */
  private attempt(sessionId: string, what: string, call: (a: EngineAdapter) => Promise<void>) {
    const adapter = this.sessions.get(sessionId)?.adapter;
    if (!adapter) return;
    const report = (err: unknown) => this.emit({
      type: 'event', sessionId, event: { kind: 'status', state: 'warning', detail: { message: `${what}: ${errorText(err)}` } },
    });
    try { call(adapter).catch(report); } catch (err) { report(err); }
  }

  handle(cmd: HubToRunner) {
    switch (cmd.type) {
      case 'start': {
        const old = this.sessions.get(cmd.sessionId);
        if (old) { this.drop(cmd.sessionId, old); old.adapter?.close(); }
        const entry: Entry = { adapter: null, live: { sessionId: cmd.sessionId, busy: false, approvals: [] }, idleTimer: null, skillsHome: cmd.skillsHome, snapshotHomes: new Set() };
        this.sessions.set(cmd.sessionId, entry);
        // An engine this runner doesn't know (a newer hub talking to an older daemon) must not run as another engine.
        const start = this.start ?? (Object.hasOwn(ENGINES, cmd.engine) ? ENGINES[cmd.engine] : null);
        try {
          if (!start) throw new Error(`이 러너는 ${cmd.engine} 엔진을 모릅니다. 러너를 다시 시작하세요`);
          const skillSnapshotHome = cmd.skillSnapshot
            ? materializeSkillSnapshot(cmd.skillsHome ?? config.skillsHome, cmd.skillSnapshot, this.protectedHomes()) : undefined;
          if (skillSnapshotHome) entry.snapshotHomes.add(skillSnapshotHome);
          entry.adapter = start({
            sessionId: cmd.sessionId, cwd: cmd.cwd, prompt: cmd.prompt, resume: cmd.resume, fork: cmd.fork, permissionMode: cmd.permissionMode,
            model: cmd.model, effort: cmd.effort, skills: cmd.skills, skillsHome: cmd.skillsHome, skillSnapshotHome,
            emit: (m) => { if (this.track(entry, m)) this.emit(m); },
          });
        } catch (err) {
          if (this.sessions.get(cmd.sessionId) === entry) this.drop(cmd.sessionId, entry);
          this.emit({ type: 'closed', sessionId: cmd.sessionId, busy: false, error: errorText(err) });
          break;
        }
        if (this.sessions.get(cmd.sessionId) === entry) this.schedule(cmd.sessionId, entry);
        if (entry.snapshotHomes.size) this.prune(entry.skillsHome ?? config.skillsHome);
        break;
      }
      case 'send': {
        const entry = this.sessions.get(cmd.sessionId);
        if (!entry?.adapter) break;
        let skillSnapshotHome: string | undefined;
        try {
          skillSnapshotHome = cmd.skillSnapshot
            ? materializeSkillSnapshot(entry.skillsHome ?? config.skillsHome, cmd.skillSnapshot, this.protectedHomes()) : undefined;
        } catch (err) {
          this.emit({ type: 'event', sessionId: cmd.sessionId, event: { kind: 'status', state: 'error', detail: {
            message: `스킬 스냅샷 준비 실패: ${errorText(err)}`,
          } } });
          if (!entry.live.busy) this.emit({ type: 'busy', sessionId: cmd.sessionId, busy: false });
          break;
        }
        if (skillSnapshotHome) entry.snapshotHomes.add(skillSnapshotHome);
        entry.adapter.send(cmd.text, cmd.skills, cmd.steer, skillSnapshotHome);
        if (skillSnapshotHome) this.prune(entry.skillsHome ?? config.skillsHome);
        break;
      }
      case 'set_mode':
        this.attempt(cmd.sessionId, '모드 변경 실패', (a) => a.setMode(cmd.permissionMode));
        break;
      case 'set_model':
        this.attempt(cmd.sessionId, '모델 변경 실패', (a) => a.setModel(cmd.model, cmd.effort));
        break;
      case 'interrupt':
        this.attempt(cmd.sessionId, '중단 실패', (a) => a.interrupt());
        break;
      case 'close': {
        const entry = this.sessions.get(cmd.sessionId);
        if (!entry) break;
        this.drop(cmd.sessionId, entry);
        entry.adapter?.close();
        this.emit({ type: 'closed', sessionId: cmd.sessionId, busy: entry.live.busy, reason: 'user' });
        break;
      }
      case 'approval_result': {
        const entry = this.sessions.get(cmd.sessionId);
        if (!entry) break;
        entry.live.approvals = entry.live.approvals.filter((a) => a.approvalId !== cmd.approvalId);
        entry.adapter?.resolveApproval(cmd.approvalId, cmd.allow, cmd.message, cmd.answers);
        this.schedule(cmd.sessionId, entry);
        break;
      }
    }
  }

  private prune(skillsHome: string) {
    pruneSkillSnapshots(skillsHome, this.protectedHomes());
  }

  private protectedHomes() { return [...this.sessions.values()].flatMap(entry => [...entry.snapshotHomes]); }
}
