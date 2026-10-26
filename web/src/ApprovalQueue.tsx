import { askSummary, isAsk } from './AskCard.tsx';
import { relTime, toolSummary } from './format.ts';
import { projectColor } from './projects.ts';
import type { Approval, Question, TaskView } from './types.ts';

/** Rows shown before "외 N건". */
export const QUEUE_ROWS = 3;

/** Something an agent is blocked on: a tool approval, or a question answered in its thread. */
export type QueueItem =
  | { kind: 'approval'; id: string; task_id: string; created_at: string; approval: Approval }
  | { kind: 'question'; id: string; task_id: string; created_at: string; question: Question };

/** Pending approvals and questions, oldest first. */
export function queueItems(approvals: Iterable<Approval>, questions: Iterable<Question>): QueueItem[] {
  const out: QueueItem[] = [];
  for (const a of approvals) out.push({ kind: 'approval', id: a.id, task_id: a.task_id, created_at: a.created_at, approval: a });
  for (const q of questions) out.push({ kind: 'question', id: q.id, task_id: q.task_id, created_at: q.created_at, question: q });
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Everything waiting on me, pinned above the deck; hidden when there is nothing. */
export function ApprovalQueue({ items, tasks, focus, showAll, onShowAll, onAllow, onDeny, onOpen, onFocus }: {
  items: QueueItem[]; tasks: Map<string, TaskView>; focus: number | null; showAll: boolean;
  onShowAll: (v: boolean) => void; onAllow: (a: Approval) => void; onDeny: (a: Approval) => void;
  onOpen: (item: QueueItem) => void; onFocus: (i: number) => void;
}) {
  if (!items.length) return null;
  const rows = showAll ? items : items.slice(0, QUEUE_ROWS);
  const rest = items.length - rows.length;
  const cur = focus != null ? items[focus] : undefined;
  return (
    <section className={`queue${focus != null ? ' focused' : ''}`} aria-label="응답 대기">
      <header className="queue-head">
        <b>응답 대기 {items.length}</b>
        <span className="muted">{focus == null ? 'a 키로 대기열 선택'
          : cur?.kind === 'question' || (cur && isAsk(cur.approval.tool_name)) ? 'j/k 이동 · Enter 스레드에서 답하기 · Esc 나가기'
          : 'j/k 이동 · y 승인 · n 거절 · Enter 스레드 · Esc 나가기'}</span>
      </header>
      {rows.map((item, i) => {
        const task = tasks.get(item.task_id);
        const engine = task?.engine ?? 'claude';
        return (
          <div key={item.id} className={`queue-row ${item.kind}${focus === i ? ' selected' : ''}`} onClick={() => onFocus(i)}
            onDoubleClick={() => onOpen(item)}>
            <span className={`av mini ${engine}`}>{engine === 'codex' ? 'Cx' : 'C'}</span>
            <span className="where" title={task?.title}>
              <span className="pdot" style={{ background: projectColor(task?.project_id ?? '') }} />
              <b>{task?.project_name ?? '?'}</b><span className="ttl">› {task?.title ?? ''}</span>
            </span>
            {item.kind === 'approval' && isAsk(item.approval.tool_name) ? (
              <span className="tool" title={askSummary(item.approval.input)}><span className="qtag">질문</span> {askSummary(item.approval.input)}</span>
            ) : item.kind === 'approval' ? (
              <span className="tool"><b>{item.approval.tool_name}</b> <span className="mono">{toolSummary(item.approval.tool_name, item.approval.input)}</span></span>
            ) : (
              <span className="tool" title={item.question.text}><span className="qtag">질문</span> {item.question.text}</span>
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
              <button className="icon-btn" title="스레드 (Enter)" onClick={(e) => { e.stopPropagation(); onOpen(item); }}>↗</button>
            </span>
          </div>
        );
      })}
      {(rest > 0 || (showAll && items.length > QUEUE_ROWS)) && (
        <button className="link queue-more" onClick={() => onShowAll(!showAll)}>
          {showAll ? '접기' : `외 ${rest}건 ▾`}
        </button>
      )}
    </section>
  );
}
