import type { Effort, EngineName, ModelName, PermissionMode } from '../../hub/src/compose.ts';

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error';
export type EventKind = 'user' | 'assistant' | 'tool' | 'tool_result' | 'approval' | 'status' | 'update' | 'question';

export interface Project { id: string; name: string; root_path: string; created_at: string }

export interface HubEvent {
  id: number; session_id: string; task_id: string; ts: string; kind: EventKind;
  payload: Record<string, any>;
}

export interface TaskView {
  id: string; project_id: string; title: string; status: TaskStatus; checkpoint_md: string | null;
  created_by: string; created_at: string; updated_at: string;
  /** The task's number within its project; `@project#seq` names it. */
  seq: number;
  project_name: string; engine: string | null; permission_mode: PermissionMode | null; live: boolean;
  /** Model alias (Claude) or family (Codex) and effort; null: the engine's default. */
  model: ModelName | null; effort: Effort | null;
  /** 'external': a terminal session attached over MCP; the app only answers its questions. */
  source: 'app' | 'external' | null;
  last_event: HubEvent | null; pending_approvals: number; pending_questions: number;
  /** Messages waiting for the running turn to end (#later), oldest first. */
  queued: { id: string; text: string; created_at: string }[];
}

export interface Approval {
  id: string; session_id: string; task_id: string; tool_name: string;
  input: Record<string, any>; status: 'pending' | 'allowed' | 'denied'; created_at: string;
}

/** A question an attached (MCP) agent asked; it waits until answered in the app. */
export interface Question {
  id: string; session_id: string; task_id: string; text: string;
  status: 'pending' | 'answered' | 'cancelled'; answer: string | null; created_at: string; answered_at: string | null;
}

/** Desk-wide defaults for new tasks of each engine; null: the engine's default. */
export type Settings = Record<EngineName, { model: ModelName | null; effort: Effort | null }>;

export type HubMessage =
  | { type: 'event'; event: HubEvent }
  | { type: 'task'; task: TaskView }
  | { type: 'approval'; approval: Approval }
  | { type: 'question'; question: Question }
  | { type: 'runner'; connected: boolean };

/** A timeline post: one utterance, approval request, question, or alert. Tool calls fold into `activity`. */
export type PostKind = 'user' | 'assistant' | 'approval' | 'question' | 'alert';
export interface Post {
  id: number; taskId: string; kind: PostKind; event: HubEvent;
  /** Approval: its decision. Question: the `user` answer or the `question` cancellation. */
  activity: HubEvent[]; resolution?: HubEvent;
  /** The previous post of the same task, i.e. the post this one replies to. */
  parent?: Post;
}

/** A post as placed in a column: whether it connects to the posts drawn above and below it. */
export interface PlacedPost { post: Post; up: boolean; down: boolean }

/** Empty or missing fields mean "no restriction". */
export interface ColumnFilter { taskIds?: string[]; projectIds?: string[]; kinds?: PostKind[]; statuses?: TaskStatus[]; query?: string }
export interface ColumnDef { id: string; title: string; filter: ColumnFilter }

/** A desk skill: skills/<name>/SKILL.md plus optional scripts, shared by Claude and Codex. */
export interface SkillFile { path: string; size: number; executable: boolean }
export interface Skill { name: string; description: string; files: SkillFile[]; updated_at: string; error?: string }
