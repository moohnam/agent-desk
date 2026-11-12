// The hub's HTTP and SSE contract with the web UI: what /api/state, /api/feed and the event
// stream carry. Event payloads are a type parameter: the hub keeps them `unknown` until read, the
// web UI reads them loosely.

import type { Effort, EngineName, ModelName, PermissionMode } from './compose.ts';
import type { EventKind } from './events.ts';
import type { BackgroundTask } from './protocol.ts';

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error';

export interface Project { id: string; name: string; root_path: string; created_at: string }

export interface Task {
  id: string; project_id: string; title: string; status: TaskStatus;
  checkpoint_md: string | null; created_by: string; created_at: string; updated_at: string;
  /** The task's number within its project (1, 2, …); `@project#seq` names it. */
  seq: number;
}

export interface WireEvent<P = unknown> { id: number; session_id: string; task_id: string; ts: string; kind: EventKind; payload: P }

export interface Approval<I = unknown> {
  id: string; session_id: string; task_id: string; tool_name: string; input: I;
  status: 'pending' | 'allowed' | 'denied'; created_at: string;
}

/** A question an attached (MCP) agent asked the user; it waits for the answer. */
export interface Question {
  id: string; session_id: string; task_id: string; text: string;
  status: 'pending' | 'answered' | 'cancelled'; answer: string | null; created_at: string; answered_at: string | null;
}

/**
 * A waiting message's kind: 'handoff', the desk's request for a handoff summary, sent as is;
 * 'reset', the first message of a fresh session that replaces this one (컨텍스트 재구성).
 */
export type QueuedKind = 'handoff' | 'reset';

/** Optional queue receipt for the message just sent, absent when it was delivered directly. */
/** `answered`: the message went to the agent as the answer to its waiting question. */
export interface MessageReceipt { queued_id?: string; answered?: boolean }

/** Independent, read-only content; never an agent task or session. */
export interface Channel {
  id: string; name: string; source: 'push' | 'feed'; feed_url: string | null; enabled: boolean;
  created_at: string; updated_at: string; last_checked_at: string | null; last_success_at: string | null;
  last_error: string | null; next_poll_at: string | null;
  /** Shared by every client of this hub; monotonic, in hub receipt order. */
  read_through_id: number; latest_entry_id: number; unread_count: number;
  /** One persistent agent conversation, created only when the user first asks. */
  conversation_task_id?: string | null;
}
export interface ChannelEntry {
  id: number; channel_id: string; external_id: string; title: string; body: string;
  url: string | null; author: string | null; published_at: string | null;
  received_at: string; updated_at: string;
}
export interface ChannelEntryInput {
  external_id: string; title?: string; body: string; url?: string | null;
  author?: string | null; published_at?: string | null;
}
export const CHANNEL_CONTEXT_MAX_ENTRIES = 20;
/** Immutable source snapshots attached to a user message, separate from compose commands. */
export interface ChannelContext { channel_id: string; channel_name: string; entries: ChannelEntry[] }
export interface ChannelMessageInput { text: string; entry_ids?: number[]; project_id?: string }
export interface ChannelInput { name: string; source: 'push' | 'feed'; feed_url?: string; enabled?: boolean }
/** Only create/rotate returns the producer token, once. */
export interface ChannelTokenReceipt { channel: Channel; token: string | null }
export interface ChannelEntryPage { entries: ChannelEntry[]; more: boolean; total: number }
export interface ChannelIngestReceipt { created: number; updated: number; unchanged: number }

