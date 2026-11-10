// Messages between the hub and a runner. The runner is a separate daemon (daemon.ts) so that
// restarting the hub does not kill running sessions; the two exchange these shapes as
// newline-delimited JSON over a loopback TCP socket.

import type { Effort, EngineName, ModelName, PermissionMode } from './compose.ts';
import type { RunnerStatusState } from './events.ts';

/**
 * Answers to an ASK_USER approval (a multiple-choice question from the agent), keyed by question
 * text. Several picks of one question are joined with ", "; free text goes in as typed.
 */
export type Answers = Record<string, string>;
/** The tool name of an agent's multiple-choice question; its input is Claude's AskUserQuestion input. */
export const ASK_USER = 'AskUserQuestion';

export type Engine = EngineName;
export interface SkillTransfer { name: string; path: string; content: string; executable: boolean }

/**
 * Bumped when a message changes in a way the other side must know. The hub sends its version with
 * the token; the runner says its own in the hello, and the hub warns when they differ.
 */
export const PROTOCOL_VERSION = 1;

/** What a runner can do: the engines it runs, and `close`: it understands the close command. */
export interface Capabilities { engines: string[]; close?: boolean }

/** A Codex question asked in passing (delivery 'async'): the user's next message answers it. */
export interface AsyncQuestion { title: string; options: string[] }

export type HubToRunner =
  /**
   * The first message on a connection. The runner takes the connection as the hub's only with the
   * token (data/runner-token, which only this user can read), so another local process can't.
   */
  | { type: 'auth'; token: string; protocolVersion: number }
  /**
   * `skills`: desk skills (#tags) to apply to this message only. `skillsHome`: the desk plugin
   * directory (skills.ts) the session loads skills from; both engines read the same files.
   * `fork`: start a new conversation from a copy of `resume` instead of continuing it (#fork).
   * `model`/`effort`: the task's model (alias or family) and effort; absent leaves the engine's default.
   */
  | { type: 'start'; sessionId: string; engine: Engine; cwd: string; prompt: string; resume?: string; fork?: boolean;
      permissionMode: PermissionMode; model?: ModelName; effort?: Effort; skills?: string[]; skillsHome?: string; skillFiles?: SkillTransfer[] }
  /** `steer`: add the message to the running turn (#now) instead of running it after (the hub queues #later). */
  | { type: 'send'; sessionId: string; text: string; skills?: string[]; steer?: boolean; skillFiles?: SkillTransfer[] }
  | { type: 'set_mode'; sessionId: string; permissionMode: PermissionMode }
  /** Changes what is given; takes effect from the next turn. */
  | { type: 'set_model'; sessionId: string; model?: ModelName; effort?: Effort }
  | { type: 'interrupt'; sessionId: string }
  /** Ends the session now (the user closed it); a turn in progress is cut. */
  | { type: 'close'; sessionId: string }
  | { type: 'approval_result'; sessionId: string; approvalId: string; allow: boolean; message?: string; answers?: Answers };

export type RunnerEvent =
  | { kind: 'assistant'; text: string; questions?: AsyncQuestion[] }
  | { kind: 'tool'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  /**
   * 'model_changed': a turn ran on another model than the session last reported (after set_model).
   * 'warning': something the user should see that doesn't stop the turn (the task status is left alone);
   * 'error' is for a turn or session that failed.
   */
  | { kind: 'status'; state: RunnerStatusState; detail?: Record<string, unknown> };

/** Work the agent left running between turns, such as a subagent started in the background. */
export interface BackgroundTask { id: string; type: string; description: string; agent?: string }

/** A session the runner is still running, reported when the hub (re)connects. */
export interface LiveSession {
  sessionId: string; busy: boolean;
  approvals: { approvalId: string; toolName: string; input: unknown }[];
  background?: BackgroundTask[];
}

export type RunnerToHub =
  /** `protocolVersion`: absent from runners before it. */
  | { type: 'hello'; runnerId: string; host: string; capabilities: Capabilities; sessions: LiveSession[]; protocolVersion?: number }
  | { type: 'engine_session'; sessionId: string; engineSessionId: string }
  | { type: 'event'; sessionId: string; event: RunnerEvent }
  | { type: 'busy'; sessionId: string; busy: boolean }
  /** Everything the session has running in the background now (replaces the last list). */
  | { type: 'background'; sessionId: string; tasks: BackgroundTask[] }
  | { type: 'approval_request'; sessionId: string; approvalId: string; toolName: string; input: unknown }
  | { type: 'approval_cancelled'; sessionId: string; approvalId: string }
  /**
   * The session ended. `busy`: whether a turn was still in progress (runner's view). `reason`
   * 'idle': the runner closed it after RUNNER_IDLE_MS without activity; 'user': the user closed it;
   * 'shutdown': the runner process is stopping, without cancelling queued user input.
   * Either way the next message resumes it.
   */
  | { type: 'closed'; sessionId: string; error?: string; busy?: boolean; reason?: 'idle' | 'user' | 'shutdown' };

export interface EngineAdapter {
  send(text: string, skills?: string[], steer?: boolean): void;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model?: ModelName, effort?: Effort): Promise<void>;
  resolveApproval(approvalId: string, allow: boolean, message?: string, answers?: Answers): void;
  close(): void;
}

