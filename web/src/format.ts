import type { HubEvent, TaskStatus, TaskView } from './types.ts';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  waiting: '승인 대기', running: '실행 중', done: '완료', idle: '대기', error: '오류',
};

/** Like STATUS_LABEL, but a task waiting only on its agent's question reads "답 대기". */
export function statusLabel(t: TaskView): string {
  if (t.status === 'waiting' && t.pending_questions > 0 && !t.pending_approvals) return '답 대기';
  return STATUS_LABEL[t.status];
}

/** An app-run task still "running" with no event for this long is shown as unresponsive. */
export const STALL_MS = 3 * 60_000;

/** Whole minutes since a running app task last said anything, or null if it is not stalled. */
export function stalledMinutes(t: TaskView, nowMs = Date.now()): number | null {
  if (t.source !== 'app' || t.status !== 'running' || !t.last_event) return null;
  const idle = nowMs - Date.parse(t.last_event.ts);
  return idle >= STALL_MS ? Math.floor(idle / 60_000) : null;
}

export function relTime(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** One-line summary of a tool call's input, e.g. the Bash command or the edited file. */
export function toolSummary(name: string, input: Record<string, any> | undefined): string {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  const json = JSON.stringify(input);
  return json.length > 160 ? json.slice(0, 160) + '…' : json;
}

const STATE_LABEL: Record<string, string> = {
  started: '세션 시작', turn_done: '턴 완료', finished: '작업 종료', error: '오류', interrupted: '중단됨', handoff: '터미널 세션 넘겨받음', mkdir: '디렉터리 새로 만듦', closed: '세션 닫음',
};

export function eventSummary(e: HubEvent): string {
  const p = e.payload;
  switch (e.kind) {
    case 'user': return `나: ${p.text}`;
    case 'question': return p.decision === 'cancelled' ? '질문 취소됨' : `질문: ${p.text}`;
    case 'assistant': return p.text;
    case 'tool': return `${p.name} ${toolSummary(p.name, p.input)}`;
    case 'tool_result': return p.isError ? `도구 오류: ${p.text}` : '도구 결과 수신';
    case 'approval': return `${p.toolName} ${p.decision === 'allowed' ? '승인' : '거절'}`;
    case 'status': return STATE_LABEL[p.state] ?? p.state;
    default: return p.text ?? '';
  }
}
