import { ArrowLeft, Ellipsis, ListRestart, PanelLeft, Pin } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { ENGINE_LABEL, ENGINES, MODE_LABEL, MODEL_LABEL, effortNote, engineOf, modelTagsOf } from '../../shared/compose.ts';
import { modelShort, projectColor } from './projects.ts';
import type { HubEvent, Project, TaskView } from './types.ts';
import { DraftBadge, StatusBadge, TerminalBadge } from './badges.tsx';
import { api } from './api.ts';
import { SharedPending } from './workspace.ts';

interface TitleEdit { taskId: string; value: string; error?: string; saving?: boolean }

export function ThreadHead({ task, project, model, events, now, draft, handoff, references, onReferences, onClose, onPin, onHandoff, onMenu, onNotice, onRenamed }: {
  task: TaskView | undefined; project: Project | undefined; model: string | undefined; events: HubEvent[];
  now: number; draft: boolean; onClose: () => void; onPin: () => void; onMenu: (r: DOMRect) => void;
  onNotice: (message: string) => void; onRenamed: (taskId: string, title: string, revision: number) => void;
  /** Context reset: its panel is open, or closed with work kept; null: none. */
  handoff: 'open' | 'kept' | null; onHandoff: () => void;
  references?: { open: boolean; count: number }; onReferences?: () => void;
}) {
  const turns = events.filter((e) => e.kind === 'status' && e.payload.state === 'turn_done').length;
  const [titleEdit, setTitleEdit] = useState<TitleEdit>();
  const activeTask = useRef(task?.id);
  const attempt = useRef(0);
  const saving = useRef(false);
  const skipBlur = useRef(false);
  activeTask.current = task?.id;
  useEffect(() => {
    activeTask.current = task?.id;
    attempt.current++;
    saving.current = false;
    skipBlur.current = false;
    setTitleEdit(undefined);
    return () => { activeTask.current = undefined; attempt.current++; };
  }, [task?.id]);
  const editing = titleEdit?.taskId === task?.id ? titleEdit : undefined;
  const beginTitleEdit = () => {
    if (!task) return;
    attempt.current++;
    skipBlur.current = false;
    setTitleEdit({ taskId: task.id, value: task.title });
  };
  const cancelTitleEdit = () => {
    skipBlur.current = true;
    attempt.current++;
    saving.current = false;
    setTitleEdit(undefined);
  };
  const saveTitle = async () => {
    if (!task || !editing || saving.current || skipBlur.current) return;
    const title = editing.value.trim();
    if (!title) { setTitleEdit({ ...editing, error: '작업 제목을 입력하세요' }); return; }
    if (title === task.title) { cancelTitleEdit(); return; }
    const taskId = task.id, token = ++attempt.current;
    saving.current = true;
    setTitleEdit({ ...editing, saving: true, error: undefined });
    try {
      const updated = await api.renameTask(taskId, title);
      if (activeTask.current === taskId && attempt.current === token) {
        onRenamed(taskId, updated.title, updated.title_revision ?? 0);
        cancelTitleEdit();
      }
    } catch (error) {
      if (activeTask.current !== taskId || attempt.current !== token) return;
      if (error instanceof SharedPending) { cancelTitleEdit(); onNotice(error.message); }
      else setTitleEdit({ ...editing, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (attempt.current === token) saving.current = false;
    }
  };
  return (
    <header className="thread-head">
      <div className="row1">
        <button className="back" title="스레드 닫기 (q)" aria-label="스레드 닫기" onClick={onClose}><ArrowLeft /></button>
        {task && <span className="thread-chip" style={{ '--pc': projectColor(task.project_id) } as CSSProperties} title={project?.root_path}>{task.project_name}#{task.seq}</span>}
        <h2>
          {editing ? <input className="thread-title-input" aria-label="작업 제목" autoFocus disabled={editing.saving}
            value={editing.value} onChange={(e) => setTitleEdit({ ...editing, value: e.target.value, error: undefined })}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => { void saveTitle(); }} onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') { e.preventDefault(); void saveTitle(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelTitleEdit(); }
            }} />
            : task ? <button className="thread-title-button" title="제목 바꾸기" aria-label={`작업 제목 바꾸기: ${task.title}`} onClick={beginTitleEdit}>{task.title}</button>
              : '스레드'}
        </h2>
        {task?.source === 'external' && <TerminalBadge />}
        {task && <StatusBadge task={task} now={now} />}
        {draft && <DraftBadge />}
        {references && <button className="icon-btn" aria-label="고정한 글 창" aria-pressed={references.open}
          title="왼쪽에 고정한 글 보기 · 현재 스레드의 선택을 기억합니다" onClick={onReferences}><PanelLeft />{references.count > 0 && <span>{references.count}</span>}</button>}
        {task?.source === 'app' && (
          <button className={`icon-btn${handoff === 'kept' ? ' kept' : ''}`} aria-pressed={handoff === 'open'}
            title={handoff === 'kept' ? '컨텍스트 재구성 이어서 하기 (X) · 쓰던 정리본이 있습니다' : handoff === 'open' ? '컨텍스트 재구성 패널 닫기 (X)' : '컨텍스트 재구성: 글을 골라 정리본을 만들고 새 세션으로 넘기기 (X)'}
            aria-label="컨텍스트 재구성" onClick={onHandoff}><ListRestart /></button>
        )}
        {task && <button className="icon-btn" title="컬럼으로 고정 (p)" aria-label="컬럼으로 고정" onClick={onPin}><Pin /></button>}
        <button className="icon-btn" title="컬럼 메뉴" aria-label="컬럼 메뉴" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}><Ellipsis /></button>
      </div>
      {editing?.error && <p className="thread-title-error" role="alert">{editing.error}</p>}
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
          {task.source === 'external' ? <span>외부 세션</span>
            : task.runner_id ? <span title={`러너 ID: ${task.runner_id}`}>러너 {task.runner_label ?? task.runner_id} · {task.runner_connected ? '연결됨' : '연결 대기 · 마지막 확인 상태'}</span>
            : <span>러너 {task.source === null ? '미지정' : '정보 없음'}</span>}
          {!!task.delivery_pending && <span>러너 미수신 {task.delivery_pending}개</span>}
          {!task.live && !task.delivery_pending && task.runner_connected !== false && task.source !== 'external' && <span title="세션이 닫혀 있습니다. 답글을 보내면 이어서 다시 시작합니다.">세션 닫힘</span>}
        </div>
      )}
    </header>
  );
}
