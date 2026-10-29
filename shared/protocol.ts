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

/** A Codex question asked in passing (delivery 'async'): the user's next message answers it. */
export interface AsyncQuestion { title: string; options: string[] }

export type HubToRunner =
  /**
   * `skills`: desk skills (#tags) to apply to this message only. `skillsHome`: the desk plugin
   * directory (skills.ts) the session loads skills from; both engines read the same files.
   * `fork`: start a new conversation from a copy of `resume` instead of continuing it (#fork).
   * `model`/`effort`: the task's model (alias or family) and effort; absent leaves the engine's default.
   */
  | { type: 'start'; sessionId: string; engine: Engine; cwd: string; prompt: string; resume?: string; fork?: boolean;
      permissionMode: PermissionMode; model?: ModelName; effort?: Effort; skills?: string[]; skillsHome?: string }
  /** `steer`: add the message to the running turn (#now) instead of running it after (the hub queues #later). */
  | { type: 'send'; sessionId: string; text: string; skills?: string[]; steer?: boolean }
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
  | { type: 'hello'; runnerId: string; host: string; capabilities: unknown; sessions: LiveSession[] }
  | { type: 'engine_session'; sessionId: string; engineSessionId: string }
  | { type: 'event'; sessionId: string; event: RunnerEvent }
  | { type: 'busy'; sessionId: string; busy: boolean }
  /** Everything the session has running in the background now (replaces the last list). */
  | { type: 'background'; sessionId: string; tasks: BackgroundTask[] }
  | { type: 'approval_request'; sessionId: string; approvalId: string; toolName: string; input: unknown }
  | { type: 'approval_cancelled'; sessionId: string; approvalId: string }
  /**
   * The session ended. `busy`: whether a turn was still in progress (runner's view). `reason`
   * 'idle': the runner closed it after RUNNER_IDLE_MS without activity; 'user': the user closed it.
   * Either way the next message resumes it.
   */
  | { type: 'closed'; sessionId: string; error?: string; busy?: boolean; reason?: 'idle' | 'user' };

export interface EngineAdapter {
  send(text: string, skills?: string[], steer?: boolean): void;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model?: ModelName, effort?: Effort): Promise<void>;
  resolveApproval(approvalId: string, allow: boolean, message?: string, answers?: Answers): void;
  close(): void;
}
