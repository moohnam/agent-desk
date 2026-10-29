import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ENGINE_LABEL, MODE_LABEL, MODEL_LABEL, engineOf } from '../../shared/compose.ts';
import { extractHandoff, handoffMessage, HANDOFF_SECTIONS, quoteEvent, type Quoted } from '../../shared/handoff.ts';
import { api } from './api.ts';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';
import { modelShort } from './projects.ts';
import type { HubEvent, TaskView } from './types.ts';

/**
 * 컨텍스트 재구성, per task: pick thread posts, have the agent write a handoff summary that keeps their
 * key facts (or write it by hand), revise it, check the whole first message, and continue the task in
 * a fresh engine session (shared/handoff.ts). Kept as a draft on this device (`handoff:<taskId>`), so
 * closing the panel or reloading loses nothing.
 */
export interface HandoffState {
  /** The panel shows (instead of the reply box), and the thread's posts get checkboxes. */
  open: boolean;
  stage: 'pick' | 'edit' | 'confirm';
  /** Event ids of the picked posts. */
  picked: number[];
  summary: string;
  feedback: string;
  /** Add the picked posts' text under the summary. */
  appendix: boolean;
  next: string;
  /** The first message as edited at the confirm step; null: composed from the parts above. */
  final: string | null;
  /** Waiting for the agent's summary in reply to a request made after this event id. */
  after: number | null;
}

const key = (taskId: string) => `handoff:${taskId}`;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getHandoff = (taskId: string) => getDraft<HandoffState>(key(taskId));

export function setHandoff(taskId: string, s: HandoffState | null) {
  setDraft(key(taskId), s, { taskId, empty: !s });
  emit();
}

export function updateHandoff(taskId: string, patch: Partial<HandoffState>) {
  const s = getHandoff(taskId);
  if (s) setHandoff(taskId, { ...s, ...patch });
}

/** Opens the panel (starting over if there was none), or closes it keeping what was written. */
export function toggleHandoff(taskId: string) {
  const s = getHandoff(taskId);
  setHandoff(taskId, s ? { ...s, open: !s.open }
    : { open: true, stage: 'pick', picked: [], summary: '', feedback: '', appendix: false, next: '', final: null, after: null });
}

export function togglePick(taskId: string, eventId: number) {
  const s = getHandoff(taskId);
  if (!s) return;
  setHandoff(taskId, { ...s, picked: s.picked.includes(eventId) ? s.picked.filter((x) => x !== eventId) : [...s.picked, eventId].sort((a, b) => a - b) });
}

/** Posts that can be picked: what I said and what the agent answered. */
export const pickable = (e: HubEvent) => quoteEvent(e) !== null;

/** The task's handoff state, kept in step with this window and the others. */
export function useHandoff(taskId: string | null): HandoffState | undefined {
  useDraftSync(taskId ? key(taskId) : '', emit);
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); },
    () => (taskId ? getHandoff(taskId) : undefined));
}

const busy = (t: TaskView) => t.status === 'running' || t.status === 'waiting';
const TEMPLATE = HANDOFF_SECTIONS.map((s) => `## ${s}\n`).join('\n');

