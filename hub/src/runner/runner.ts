import type { Engine, EngineAdapter, HubToRunner, LiveSession, RunnerToHub } from './protocol.ts';
import { startClaude } from './claude.ts';
import { startCodex } from './codex.ts';

/** A session neither busy nor awaiting approval for this long is closed; the hub resumes it on the next message. */
const DEFAULT_IDLE_MS = 30 * 60_000;

type StartEngine = typeof startClaude;
const ENGINES: Record<Engine, StartEngine> = { claude: startClaude, codex: startCodex };

interface Entry {
  adapter: EngineAdapter | null;
  live: LiveSession;
  idleTimer: NodeJS.Timeout | null;
}

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
    const envIdle = Number(process.env.RUNNER_IDLE_MS);
    this.idleMs = opts.idleMs ?? (envIdle > 0 ? envIdle : DEFAULT_IDLE_MS);
    this.start = opts.start ?? null;
  }

  get capabilities() { return { engines: Object.keys(ENGINES) }; }

  /** Sessions still running, so a reconnecting hub can learn what is busy and awaiting approval. */
  snapshot(): LiveSession[] {
    return [...this.sessions.values()].map(({ live: s }) => ({ ...s, approvals: [...s.approvals] }));
  }

  /** Arms the idle timer when the session has nothing in progress, disarms it otherwise. */
  private schedule(sessionId: string, entry: Entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entry.live.busy || entry.live.approvals.length) return;
    entry.idleTimer = setTimeout(() => this.closeIdle(sessionId, entry), this.idleMs);
    entry.idleTimer.unref?.();
  }

  private closeIdle(sessionId: string, entry: Entry) {
    if (this.sessions.get(sessionId) !== entry || entry.live.busy || entry.live.approvals.length) return;
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

  handle(cmd: HubToRunner) {
    switch (cmd.type) {
      case 'start': {
        const old = this.sessions.get(cmd.sessionId);
        if (old) { this.drop(cmd.sessionId, old); old.adapter?.close(); }
        const entry: Entry = { adapter: null, live: { sessionId: cmd.sessionId, busy: false, approvals: [] }, idleTimer: null };
        this.sessions.set(cmd.sessionId, entry);
        entry.adapter = (this.start ?? ENGINES[cmd.engine] ?? startClaude)({
          sessionId: cmd.sessionId, cwd: cmd.cwd, prompt: cmd.prompt, resume: cmd.resume, fork: cmd.fork, permissionMode: cmd.permissionMode,
          model: cmd.model, effort: cmd.effort, skills: cmd.skills, skillsHome: cmd.skillsHome,
          emit: (m) => { if (this.track(entry, m)) this.emit(m); },
        });
        if (this.sessions.get(cmd.sessionId) === entry) this.schedule(cmd.sessionId, entry);
        break;
      }
      case 'send':
        this.sessions.get(cmd.sessionId)?.adapter?.send(cmd.text, cmd.skills, cmd.steer);
        break;
      case 'set_mode':
        this.sessions.get(cmd.sessionId)?.adapter?.setMode(cmd.permissionMode).catch((err) => this.emit({
          type: 'event', sessionId: cmd.sessionId,
          event: { kind: 'status', state: 'error', detail: { message: `모드 변경 실패: ${err?.message ?? err}` } },
        }));
        break;
      case 'set_model':
        this.sessions.get(cmd.sessionId)?.adapter?.setModel(cmd.model, cmd.effort).catch((err) => this.emit({
          type: 'event', sessionId: cmd.sessionId,
          event: { kind: 'status', state: 'error', detail: { message: `모델 변경 실패: ${err?.message ?? err}` } },
        }));
        break;
      case 'interrupt':
        void this.sessions.get(cmd.sessionId)?.adapter?.interrupt();
        break;
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
}
