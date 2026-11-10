import { remoteLocation } from '../../shared/remote.ts';
import { ArrowLeft, Ellipsis, ListRestart, Pin } from 'lucide-react';
import { type CSSProperties } from 'react';
import { ENGINE_LABEL, ENGINES, MODE_LABEL, MODEL_LABEL, effortNote, engineOf, modelTagsOf } from '../../shared/compose.ts';
import { modelShort, projectColor } from './projects.ts';
import type { HubEvent, Project, TaskView } from './types.ts';
import { DraftBadge, StatusBadge, TerminalBadge } from './badges.tsx';

export function ThreadHead({ task, project, model, events, now, draft, handoff, onClose, onPin, onHandoff, onMenu }: {
  task: TaskView | undefined; project: Project | undefined; model: string | undefined; events: HubEvent[];
  now: number; draft: boolean; onClose: () => void; onPin: () => void; onMenu: (r: DOMRect) => void;
  /** Context reset: its panel is open, or closed with work kept; null: none. */
  handoff: 'open' | 'kept' | null; onHandoff: () => void;
}) {
  const turns = events.filter((e) => e.kind === 'status' && e.payload.state === 'turn_done').length;
  return (
    <header className="thread-head">
      <div className="row1">
        <button className="back" title="스레드 닫기 (q)" aria-label="스레드 닫기" onClick={onClose}><ArrowLeft /></button>
        {task && <span className="thread-chip" style={{ '--pc': projectColor(task.project_id) } as CSSProperties} title={project?.root_path}>{task.project_name}#{task.seq}</span>}
        <h2 title={task?.title}>{task?.title ?? '스레드'}</h2>
        {task?.source === 'external' && <TerminalBadge />}
        {task && <StatusBadge task={task} now={now} />}
        {draft && <DraftBadge />}
        {task?.source === 'app' && (
          <button className={`icon-btn${handoff === 'kept' ? ' kept' : ''}`} aria-pressed={handoff === 'open'}
            title={handoff === 'kept' ? '컨텍스트 재구성 이어서 하기 (X) · 쓰던 정리본이 있습니다' : handoff === 'open' ? '컨텍스트 재구성 패널 닫기 (X)' : '컨텍스트 재구성: 글을 골라 정리본을 만들고 새 세션으로 넘기기 (X)'}
            aria-label="컨텍스트 재구성" onClick={onHandoff}><ListRestart /></button>
        )}
        {task && <button className="icon-btn" title="컬럼으로 고정 (p)" aria-label="컬럼으로 고정" onClick={onPin}><Pin /></button>}
        <button className="icon-btn" title="컬럼 메뉴" aria-label="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}><Ellipsis /></button>
      </div>
      {task && (
        <div className="meta">
          <span title={project?.root_path}><span className="pdot" style={{ background: projectColor(task.project_id) }} />{task.project_name}
            <span className="seq" title={`@${task.project_name}#${task.seq}로 이 작업에 보낼 수 있습니다`}>#{task.seq}</span></span>
          <span title={`모델은 ${ENGINES.map((e) => `${modelTagsOf(e)}(${ENGINE_LABEL[e]})`).join(', ')}, effort는 #low … #max(${effortNote()}) 태그로 바꿉니다`}>
            {ENGINE_LABEL[engineOf(task.engine)]}{model ? ` · ${modelShort(model)}` : ''}
            {/* Switched by a tag, but no turn has run on it yet. */}
            {task.model && !new RegExp(`-${task.model}(-|$)`).test(model ?? '') ? ` → ${MODEL_LABEL[task.model]} (다음 턴)` : ''}
            {task.effort ? ` · effort ${task.effort}` : ''}</span>
          {turns > 0 && <span>턴 {turns}</span>}
          {task.permission_mode && task.source !== 'external' && <span>{task.permission_mode === 'auto' ? '자동 승인' : '매번 확인'} ({MODE_LABEL[task.permission_mode]})</span>}
          {project && remoteLocation(project.root_path) && <span title={project.root_path}>{remoteLocation(project.root_path)!.address} · {task.runner_connected ? '연결됨' : '연결 대기 · 마지막 확인 상태'}</span>}
          {!!task.delivery_pending && <span>러너 미수신 {task.delivery_pending}개</span>}
          {!task.live && !task.delivery_pending && task.runner_connected !== false && task.source !== 'external' && <span title="세션이 닫혀 있습니다. 답글을 보내면 이어서 다시 시작합니다.">세션 닫힘</span>}
        </div>
      )}
    </header>
  );
}
