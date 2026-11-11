// The hub's contract (shared/api.ts) as the web UI uses it, and the UI's own types. Payloads are
// read loosely here: `Record<string, any>` until the reads narrow on shared/events.ts.
import type {
  Approval as WireApproval, DeskState as WireDeskState, HubMessage as WireHubMessage, TaskStatus, TaskView as WireTaskView, WireEvent,
} from '../../shared/api.ts';

export type {
  Channel, ChannelEntry, ChannelEntryPage, ChannelInput, ChannelTokenReceipt, EngineUsage, Project, Question, QueuedKind, Settings, Skill, SkillFile, TaskStatus, UsageWindow,
} from '../../shared/api.ts';
export type { EventKind } from '../../shared/events.ts';

export type HubEvent = WireEvent<Record<string, any>>;
export type Approval = WireApproval<Record<string, any>>;
export type TaskView = WireTaskView<HubEvent>;
export type HubMessage = WireHubMessage<HubEvent, Approval>;
export type DeskState = WireDeskState<HubEvent, Approval> & { unavailableSources?:string[]; availableSources?:string[] };

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
/**
 * `byTask`: one card per task (its newest post) instead of every post. `note`: a built view's
 * column (F2–F4) says what it holds in place of its filter.
 */
export interface ColumnDef { id: string; title: string; filter: ColumnFilter; byTask?: boolean; note?: string; channelId?: string }
