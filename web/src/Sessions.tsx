import { useState } from 'react';
import { X } from 'lucide-react';
import { ENGINE_SHORT, engineOf } from '../../hub/src/compose.ts';
import { api } from './api.ts';
import { Modal } from './Compose.tsx';
import { backgroundCount, relTime, statusLabel } from './format.ts';
import { modelShort, projectColor } from './projects.ts';
import type { TaskView } from './types.ts';

/** Tasks whose engine process the desk's runner keeps open. */
export const openSessions = (tasks: Iterable<TaskView>) => [...tasks].filter((t) => t.live && t.source === 'app');

const lastActive = (t: TaskView) => t.last_event?.ts ?? t.updated_at;
const busy = (t: TaskView) => t.status === 'running' || t.status === 'waiting' || backgroundCount(t) > 0;

/**
 * "열린 세션": the engine processes the desk keeps running, newest activity first, each closable.
 * Closing frees the process only; the history stays and the next reply resumes the conversation.
 * Terminal agents attached over MCP run on their own and are listed without a close button.
 */
export function SessionsDialog({ tasks, onOpen, onClose }: {
  tasks: Map<string, TaskView>; onOpen: (taskId: string) => void; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = [...tasks.values()].sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
  const open = openSessions(all);
  const terminal = all.filter((t) => t.live && t.source === 'external');
  const close = (t: TaskView) => {
    if (busy(t) && confirm !== t.id) { setConfirm(t.id); return; }
    setConfirm(null);
    api.closeSession(t.id).catch((e) => setError(e.message));
  };
  const row = (t: TaskView, closable: boolean) => (
    <li key={t.id} className="session-row">
      <span className={`av mini ${t.engine ?? 'claude'}`}>{ENGINE_SHORT[engineOf(t.engine)]}</span>
      <button className="link where" title={`${t.title} · 스레드 열기`} onClick={() => { onOpen(t.id); onClose(); }}>
        <span className="pdot" style={{ background: projectColor(t.project_id) }} />
        <b>{t.project_name}#{t.seq}</b><span className="ttl">{t.title}</span>
      </button>
      {confirm === t.id ? (
        <span className="acts"><button className="btn danger" onClick={() => close(t)}>턴을 끊고 닫기</button>
          <button className="btn" onClick={() => setConfirm(null)}>취소</button></span>
      ) : <>
        <span className={`st${busy(t) ? ' busy' : ''}`}>{statusLabel(t)}{t.model ? ` · ${modelShort(t.model)}` : ''}</span>
        <time dateTime={lastActive(t)}>{relTime(lastActive(t))}</time>
      </>}
      {confirm === t.id ? null : closable ? (
        <button className="icon-btn" title="세션 닫기: 기록은 남고, 답글을 보내면 이어서 재개" aria-label="세션 닫기" onClick={() => close(t)}><X /></button>
      ) : <span />}
    </li>
  );
  return (
    <Modal title={`열린 세션 ${open.length}`} onClose={onClose}>
      <div className="sessions">
        <p className="muted small">데스크가 띄운 엔진 프로세스입니다. 닫아도 기록은 남고, 답글을 보내면 같은 대화로 다시 시작합니다.
          {' '}한가한 세션은 30분 뒤 저절로 닫힙니다.</p>
        {open.length ? <ul>{open.map((t) => row(t, true))}</ul> : <p className="muted">열린 세션이 없습니다.</p>}
        {terminal.length > 0 && <>
          <h3>터미널에서 붙은 작업 <small className="muted">터미널에서 실행 중이라 여기서 닫을 수 없습니다</small></h3>
          <ul>{terminal.map((t) => row(t, false))}</ul>
        </>}
        {error && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}
