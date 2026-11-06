import { feedParams, type FeedFilter } from '../../shared/api.ts';
import type { AccessView, ChannelMessageInput, MessageReceipt } from '../../shared/api.ts';
import type { Channel, ChannelEntryPage, ChannelInput, ChannelTokenReceipt, DeskState, EngineUsage, HubEvent, Project, Settings, Skill, TaskView } from './types.ts';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** A feed column's filter as the hub applies it (see feedQuery in useHub.ts); `members` stays on the client. */
export interface FeedQuery extends FeedFilter { members?: string[] }

const feedSearch = (q: FeedQuery) => new URLSearchParams(feedParams(q));

/** Events per feed page: a full page means older ones may exist. */
export const FEED_PAGE = 1000;

export const api = {
  channels: () => call<Channel[]>('GET', '/channels'),
  createChannel: (input: ChannelInput) => call<ChannelTokenReceipt>('POST', '/channels', input),
  updateChannel: (id: string, input: Partial<Pick<ChannelInput, 'name' | 'feed_url' | 'enabled'>>) => call<Channel>('PATCH', `/channels/${encodeURIComponent(id)}`, input),
  deleteChannel: (id: string) => call('DELETE', `/channels/${encodeURIComponent(id)}`),
  rotateChannelToken: (id: string) => call<ChannelTokenReceipt>('POST', `/channels/${encodeURIComponent(id)}/token`),
  refreshChannel: (id: string) => call<Channel>('POST', `/channels/${encodeURIComponent(id)}/refresh`),
  readChannel: (id: string, through_id: number) => call<Channel>('POST', `/channels/${encodeURIComponent(id)}/read`, { through_id }),
  sendChannel: (id: string, input: ChannelMessageInput) => call<{ task: TaskView } & MessageReceipt>('POST', `/channels/${encodeURIComponent(id)}/messages`, input),
  channelEntries: (id: string, at: { before?: number; q?: string } = {}) => {
    const query = new URLSearchParams({ limit: '100' });
    if (at.before != null) query.set('before', String(at.before));
    if (at.q?.trim()) query.set('q', at.q.trim());
    return call<ChannelEntryPage>('GET', `/channels/${encodeURIComponent(id)}/entries?${query}`);
  },
  state: () => call<DeskState>('GET', '/state'),
  /**
   * The newest `limit` events, oldest first; `before`: those before that event id; `q`: only those a
   * column shows. Tool calls and results come cut (`clipped`); a task's own events are whole.
   */
  feed: (limit = FEED_PAGE, before?: number, q: FeedQuery = {}) => {
    const p = feedSearch(q);
    p.set('limit', String(limit));
    if (before) p.set('before', String(before));
    return call<HubEvent[]>('GET', `/feed?${p}`);
  },
  /** How many posts a column's query has in the hub in all, and in how many tasks (for "loaded / total"). */
  feedCount: (q: FeedQuery) => call<{ posts: number; tasks: number }>('GET', `/feed/count?${feedSearch(q)}`),
  /**
   * A page of a task's history, oldest first: its newest events (below `before`, when given), and
   * every event from `since` on. `more`: older events exist before the page.
   */
  events: (taskId: string, at: { since?: number; before?: number; ids?: number[] } = {}) => {
    const q = new URLSearchParams();
    if (at.ids?.length) q.set('ids', at.ids.join(','));
    if (at.since) q.set('since', String(at.since));
    if (at.before) q.set('before', String(at.before));
    const qs = q.toString();
    // A hub not yet restarted answers with the bare array (newest 500, no paging).
    return call<{ events: HubEvent[]; more: boolean } | HubEvent[]>('GET', `/tasks/${taskId}/events${qs ? `?${qs}` : ''}`)
      .then((r) => (Array.isArray(r) ? { events: r, more: false } : r));
  },
  /** Saves a file on the hub's machine (for a device without it); returns the saved path. */
  upload: async (file: File) => {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as { path: string };
  },
  /** Has the hub download a web file (an image dragged in from a page); returns the saved path. */
  uploadUrl: (url: string) => call<{ path: string }>('POST', '/uploads', { url }),
  createProject: (name: string, root_path: string) => call<Project>('POST', '/projects', { name, root_path }),
  compose: (text: string) => call<TaskView>('POST', '/compose', { text }),
  createTask: (project_id: string, title: string, prompt: string) =>
    call<TaskView>('POST', '/tasks', { project_id, title, prompt }),
  /** Returns the task that got the message: a new one for #new or #fork. */
  send: (taskId: string, text: string) => call<{ task_id: string } & MessageReceipt>('POST', `/tasks/${taskId}/messages`, { text }),
  cancelQueued: (taskId: string, queuedId: string) => call('DELETE', `/tasks/${taskId}/queue/${queuedId}`),
  /** Sends a waiting message at once: into the running turn, like #now. */
  sendQueuedNow: (taskId: string, queuedId: string) => call('POST', `/tasks/${taskId}/queue/${queuedId}/send`),
  /** Moves a waiting message to `index` (0 = sent first). */
  moveQueued: (taskId: string, queuedId: string, index: number) => call('PUT', `/tasks/${taskId}/queue/${queuedId}`, { index }),
  /** Asks the task's agent for a handoff summary of the conversation (컨텍스트 재구성), or to revise `current`. */
  requestHandoff: (taskId: string, a: { picked?: number[]; feedback?: string; current?: string }) =>
    call<{ queued: boolean }>('POST', `/tasks/${taskId}/handoff`, a),
  /** Continues the task in a fresh engine session whose first message is `text`, after the running turn. */
  resetContext: (taskId: string, text: string) => call<{ queued: boolean }>('POST', `/tasks/${taskId}/reset`, { text }),
  interrupt: (taskId: string) => call('POST', `/tasks/${taskId}/interrupt`),
  /** Ends the task's engine process; the next reply resumes the conversation. */
  closeSession: (taskId: string) => call('POST', `/tasks/${taskId}/close`),
  /** Deletes a task for good, or a project with all its tasks; open sessions are closed first. */
  deleteTask: (taskId: string) => call('DELETE', `/tasks/${taskId}`),
  deleteProject: (projectId: string) => call('DELETE', `/projects/${projectId}`),
  /** `answers`: picks for an agent's multiple-choice question, keyed by question text. */
  resolve: (approvalId: string, allow: boolean, message?: string, answers?: Record<string, string>) =>
    call('POST', `/approvals/${approvalId}`, { allow, message, answers }),
  answer: (questionId: string, answer: string) => call('POST', `/questions/${questionId}`, { answer }),
  /** Opens a link from a reply in its local app (via the hub, which may run `open`). */
  open: (href: string, taskId?: string) => call<{ ok: true }>('POST', '/open', { href, task_id: taskId }),
  /** Addresses (with QR codes) other devices open the desk at; only on the hub's own machine. */
  access: () => call<{ urls: { url: string; qr: string }[] } & AccessView>('GET', '/access'),
  answerAccess: (id: string, allow: boolean) => call<AccessView>('POST', `/access-requests/${id}`, { allow }),
  renameDevice: (id: string, name: string) => call<AccessView>('PATCH', `/devices/${id}`, { name }),
  removeDevice: (id: string) => call<AccessView>('DELETE', `/devices/${id}`),
  rotateAccessToken: () => call<{ ok: true }>('POST', '/access-token'),
  settings: () => call<Settings>('GET', '/settings'),
  /** Each engine's plan limits: used share and reset time per window. `refresh`: skip the hub's one-minute cache. */
  usage: (engine: string, refresh = false) => call<EngineUsage>('GET', `/usage?engine=${engine}${refresh ? '&refresh=1' : ''}`),
  /** Only the engines and keys given change; null clears one. */
  saveSettings: (s: { [E in keyof Settings]?: Partial<Settings[E]> }) => call<Settings>('PUT', '/settings', s),
  skills: () => call<Skill[]>('GET', '/skills'),
  createSkill: (name: string, description: string) => call<Skill>('POST', '/skills', { name, description }),
  deleteSkill: (name: string) => call('DELETE', `/skills/${name}`),
  readSkillFile: (name: string, path: string) =>
    call<{ path: string; content: string; executable: boolean }>('GET', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
  writeSkillFile: (name: string, path: string, content: string) =>
    call<Skill>('PUT', `/skills/${name}/file?path=${encodeURIComponent(path)}`, { content }),
  deleteSkillFile: (name: string, path: string) =>
    call<Skill>('DELETE', `/skills/${name}/file?path=${encodeURIComponent(path)}`),
};