export function HandoffPanel({ task, state: s, model, events, onError, onDone }: {
  task: TaskView; state: HandoffState; model: string | undefined;
  /** The thread's events: the agent's summary is picked up from them. */
  events: HubEvent[];
  onError: (msg: string) => void;
  onDone: (msg: string) => void;
}) {
  const up = (patch: Partial<HandoffState>) => updateHandoff(task.id, patch);
  const [sending, setSending] = useState(false);
  const running = busy(task);
  const queuedRequest = (task.queued ?? []).some((q) => q.kind === 'handoff');
  const queuedReset = (task.queued ?? []).some((q) => q.kind === 'reset');

  // The agent's reply to the latest request: its summary between the markers, once the turn is over.
  const req = s.after == null ? undefined
    : [...events].reverse().find((e) => e.id > s.after! && e.kind === 'user' && e.payload.handoff === 'request');
  const replies = req ? events.filter((e) => e.id > req.id && e.kind === 'assistant' && typeof e.payload.text === 'string') : [];
  const found = replies.map((e) => extractHandoff(e.payload.text)).filter((x): x is string => !!x).at(-1) ?? null;
  const settled = !!req && !running && !queuedRequest;
  useEffect(() => {
    if (settled && found != null) up({ summary: found, stage: 'edit', after: null, feedback: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, found]);
  const waiting = s.after != null && !(settled && found != null);
  const unmarked = settled && found == null && replies.length > 0;

  const request = async (a: { picked?: number[]; feedback?: string; current?: string }) => {
    const after = events.reduce((m, e) => Math.max(m, e.id), 0);
    setSending(true);
    try {
      await api.requestHandoff(task.id, a);
      up({ after, ...(a.feedback ? {} : { stage: 'edit' as const }) });
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  };

  // The picked posts' whole text for the appendix (the thread may hold them clipped or not at all).
  const [quotes, setQuotes] = useState<{ ids: string; posts: Quoted[] } | null>(null);
  const ids = s.picked.join(',');
  useEffect(() => {
    if (s.stage !== 'confirm' || !s.appendix || !s.picked.length || quotes?.ids === ids) return;
    let live = true;
    api.events(task.id, { ids: s.picked })
      .then((r) => { if (live) setQuotes({ ids, posts: r.events.sort((a, b) => a.id - b.id).map(quoteEvent).filter((q): q is Quoted => !!q) }); })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.stage, s.appendix, ids, task.id]);
  const appendixReady = s.final != null || !s.appendix || !s.picked.length || quotes?.ids === ids;
  const composed = handoffMessage(s.summary, s.appendix && quotes?.ids === ids ? quotes.posts : [], s.next);
  const final = s.final ?? composed;

  const deliver = async () => {
    if (!final.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.resetContext(task.id, final);
      setHandoff(task.id, null);
      onDone(r.queued ? '지금 턴이 끝나면 새 세션으로 넘깁니다. 대기열에서 취소할 수 있습니다.' : '새 세션에서 정리본으로 이어 갑니다.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  };

  const engine = ENGINE_LABEL[engineOf(task.engine)];
  const steps: [HandoffState['stage'], string][] = [['pick', '글 고르기'], ['edit', '정리본'], ['confirm', '최종 확인']];

  return (
    <div className="reply-box handoff">
      <div className="handoff-head">
        <b>컨텍스트 재구성</b>
        <ol className="steps">
          {steps.map(([k, label], i) => <li key={k} aria-current={s.stage === k ? 'step' : undefined}>{i + 1}. {label}</li>)}
        </ol>
        <span className="spacer" />
        <button className="link" title="쓴 내용과 고른 글을 버리고 끝내기" onClick={() => setHandoff(task.id, null)}>그만두기</button>
        <button className="icon-btn" title="패널 닫기 (X) · 쓴 내용은 남습니다" aria-label="패널 닫기" onClick={() => up({ open: false })}><X /></button>
      </div>

      {queuedReset && <div className="reply-note">이미 대기 중인 재구성이 있습니다. 지금 턴이 끝나면 새 세션으로 넘깁니다.</div>}
      {waiting && (
        <div className="reply-note">
          {queuedRequest ? '지금 턴이 끝나면 정리본을 요청합니다.' : '에이전트가 정리본을 쓰는 중입니다. 턴이 끝나면 아래에 채웁니다.'}
          {' '}<button className="link" onClick={() => up({ after: null })}>기다리지 않기</button>
        </div>
      )}
      {unmarked && (
        <div className="reply-note warn">
          답에서 정리본 시작·끝 표시를 찾지 못했습니다.{' '}
          <button className="link" onClick={() => up({ summary: replies.at(-1)!.payload.text, stage: 'edit', after: null })}>마지막 답 그대로 쓰기</button>
          {' · '}<button className="link" onClick={() => up({ after: null })}>무시</button>
        </div>
      )}

      {s.stage === 'pick' && (<>
        <p className="handoff-help">
          스레드에서 글을 체크하면(<kbd>x</kbd>) 정리본에 그 글의 핵심 정보를 빠짐없이 담게 합니다. 고르지 않으면 전체 대화만 요약합니다.
          지금 세션의 에이전트가 정리본을 쓰고, 요청과 답은 스레드에 남습니다.
        </p>
        <div className="reply-tools">
          <span>고른 글 {s.picked.length}개</span>
          {s.picked.length > 0 && <button className="link" onClick={() => up({ picked: [] })}>모두 해제</button>}
          <span className="spacer" />
          <button className="btn" title="에이전트에게 묻지 않고 형식만 채워 직접 쓰기"
            onClick={() => up({ stage: 'edit', summary: s.summary || TEMPLATE })}>직접 쓰기</button>
          <button className="btn primary" disabled={sending || waiting} onClick={() => void request({ picked: s.picked })}>
            {running ? '정리본 요청 (턴 끝난 뒤)' : '정리본 만들기'}</button>
        </div>
      </>)}

      {s.stage === 'edit' && (<>
        <textarea className="input handoff-text" rows={12} value={s.summary} readOnly={waiting}
          placeholder={waiting ? '정리본을 기다리는 중…' : '정리본'} onChange={(e) => up({ summary: e.target.value })} />
        <div className="handoff-feedback">
          <input className="input" value={s.feedback} placeholder="에이전트에게 고칠 점 말하기 (예: 실패한 시도와 원인도 넣어 주세요)"
            onChange={(e) => up({ feedback: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && s.feedback.trim() && s.summary.trim() && !waiting) { e.preventDefault(); void request({ feedback: s.feedback, current: s.summary }); } }} />
          <button className="btn" disabled={sending || waiting || !s.feedback.trim() || !s.summary.trim()}
            onClick={() => void request({ feedback: s.feedback, current: s.summary })}>수정 요청</button>
        </div>
        <div className="reply-tools">
          <button className="link" onClick={() => up({ stage: 'pick' })}>← 글 고르기</button>
          <button className="link" disabled={sending || waiting} title="고른 글로 처음부터 다시 요청"
            onClick={() => void request({ picked: s.picked })}>다시 만들기</button>
          <span className="spacer" />
          <button className="btn primary" disabled={waiting || !s.summary.trim()} onClick={() => up({ stage: 'confirm' })}>다음: 최종 확인</button>
        </div>
      </>)}

      {s.stage === 'confirm' && (<>
        <div className="handoff-opts">
          <label><input type="checkbox" checked={s.appendix} disabled={!s.picked.length}
            onChange={(e) => up({ appendix: e.target.checked })} /> 부록: 고른 글 원문 넣기 ({s.picked.length}개)</label>
          <input className="input" value={s.next} placeholder="이어서 할 일 (비워도 됨)" onChange={(e) => up({ next: e.target.value })} />
        </div>
        {s.final != null && s.final !== composed && (
          <div className="reply-note warn">아래 메시지를 직접 고쳤습니다. 위 항목을 바꿔도 반영되지 않습니다.{' '}
            <button className="link" onClick={() => up({ final: null })}>다시 구성</button></div>
        )}
        <textarea className="input handoff-text" rows={12} value={appendixReady ? final : '원문을 불러오는 중…'} readOnly={!appendixReady}
          onChange={(e) => up({ final: e.target.value })} />
        <div className="reply-note">
          새 세션: {engine}{model ? ` · ${modelShort(model)}` : ''}{task.model && !new RegExp(`-${task.model}(-|$)`).test(model ?? '') ? ` → ${MODEL_LABEL[task.model]}` : ''}
          {task.effort ? ` · effort ${task.effort}` : ''}{task.permission_mode ? ` · ${MODE_LABEL[task.permission_mode]}` : ''}
          {' · '}{running ? '지금 턴이 끝나면 넘깁니다.' : '지금 세션을 닫고 이 메시지로 새 세션을 시작합니다.'} 이전 대화는 스레드에 남지만 에이전트는 기억하지 않습니다.
        </div>
        <div className="reply-tools">
          <button className="link" onClick={() => up({ stage: 'edit' })}>← 정리본</button>
          <span className="spacer" />
          <button className="btn primary" disabled={sending || !appendixReady || !final.trim()} onClick={() => void deliver()}>
            {running ? '전달 (턴 끝난 뒤)' : '전달'}</button>
        </div>
      </>)}
    </div>
  );
}