export interface TaskView<E = WireEvent> extends Task {
  project_name: string;
  engine: string | null;
  permission_mode: PermissionMode | null;
  /** Model alias (Claude) or family (Codex, agy) and effort; null: the engine's default. */
  model: ModelName | null;
  effort: Effort | null;
  live: boolean;
  runner_id?: string; runner_label?: string; runner_connected?: boolean; delivery_pending?: number;
  /** 'external': a terminal session attached over MCP; the app only answers its questions. */
  source: 'app' | 'external' | null;
  /** The newest event, for its time and kind; its payload is left out (null) to keep the task list light. */
  last_event: E | null;
  pending_approvals: number;
  pending_questions: number;
  /** A Codex async question waiting for my next message, which answers it; null when none. */
  pending_ask: { event_id: number; text: string; ts: string } | null;
  /** Messages waiting for the running turn to end (#later), oldest first. */
  queued: { id: string; text: string; created_at: string; kind?: QueuedKind; channel_entry_count?: number }[];
  /** What the agent left running between turns (subagents, background commands); the session stays open meanwhile. */
  background: BackgroundTask[];
}

/** Desk-wide defaults for new tasks of each engine; null leaves the choice to the engine. */
export type Settings = Record<EngineName, { model: ModelName | null; effort: Effort | null }>;

export type HubMessage<E = WireEvent, A = Approval> =
  | { type: 'event'; event: E }
  | { type: 'task'; task: TaskView<E> }
  | { type: 'approval'; approval: A }
  | { type: 'question'; question: Question }
  | { type: 'runner'; connected: boolean }
  | { type: 'runners'; runners: import('./remote.ts').RemoteRunnerView[] }
  | { type: 'channel'; channel: Channel }
  | { type: 'channel_entry'; entry: ChannelEntry }
  | { type: 'channel_removed'; channel_id: string }
  /** Tasks and projects deleted, with everything recorded for them. */
  | { type: 'removed'; taskIds: string[]; projectIds: string[] }
  /** Devices asking to connect and devices let in; sent to this Mac's own pages only. */
  | ({ type: 'access' } & AccessView);

/** A device without a token asking to connect; `code` shows on both screens to tell requests apart. */
export interface AccessRequest { id: string; name: string; ip: string; code: string; created_at: string }
/** A device let in with a token of its own. `connections`: its open desk pages. */
export interface AccessDevice { id: string; name: string; created_at: string; last_seen_at: string | null; last_ip: string | null; connections: number }
export interface AccessView { requests: AccessRequest[]; devices: AccessDevice[] }

/** GET /api/state. `client.local`: the request came from this machine (no access token needed). */
export interface DeskState<E = WireEvent, A = Approval> {
  projects: Project[]; tasks: TaskView<E>[]; approvals: A[]; questions: Question[];
  channels?: Channel[];
  runner: { connected: boolean }; client?: { local: boolean };
  /** For this Mac's own pages only. */
  access?: AccessView;
}

/** What a feed column shows; empty or missing fields mean no restriction. */
export interface FeedFilter { taskIds?: string[]; projectIds?: string[]; statuses?: string[]; kinds?: string[]; q?: string }

/** A feed filter as /api/feed query parameters: comma lists, and `q` a search. */
export function feedParams(f: FeedFilter): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.taskIds) p.task = f.taskIds.join(',');
  if (f.projectIds) p.project = f.projectIds.join(',');
  if (f.statuses) p.status = f.statuses.join(',');
  if (f.kinds) p.kind = f.kinds.join(',');
  if (f.q) p.q = f.q;
  return p;
}

/** The feed filter in query parameters (feedParams), read through `get`. */
export function parseFeedParams(get: (name: string) => string | null): FeedFilter {
  const list = (name: string) => get(name)?.split(',').filter(Boolean);
  return { taskIds: list('task'), projectIds: list('project'), statuses: list('status'), kinds: list('kind'), q: get('q')?.trim() || undefined };
}

/** A desk skill: skills/<name>/SKILL.md plus optional scripts, which every engine reads. */
export interface SkillFile { path: string; size: number; executable: boolean }
export interface Skill { name: string; description: string; files: SkillFile[]; updated_at: string; error?: string }

export interface UsageWindow { label: string; usedPercent: number | null; resetsAt: string | null }
export interface EngineUsage { engine: EngineName; plan: string | null; windows: UsageWindow[]; error?: string; fetchedAt: string }