// Each side checks what it reads off the socket before acting on it: a malformed message is dropped
// with a log line instead of throwing halfway through.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || typeof v === 'string';
const strList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(str));
const MODES = ['auto', 'default'];

/** `m` as a hub command, or why it isn't one. */
export function checkHubToRunner(m: unknown): HubToRunner | string {
  if (!isObj(m) || !str(m.type)) return 'not a message';
  if (m.type === 'auth') return str(m.token) && typeof m.protocolVersion === 'number' ? m as HubToRunner : 'bad auth';
  if (!str(m.sessionId) || !m.sessionId) return `${m.type}: no sessionId`;
  switch (m.type) {
    case 'start':
      return str(m.engine) && str(m.cwd) && (m.cwd as string).startsWith('/') && str(m.prompt) && MODES.includes(m.permissionMode as string)
        && optStr(m.resume) && optStr(m.model) && optStr(m.effort) && strList(m.skills) && optStr(m.skillsHome)
        ? m as HubToRunner : 'start: bad fields';
    case 'send': return str(m.text) && strList(m.skills) ? m as HubToRunner : 'send: bad fields';
    case 'set_mode': return MODES.includes(m.permissionMode as string) ? m as HubToRunner : 'set_mode: bad mode';
    case 'set_model': return optStr(m.model) && optStr(m.effort) ? m as HubToRunner : 'set_model: bad fields';
    case 'interrupt': case 'close': return m as HubToRunner;
    case 'approval_result':
      return str(m.approvalId) && typeof m.allow === 'boolean' && optStr(m.message) && (m.answers === undefined || isObj(m.answers))
        ? m as HubToRunner : 'approval_result: bad fields';
    default: return `unknown type ${m.type}`;
  }
}

/** `m` as a runner message, or why it isn't one. Payloads (events, tool input) are the engine's and pass as they are. */
export function checkRunnerToHub(m: unknown): RunnerToHub | string {
  if (!isObj(m) || !str(m.type)) return 'not a message';
  if (m.type === 'hello') {
    return str(m.runnerId) && Array.isArray(m.sessions) && isObj(m.capabilities) && Array.isArray(m.capabilities.engines)
      ? m as RunnerToHub : 'hello: bad fields';
  }
  if (!str(m.sessionId)) return `${m.type}: no sessionId`;
  switch (m.type) {
    case 'engine_session': return str(m.engineSessionId) ? m as RunnerToHub : 'engine_session: no id';
    case 'event': return isObj(m.event) && str(m.event.kind) ? m as RunnerToHub : 'event: no kind';
    case 'busy': return typeof m.busy === 'boolean' ? m as RunnerToHub : 'busy: not a boolean';
    case 'background': return Array.isArray(m.tasks) ? m as RunnerToHub : 'background: no tasks';
    case 'approval_request': return str(m.approvalId) && str(m.toolName) ? m as RunnerToHub : 'approval_request: bad fields';
    case 'approval_cancelled': return str(m.approvalId) ? m as RunnerToHub : 'approval_cancelled: no id';
    case 'closed': return optStr(m.error) ? m as RunnerToHub : 'closed: bad error';
    default: return `unknown type ${m.type}`;
  }
}
