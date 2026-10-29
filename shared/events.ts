// What the hub records per task and the web UI reads back: event kinds, status states and the
// payload of each kind. The hub types what it records with these (Hub.addEvent); the web UI still
// reads payloads loosely (web/src/types.ts HubEvent).

import type { Delivery, PermissionMode } from './compose.ts';
import type { Answers, AsyncQuestion, RunnerEvent } from './protocol.ts';

export type EventKind = 'user' | 'assistant' | 'tool' | 'tool_result' | 'approval' | 'status' | 'update' | 'question';

/** Status states an engine reports through the runner (RunnerEvent). */
export type RunnerStatusState = 'started' | 'model_changed' | 'turn_done' | 'warning' | 'error' | 'interrupted';
/**
 * Every status state in the log: the engine's, and the ones the hub records itself (a new project
 * directory, a model or mode switch, dropped queue, fork, context reset, session end or takeover).
 */
export type StatusState = RunnerStatusState
  | 'mkdir' | 'model' | 'mode' | 'queue_dropped' | 'forked' | 'context_reset' | 'closed' | 'finished' | 'handoff';

/**
 * The status states that make a post of their own (an alert). Every other status event folds into
 * the post before it. The hub's feed count (db.ts) and the web timeline (posts.ts) both use this.
 */
export const ALERT_STATES: readonly StatusState[] = ['warning', 'error', 'interrupted', 'queue_dropped'];

export interface StatusPayload { kind: 'status'; state: StatusState; detail?: Record<string, unknown> }

export interface UserPayload {
  text: string;
  mode?: PermissionMode;
  skills?: string[];
  delivery?: Delivery;
  /** When the message was queued (#later), for one sent once the turn ended. */
  queued_at?: string;
  /** The desk's request for a handoff summary, or the first message of the session replacing this one. */
  handoff?: 'request' | 'reset';
  /** Another task's agent asking through the desk (desk_request). */
  request?: { id: string; task_id: string; from: string; title: string };
  forked_from?: { task_id: string; title: string; seq: number };
  /** The id of the MCP question this message answers. */
  answers?: string;
}

export interface AssistantPayload {
  kind?: 'assistant';
  text: string;
  /** Posted by an attached terminal session (desk_post, desk_checkpoint…), or the takeover note. */
  via?: 'mcp' | 'handoff';
  checkpoint?: boolean;
  /** Codex async questions; the user's next message answers them. */
  questions?: AsyncQuestion[];
}

export interface ApprovalPayload {
  approvalId: string;
  toolName: string;
  input?: unknown;
  decision: 'pending' | 'allowed' | 'denied' | 'cancelled';
  message?: string;
  answers?: Answers;
}

export interface QuestionPayload { questionId: string; text: string; decision: 'pending' | 'cancelled' }

export interface EventPayloads {
  user: UserPayload;
  assistant: AssistantPayload;
  tool: Extract<RunnerEvent, { kind: 'tool' }>;
  tool_result: Extract<RunnerEvent, { kind: 'tool_result' }>;
  approval: ApprovalPayload;
  question: QuestionPayload;
  status: StatusPayload;
  /** Older hubs' progress notes; nothing records them now. */
  update: { text: string };
}
