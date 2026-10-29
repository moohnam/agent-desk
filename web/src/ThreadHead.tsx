import { ArrowLeft, Ellipsis, ListRestart, Pin } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
import { ENGINE_LABEL, ENGINES, MODE_LABEL, MODEL_LABEL, effortNote, engineOf, modelTagsOf } from '../../shared/compose.ts';
import { modelShort, projectColor } from './projects.ts';
import type { HubEvent, Post, Project, TaskView } from './types.ts';
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
          {!task.live && task.source !== 'external' && <span title="세션이 닫혀 있습니다. 답글을 보내면 이어서 다시 시작합니다.">세션 닫힘</span>}
        </div>
      )}
    </header>
  );
}

/** `ask`: the pending approval is an agent's question, answered rather than approved. */
export function ContextHint({ post, task, pending, ask, question }: {
  post: Post | undefined; task: TaskView | undefined; pending: boolean; ask?: boolean; question: boolean;
}) {
  if (!post) return null;
  let text: ReactNode = <>이 글: <kbd>Enter</kbd> 스레드 · <kbd>r</kbd> 답글</>;
  if (task?.source === 'external') {
    text = question ? <>이 작업: <kbd>r</kbd> 질문에 답하기</> : <>터미널 작업: <kbd>Enter</kbd> 스레드</>;
  } else if (pending && ask) text = <>{post.kind === 'approval' ? '이 글' : '이 작업'}: <kbd>y</kbd> 질문에 답하기 · <kbd>n</kbd> 답하지 않기</>;
  else if (pending) text = <>{post.kind === 'approval' ? '이 글' : '이 작업'}: <kbd>y</kbd> 승인 · <kbd>n</kbd> 거절</>;
  else if (task?.status === 'running') text = <>이 작업: <kbd>s</kbd> 중단 · <kbd>r</kbd> 답글</>;
  return <span className="ctx-hint">{text}</span>;
}
