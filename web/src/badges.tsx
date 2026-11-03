import { CircleAlert, LoaderCircle, MessageCircleQuestion, Pause, PenLine } from 'lucide-react';
import { inBackground, stalledMinutes, statusLabel } from './format.ts';
import type { TaskView } from './types.ts';

/** Marks a task holding unsent text in its reply or answer box. */
export function DraftBadge() {
  return <span className="draft-badge" title="보내지 않은 답글이 있습니다 (이 기기에 저장됨)"><PenLine /> 작성 중</span>;
}

const STATUS_ICON = { wait: MessageCircleQuestion, run: LoaderCircle, stall: Pause, draft: PenLine, err: CircleAlert };

export function Chip({ kind, n, label, hint, title, onClick }: {
  kind: keyof typeof STATUS_ICON; n: number; label: string; hint?: string; title: string; onClick: () => void;
}) {
  const Icon = STATUS_ICON[kind];
  return (
    <button className={`chip ${kind}${n ? '' : ' zero'}`} disabled={!n} title={`${label} ${n}개 · ${title}`}
      aria-label={`${label} ${n}개`} aria-keyshortcuts={hint} onClick={onClick}>
      <Icon aria-hidden="true" />{n > 0 && <b aria-hidden="true">{n}</b>}
    </button>
  );
}

/** The status badge, or "응답 없음 N분" for a running app task that has gone quiet. */
export function StatusBadge({ task, now }: { task: TaskView; now: number }) {
  const idle = stalledMinutes(task, now);
  if (idle != null) {
    return <span className="badge stalled" title="실행 중인데 3분 넘게 아무 이벤트가 없습니다.">응답 없음 {idle}분</span>;
  }
  if (inBackground(task)) {
    const bg = task.background!;
    return <span className="badge running" title={`백그라운드에서 일하는 중:\n${bg.map((b) => `· ${b.description}`).join('\n')}`}>
      {bg.some((b) => b.type === 'local_agent') ? '서브 에이전트' : '백그라운드'} {bg.length}</span>;
  }
  return <span className={`badge ${task.status}`}>{statusLabel(task)}</span>;
}

export function TerminalBadge() {
  return <span className="badge term" title="터미널에서 실행 중인 세션이 MCP로 붙었습니다. 앱에서는 질문에만 답할 수 있습니다.">터미널</span>;
}
