import { ArrowUpRight, ChevronDown, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { ENGINE_SHORT, REQUEST_TOOL, engineOf } from '../../shared/compose.ts';
import { askSummary, isAsk } from './AskCard.tsx';
import { relTime, toolSummary } from './format.ts';
import { projectColor } from './projects.ts';
import type { Approval, Question, TaskView } from './types.ts';

/** Rows shown before "외 N건". */
export const QUEUE_ROWS = 3;

/** Something an agent is blocked on: a tool approval, or a question answered in its thread. */
export type QueueItem =
  | { kind: 'approval'; id: string; task_id: string; created_at: string; approval: Approval }
  | { kind: 'question'; id: string; task_id: string; created_at: string; question: Question }
  /** A Codex async question: its turn goes on, and my next message in the thread answers it. */
  | { kind: 'ask'; id: string; task_id: string; created_at: string; text: string };

/** Pending approvals and questions, Codex's async ones included, oldest first. */
export function queueItems(approvals: Iterable<Approval>, questions: Iterable<Question>, tasks: Iterable<TaskView> = []): QueueItem[] {
  const out: QueueItem[] = [];
  for (const t of tasks) {
    const q = t.pending_ask;
    if (q) out.push({ kind: 'ask', id: `ask:${q.event_id}`, task_id: t.id, created_at: q.ts, text: q.text });
  }
  for (const a of approvals) out.push({ kind: 'approval', id: a.id, task_id: a.task_id, created_at: a.created_at, approval: a });
  for (const q of questions) out.push({ kind: 'question', id: q.id, task_id: q.task_id, created_at: q.created_at, question: q });
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** A compact bottom-left launcher opens the pending responses without resizing the deck. */
export function ApprovalQueue({ items, tasks, focus, showAll, onShowAll, onAllow, onDeny, onOpen, onFocus }: {
  items: QueueItem[]; tasks: Map<string, TaskView>; focus: number | null; showAll: boolean;
  onShowAll: (v: boolean) => void; onAllow: (a: Approval) => void; onDeny: (a: Approval) => void;
  onOpen: (item: QueueItem) => void; onFocus: (i: number | null) => void;
}) {
  const panelId = useId();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = focus != null ? list.current?.querySelector<HTMLElement>(`[data-queue-index="${focus}"]`) : null;
    if (row && !document.activeElement?.closest('[role="dialog"]')) {
      if (!row.contains(document.activeElement)) row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [focus, showAll, items.length]);
  if (!items.length) return null;
  const rows = showAll ? items : items.slice(0, QUEUE_ROWS);
  const rest = items.length - rows.length;
  const cur = focus != null ? items[focus] : undefined;
  return (
    <aside className="queue-dock" aria-label="응답 대기"
      onKeyDown={(e) => {
        // Let native button activation reach the button, rather than the deck's Enter/Space keys.
        if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('button')) e.stopPropagation();
      }}>
      {focus != null && <section id={panelId} className="queue focused" aria-label="승인·질문 목록">
      <header className="queue-head">
        <MessageCircleQuestion aria-hidden="true" /><b>응답 대기</b><span className="count">{items.length}</span>
        <span className="spacer" />
        <button className="icon-btn" aria-label="응답 대기 접기" title="접기 (Esc)" onClick={() => onFocus(null)}><ChevronDown /></button>
      </header>
      <div className="queue-list" ref={list}>
      {rows.map((item, i) => {
        const task = tasks.get(item.task_id);
        const engine = task?.engine ?? 'claude';
        return (
          <div key={item.id} data-queue-index={i} tabIndex={0}
            className={`queue-row ${item.kind}${focus === i ? ' selected' : ''}`} onClick={() => onFocus(i)} onFocus={() => onFocus(i)}
            onDoubleClick={() => onOpen(item)}>
            <span className={`av mini ${engine}`}>{ENGINE_SHORT[engineOf(engine)]}</span>
            <span className="where" title={task?.title}>
              <span className="pdot" style={{ background: projectColor(task?.project_id ?? '') }} />
              <b>{task?.project_name ?? '?'}</b><span className="ttl">› {task?.title ?? ''}</span>
            </span>
            {item.kind === 'approval' && isAsk(item.approval.tool_name) ? (
              <span className="tool" title={askSummary(item.approval.input)}><span className="qtag">질문</span> {askSummary(item.approval.input)}</span>
            ) : item.kind === 'approval' ? (
              item.approval.tool_name === REQUEST_TOOL ? (
                <span className="tool" title={String((item.approval.input as { description?: string }).description ?? '')}>
                  <span className="qtag">{String((item.approval.input as { to?: string }).to ?? '')}에게</span> {String((item.approval.input as { description?: string }).description ?? '')}</span>
              ) : <span className="tool"><b>{item.approval.tool_name}</b> <span className="mono">{toolSummary(item.approval.tool_name, item.approval.input)}</span></span>
            ) : (
              <span className="tool" title={item.kind === 'ask' ? item.text : item.question.text}>
                <span className="qtag">질문</span> {(item.kind === 'ask' ? item.text : item.question.text).split('\n')[0]}</span>
            )}
            <time dateTime={item.created_at}>{relTime(item.created_at)}</time>
            <span className="acts">
              {item.kind === 'approval' && !isAsk(item.approval.tool_name) ? (
                <>
                  <button className="yes" title="승인 (y)" onClick={(e) => { e.stopPropagation(); onAllow(item.approval); }}>승인</button>
                  <button className="no" title="거절 (n)" onClick={(e) => { e.stopPropagation(); onDeny(item.approval); }}>거절</button>
                </>
              ) : (
                <button className="yes" title="스레드에서 답하기 (Enter)" onClick={(e) => { e.stopPropagation(); onOpen(item); }}>답하기</button>
              )}
              <button className="icon-btn" title="스레드 (Enter)" onClick={(e) => { e.stopPropagation(); onOpen(item); }} aria-label="스레드 열기"><ArrowUpRight /></button>
            </span>
          </div>
        );
      })}
      </div>
      {(rest > 0 || (showAll && items.length > QUEUE_ROWS)) && (
        <button className="link queue-more" onClick={() => onShowAll(!showAll)}>
          {showAll ? '접기' : <>외 {rest}건 <ChevronDown /></>}
        </button>
      )}
      <p className="queue-hint">{cur?.kind === 'question' || cur?.kind === 'ask' || (cur?.kind === 'approval' && isAsk(cur.approval.tool_name))
        ? 'j/k 이동 · Enter 스레드에서 답하기 · Esc 접기'
        : 'j/k 이동 · y 승인 · n 거절 · Enter 스레드 · Esc 접기'}</p>
      </section>}
      <button className="queue-launcher" aria-expanded={focus != null} aria-controls={focus != null ? panelId : undefined}
        title="승인·질문 목록 열기 / 접기 (a)" onClick={() => onFocus(focus == null ? 0 : null)}>
        <MessageCircleQuestion aria-hidden="true" /><span>응답 대기</span><b>{items.length}</b>
      </button>
    </aside>
  );
}
