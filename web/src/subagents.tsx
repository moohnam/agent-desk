// The thread task's subagents and background commands (hub subagents.ts): loaded when a thread
// opens and kept current from the stream; how each is named and summed up; the chips under the post
// that started them. A subagent's conversation loads when its column shows (SubagentPanel.tsx).

import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Subagent } from '../../shared/api.ts';
import type { BackgroundTask } from '../../shared/protocol.ts';
import { api } from './api.ts';
import { mergeTaskEvents } from './posts.ts';
import type { HubEvent, HubMessage } from './types.ts';
import './subagent-panel.css';

export type { Subagent };
type SubagentMessage = Extract<HubMessage, { type: 'subagent' | 'subagent_event' }>;
const listeners = new Set<(m: SubagentMessage) => void>();
/** useHub hands the stream's subagent messages here. */
export function reportSubagent(m: SubagentMessage) { listeners.forEach(fn => fn(m)); }
function onSubagent(fn: (m: SubagentMessage) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** A subagent's key within a task: engines number them per session. */
export const subagentKey = (s: Pick<Subagent, 'session_id' | 'id'>) => `${s.session_id}/${s.id}`;
export const isActive = (s: Subagent) => s.status === 'running';

/** The task's subagents, oldest first. `reload`: load again (after a reconnect), keeping what is shown meanwhile. */
export function useSubagents(taskId: string | null, reload = 0): Subagent[] {
  const [list, setList] = useState<Subagent[]>([]);
  useEffect(() => setList([]), [taskId]);
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    const early: Subagent[] = [];
    let loaded = false;
    const apply = (prev: Subagent[], s: Subagent) => {
      const at = prev.findIndex(x => subagentKey(x) === subagentKey(s));
      if (at < 0) return [...prev, s];
      if (prev[at].updated_at > s.updated_at) return prev;
      const next = [...prev];
      next[at] = s;
      return next;
    };
    const off = onSubagent(m => {
      if (m.type !== 'subagent' || m.subagent.task_id !== taskId) return;
      if (loaded) setList(prev => apply(prev, m.subagent));
      else early.push(m.subagent);
    });
    api.subagents(taskId).then(items => {
      loaded = true;
      if (live) setList(early.reduce(apply, items));
    }, () => {
      loaded = true;
      if (live) setList(prev => early.reduce(apply, prev));
    });
    return () => { live = false; off(); };
  }, [taskId, reload]);
  return list;
}

/**
 * A subagent's conversation as thread events, oldest first; `more`: older steps exist. Live steps
 * come cut like a thread's; `whole()` loads the newest page again with them whole.
 */
export function useSubagentEvents(s: Subagent | undefined, reload = 0, history?: {taskId:string; members:Subagent[]}) {
  const empty = { events: [] as HubEvent[], more: false, loading: true, error: undefined as string | undefined };
  const [state, setState] = useState(empty);
  const control = useRef<{ load: (older?: boolean) => Promise<void> } | undefined>(undefined);
  const membership = history?.members.map(subagentKey).sort().join('|');
  const key = history ? `${history.taskId}/history/${membership}` : s && `${s.task_id}/${subagentKey(s)}`;
  useEffect(() => {
    setState(empty);
    if (!s && !history) { control.current = undefined; return; }
    let live = true, busy = false, again = false, initialized = false;
    let oldest: number | undefined, newest: number | undefined;
    const load = async (older = false) => {
      if (busy) { if (!older) again = true; return; }
      busy = true;
      setState(prev => ({ ...prev, loading: true, error: undefined }));
      try {
        let before = older ? oldest : undefined;
        const boundary = newest ?? (initialized ? 0 : undefined);
        let receivedNewest = newest;
        do {
          const page = history ? await api.subagentHistory(history.taskId, before) : await api.subagentEvents(s!, before);
          if (!live) return;
          const first = page.events[0]?.id;
          const last = page.events.at(-1)?.id;
          const ownsHistory = older || !initialized || newest === undefined;
          if (ownsHistory) oldest = first ?? oldest;
          if (last != null) receivedNewest = Math.max(receivedNewest ?? last, last);
          setState(prev => ({ ...prev, events: mergeTaskEvents(prev.events, page.events),
            more: ownsHistory ? page.more : prev.more }));
          initialized = true;
          // Reconnect may span several pages. Fill down to the last server record, not a live SSE ID.
          if (older || boundary === undefined || !page.more || first === undefined || first <= boundary) break;
          if (before !== undefined && first >= before) throw new Error('기록 페이지 커서가 진행하지 않았습니다');
          before = first;
        } while (live);
        newest = receivedNewest;
      } catch (e) { if (live) setState(prev => ({ ...prev, error: e instanceof Error ? e.message : String(e) })); }
      finally {
        busy = false;
        if (live) {
          setState(prev => ({ ...prev, loading: false }));
          if (again) { again = false; void load(); }
        }
      }
    };
    control.current = { load };
    const off = onSubagent(m => {
      if (m.type !== 'subagent_event') return;
      if (history ? m.event.task_id !== history.taskId || !history.members.some(a=>a.session_id===m.event.session_id&&a.id===m.event.subagent_id)
        : m.event.task_id !== s!.task_id || m.event.session_id !== s!.session_id || m.event.subagent_id !== s!.id) return;
      setState(prev => ({ ...prev, events: mergeTaskEvents(prev.events, [m.event as HubEvent]) }));
    });
    return () => { live = false; off(); control.current = undefined; };
  }, [key]);
  useEffect(() => { void control.current?.load(); }, [key, reload]);
  return { ...state, older: () => state.more ? control.current?.load(true) : undefined, whole: () => control.current?.load() };
}

const STATUS: Record<Subagent['status'], string> = {
  running: '실행 중', completed: '완료', failed: '실패', stopped: '중지됨', ended: '종료', unknown: '상태 미확인',
};
export const statusText = (s: Subagent) => STATUS[s.status];
/** The class for its colored dot. */
export const subagentTone = (s: Subagent) =>
  s.status === 'running' ? 'running' : s.status === 'failed' ? 'error' : s.status === 'completed' ? 'done' : 'stopped';

/** What it is: a subagent (and its type), or a background command. */
export function subagentKind(s: Subagent): string {
  if (s.type === 'local_bash' || s.type === 'shell') return '명령';
  return s.agent ?? (s.type === 'local_agent' || s.type === 'agent' ? '서브 에이전트' : s.type);
}
/** A command record; only engine-confirmed active background commands appear in the pane. */
export const isCommand = (s: Subagent) => subagentKind(s) === '명령';
export const isCurrentCommand = (s: Subagent) => isCommand(s) && isActive(s) && s.background !== false
  && (s.backgroundEvidence === 'native' || s.detailed && s.background === true);
/** History stays available for agents; completed or unproven commands have no pane target. */
export const hasSubagentPaneTarget = (s: Subagent) => !isCommand(s) || isCurrentCommand(s);
/** A runner snapshot also contains foreground guards and status placeholders. */
export const backgroundRunningCount = (items: BackgroundTask[] = []) => items.filter(s => s.type !== 'tool' && s.type !== 'status'
  && (!['shell', 'local_bash'].includes(s.type) || s.backgroundEvidence === 'native')).length;
export function subagentTitle(s: Subagent): string {
  const kind = subagentKind(s);
  return kind === '명령' ? `명령: ${s.description}` : s.description || kind;
}

/** "4분 12초": how long it ran, or has run so far. */
export function elapsed(s: Subagent, nowMs = Date.now()): string {
  const ms = s.usage?.durationMs ?? ((s.status === 'running' ? nowMs : Date.parse(s.updated_at)) - Date.parse(s.created_at));
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}분 ${sec % 60}초` : `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

/** One line about it: kind · status · time · tool calls · tokens. */
export function subagentMeta(s: Subagent, nowMs = Date.now()): string {
  const t = s.usage?.tokens ?? 0;
  return [subagentKind(s), STATUS[s.status], elapsed(s, nowMs), s.usage?.toolUses ? `도구 ${s.usage.toolUses}회` : '',
    t ? `${t >= 1000 ? `${Math.round(t / 1000)}k` : t} 토큰` : ''].filter(Boolean).join(' · ');
}

/** Under the post whose tool call started them: each opens in the subagent pane. */
export function SubagentChips({ items, onOpen }: { items: Subagent[]; onOpen?: (s: Subagent) => void }) {
  return (
    <div className="sa-chips">
      {items.map(s => (
        <button key={subagentKey(s)} type="button" className={`sa-chip ${subagentTone(s)}`}
          title="서브 에이전트 창에서 이 항목 보기" onClick={(e) => { e.stopPropagation(); onOpen?.(s); }}>
          <span className="sa-dot" /><b>{subagentTitle(s)}</b>
          <span className="sa-meta">{subagentMeta(s)}</span>
          <span className="sa-open">창에서 보기<ChevronRight size={12} aria-hidden /></span>
        </button>
      ))}
    </div>
  );
}
