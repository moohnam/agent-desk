import { imeKey } from './keys.ts';
import {useModelCatalogs} from './modelCatalogs.ts';
import {catalogModelTags,catalogsForTarget,type RunnerModelCatalog} from '../../shared/model-catalog.ts';
import { ANSWER_COMPOSE, AnswerDestination, useAnswerTarget, submitAnswer } from './answerComposer.tsx';
import { ArrowDown, ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import {
  DEFAULT_ENGINE, DEFAULT_MODE, DELIVERY_LABEL, ENGINE_INFO, ENGINE_LABEL, ENGINES, MODE_LABEL, modelLabel, TAG_HELP, effortNote, modelEngine,
  modelHelpOf, modelProblem, modelTagsOf, parseCompose, parseComposeTarget, parseNoteCompose, wantedEngine, type Delivery, type Effort, type EngineName, type ModelName,
} from '../../shared/compose.ts';
import { api, workspaceOperationId } from './api.ts';
import { composeSource, splitId } from './federation.ts';
import { useSources } from './Workspaces.tsx';
import { SharedPending } from './workspace.ts';
import type { MessageReceipt, NoteContext } from '../../shared/api.ts';
import { hasScheduledReply, parseScheduledReply, scheduledReplyDraft, scheduledReplyHint, scheduledReplyPlainText } from '../../shared/scheduled-reply.ts';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';
import { useDeskApp, useFileDrop, webDrop } from './files.ts';
import { projectColor, rankProjects } from './projects.ts';
import { useSettings } from './settings.ts';
import { useSkills } from './skills.ts';
import { Modal } from './Modal.tsx';
import { NotePreview } from './NotePreview.tsx';
import { QueuedShortcut, type QueuedTarget } from './queuedShortcut.ts';
import type { Approval, Project, Settings, Skill, TaskView } from './types.ts';

// ── 자동 완성 ──
const scheduledTime = new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

interface Option { key: string; insert: string; label: string; desc?: string; workdir?: string; color?: string; space?: boolean }
/** Rows rendered in the @ list; typing narrows it further. */
const MAX_OPTIONS = 50;

const TAG_OPTIONS: Option[] = TAG_HELP.map(({ tag, help }) => ({ key: tag, insert: tag, label: `#${tag}`, desc: help, space: true }));

/**
 * Options for the @mention or #tag being typed just before the caret. `mentions`: 'route' where a
 * mention says where the text goes (and may define a new project), 'refer' where it names a project
 * or task the agent may ask (replies).
 */
function suggest(text: string, caret: number, projects: Project[], tasks: TaskView[], mentions: Mentions, skills: Skill[], models: Record<string,ModelName> = {}) {
  const before = text.slice(0, caret);
  const no = mentions ? /(^|\s)@([^\s:@#]+)#(\d*)$/.exec(before) : null;
  const numbered = no && projects.find((p) => p.name.toLowerCase() === no[2].toLowerCase());
  if (no && numbered) {
    const q = no[3];
    const items: Option[] = tasks.filter((t) => t.project_id === numbered.id && String(t.seq).startsWith(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, MAX_OPTIONS)
      .map((t) => ({ key: t.id, insert: String(t.seq), label: `@${numbered.name}#${t.seq}`, space: true, desc: `› ${t.title}` }));
    return { start: caret - q.length, items, total: items.length };
  }
  const at = mentions ? /(^|\s)@([^\s:@#]*)$/.exec(before) : null;
  if (at) {
    const q = at[2];
    const ranked = rankProjects(projects, tasks, q);
    const items: Option[] = ranked.slice(0, MAX_OPTIONS).map(({ project, last }) => ({
      key: project.id, insert: project.name, label: `@${project.name}`, space: true, color: projectColor(project.id),
      desc: last ? `› ${last.title}` : undefined, workdir: project.root_path,
    }));
    if (mentions === 'route' && q && !projects.some((p) => p.name.toLowerCase() === q.toLowerCase())) {
      items.push({ key: 'new', insert: `${q}:/`, label: `@${q}:/경로`, desc: '새 프로젝트 만들기' });
    }
    return { start: caret - q.length, items, total: ranked.length };
  }
  const hash = /(^|\s)#([a-z0-9-]*)$/i.exec(before);
  if (hash) {
    const q = hash[2].toLowerCase();
    const creatingNote = mentions === 'route' && /^\s*(?:@[^\s:@#]+\s+)?$/.test(before.slice(0, hash.index + hash[1].length));
    const skillOptions: Option[] = skills.filter(k => !creatingNote || k.name !== 'note').map((k) => ({
      key: `skill:${k.name}`, insert: k.name, label: `#${k.name}`, desc: `스킬 · ${k.description || '설명 없음'}`, space: true,
    }));
    const modelOptions: Option[] = Object.entries(models).map(([tag,model]) => ({key:`model:${tag}`,insert:tag,label:`#${tag}`,desc:`${ENGINE_LABEL[modelEngine(model)]} · ${modelLabel(model)}`,space:true}));
    const noteOption: Option[] = creatingNote ? [{ key: 'create:note', insert: 'note', label: '#note', desc: '등록된 프로젝트에 메모 작업 만들기', space: true }] : [];
    const items = [...noteOption, ...TAG_OPTIONS, ...modelOptions, ...skillOptions].filter((t) => t.insert.startsWith(q) && t.insert !== q);
    return { start: caret - q.length, items, total: items.length };
  }
  return null;
}

type Mentions = 'route' | 'refer';

export function ResizableEditor({ inputRef, rows: defaultRows, resizeFrom = 'top', onBeforeResize, children }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  rows: number;
  resizeFrom?: 'top' | 'bottom';
  /** Captures any scroll position that needs restoring after the new rows commit. */
  onBeforeResize?: () => (() => void) | undefined;
  children: (control: { id: string; rows: number }) => ReactNode;
}) {
  const id = useId();
  const [rows, setRows] = useState<number>();
  const afterResize = useRef<(() => void) | undefined>(undefined);
  const changeRows = (next: number | undefined) => {
    afterResize.current = (next ?? defaultRows) !== (rows ?? defaultRows) ? onBeforeResize?.() : undefined;
    setRows(next);
  };
  useLayoutEffect(() => {
    const restore = afterResize.current;
    afterResize.current = undefined;
    restore?.();
  }, [rows]);
  const measure = () => {
    const input = inputRef.current;
    if (!input) return;
    const style = getComputedStyle(input), line = parseFloat(style.lineHeight);
    if (!Number.isFinite(line) || line <= 0) return;
    const inset = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce((total, value) => total + parseFloat(value), 0);
    const visible = Math.max(2, Math.round((input.offsetHeight - inset) / line));
    const maxRows = Math.max(2, Math.floor((Math.min(620, window.innerHeight / 2) - inset) / line));
    return { visible, maxRows, line };
  };
  const drag = useRef<{ pointer: number; x: number; y: number; size: NonNullable<ReturnType<typeof measure>>; moved: boolean } | null>(null);
  const lastTap = useRef<{ time: number; pointerType: string } | null>(null);
  const resize = (next: number, max: number) => changeRows(Math.max(2, Math.min(next, max)));
  const resizeBy = ({ visible, maxRows, line }: NonNullable<ReturnType<typeof measure>>, dy: number) =>
    resize(visible + Math.round(dy / line * (resizeFrom === 'top' ? -1 : 1)), maxRows);
  const grip = <button type="button" className="compose-height-grip" aria-controls={id}
    aria-label="입력창 높이 조절" title="끌거나 방향키로 높이 조절 · 더블클릭 또는 Home으로 기본 크기"
    onMouseDown={e => e.preventDefault()}
    onPointerDown={e => {
      if (e.button !== 0 || drag.current) return;
      const size = measure();
      if (!size) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, size, moved: false };
    }}
    onPointerMove={e => {
      const start = drag.current;
      if (start?.pointer !== e.pointerId) return;
      const dy = e.clientY - start.y;
      start.moved ||= Math.abs(dy) >= 4 || Math.abs(e.clientX - start.x) >= 4;
      if (start.moved) resizeBy(start.size, dy);
    }}
    onPointerUp={e => {
      const start = drag.current;
      if (start?.pointer !== e.pointerId) return;
      const dy = e.clientY - start.y;
      const tap = !start.moved && Math.abs(dy) < 4 && Math.abs(e.clientX - start.x) < 4;
      if (!tap) resizeBy(start.size, dy);
      const last = lastTap.current;
      if (tap && last?.pointerType === e.pointerType && e.timeStamp - last.time <= 500) {
        changeRows(undefined);
        lastTap.current = null;
      } else lastTap.current = tap ? { time: e.timeStamp, pointerType: e.pointerType } : null;
    }}
    onLostPointerCapture={e => { if (drag.current?.pointer === e.pointerId) drag.current = null; }}
    onClick={e => { const size = e.detail === 0 && measure(); if (size) resize(size.visible + 1, size.maxRows); }}
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Home') changeRows(undefined);
      else { const size = measure(); if (size) resize(size.visible + (e.key === 'ArrowUp' ? 1 : -1), size.maxRows); }
    }} />;
  return <div className="compose-editor">
    {resizeFrom === 'top' && grip}
    {children({ id, rows: rows ?? defaultRows })}
    {resizeFrom === 'bottom' && grip}
  </div>;
}

/**
 * A textarea with @project / #tag completion. Scales to many projects: the list is filtered by
 * what is typed (name or path), ranked by recent activity, and scrolls.
 */
export function ComposeField({ value, onChange, onSubmit, onEscape, onBlur, inputRef, projects, tasks, mentions, placeholder, rows, source='', runnerId, resizeFrom = 'top', onBeforeResize }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void;
  /** Esc with no list open; by default it is handled by the containing view. */
  onEscape?: () => void;
  onBlur?: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  projects: Project[]; tasks: TaskView[]; mentions: Mentions; placeholder: string; rows: number; source?:string; runnerId?:string;
  resizeFrom?: 'top' | 'bottom';
  onBeforeResize?: () => (() => void) | undefined;
}) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const skills = useSkills(source);
  const inventory = useModelCatalogs(source);
  const modelTags = useMemo(() => {
    const mention = mentions === 'route' ? parseCompose(value).mention : undefined;
    const project = mention && projects.find(p=>p.name.toLowerCase()===mention.name.toLowerCase());
    return catalogModelTags(catalogsForTarget(inventory.runners,{runnerId,rootPath:mention?.path ?? project?.root_path}),skillNames(skills));
  },[inventory.runners,source,runnerId,value,projects,mentions,skills]);
  const sug = useMemo(() => suggest(value, caret, projects, tasks, mentions, skills,modelTags), [value, caret, projects, tasks, mentions, skills,modelTags]);
  const open = !dismissed && !!sug?.items.length;
  const cur = Math.min(index, (sug?.items.length ?? 1) - 1);
  const app = useDeskApp();
  const files = useFileDrop(inputRef, value, onChange, !!source);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => { setIndex(0); }, [sug?.start, sug?.items.length]);
  useEffect(() => { list.current?.querySelector('.opt.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, open]);

  const pick = (o: Option) => {
    if (!sug) return;
    const ins = o.insert + (o.space ? ' ' : '');
    const next = value.slice(0, sug.start) + ins + value.slice(caret);
    const pos = sug.start + ins.length;
    onChange(next);
    setCaret(pos);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos); });
  };

  // In the app, every drop on the window comes by 'desk-drop' (useFileDrop); in a browser, files
  // dropped on the field are uploaded, and an image dragged from a web page downloaded by the hub.
  const browserDrop = app ? {} : {
    onDragOver: (e: DragEvent) => {
      const t = e.dataTransfer.types;
      if (t.includes('Files') || t.includes('text/uri-list')) { e.preventDefault(); files.setOver(true); }
    },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) files.setOver(false); },
    onDrop: (e: DragEvent) => {
      files.setOver(false);
      if (e.dataTransfer.files.length) {
        e.preventDefault();
        void files.upload([...e.dataTransfer.files]);
        return;
      }
      const url = e.dataTransfer.getData('text/uri-list'), html = e.dataTransfer.getData('text/html');
      if (webDrop(url, html)) { e.preventDefault(); void files.fromWeb(url, html); }
    },
  };

  return (
    <ResizableEditor inputRef={inputRef} rows={rows} resizeFrom={resizeFrom} onBeforeResize={onBeforeResize}>{({ id, rows }) => (
    <div className={`cmp-field${files.over ? ' drop-over' : ''}`} {...browserDrop}>
      <textarea id={id} ref={inputRef} className="input" value={value} rows={rows} placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setDismissed(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => { setDismissed(true); onBlur?.(); }} onFocus={() => setDismissed(false)}
        onKeyDown={(e) => {
          if (imeKey(e.nativeEvent) || e.defaultPrevented) return;
          if (e.key === 'Escape' && e.repeat) { e.preventDefault(); e.stopPropagation(); return; }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!e.repeat) onSubmit(); return; }
          if (open && sug) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((cur + 1) % sug.items.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((cur - 1 + sug.items.length) % sug.items.length); return; }
            if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pick(sug.items[cur]); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
          }
          if (e.key === 'Escape' && onEscape) { e.preventDefault(); e.stopPropagation(); onEscape(); }
        }} />
      {!app && (
        <>
          <button type="button" className="attach" title="파일 첨부: 허브가 있는 Mac에 올리고 경로를 넣습니다"
            aria-label="파일 첨부" onClick={() => picker.current?.click()}><Paperclip /></button>
          <input ref={picker} type="file" multiple hidden
            onChange={(e) => { void files.upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </>
      )}
      {files.over && <div className="drop-hint">{app ? '놓으면 파일 경로를 넣습니다' : '놓으면 파일을 올리고 경로를 넣습니다'}</div>}
      {(files.uploading > 0 || files.error) && (
        <div className={`upload-note${files.error ? ' warn' : ''}`}>{files.uploading > 0 ? `파일 ${files.uploading}개 올리는 중…` : files.error}</div>
      )}
      {open && sug && (
        <div className="ac" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          <div className="opts" ref={list}>
            {sug.items.map((o, i) => (
              <div key={o.key} role="option" aria-selected={i === cur} className={`opt${i === cur ? ' on' : ''}`}
                onMouseEnter={() => setIndex(i)} onClick={() => pick(o)}>
                {o.color && <span className="pdot" style={{ background: o.color }} />}
                <span className="k">{o.label}</span>
                {o.desc && <span className="d">{o.desc}</span>}
                {o.workdir && <code className="option-workdir" dir="ltr">{o.workdir}</code>}
              </div>
            ))}
          </div>
          <div className="foot">
            ↑↓ 이동 · Tab/Enter 선택 · Esc 닫기{sug.total > MAX_OPTIONS ? ` · ${sug.total}개 중 ${MAX_OPTIONS}개, 더 입력해 좁히기` : ''}
          </div>
        </div>
      )}
    </div>
    )}</ResizableEditor>
  );
}

// ── 해석 미리보기 ──

const engineName = (e: string | null | undefined) => ENGINE_LABEL[(e ?? DEFAULT_ENGINE) as EngineName] ?? e;

interface Row { label: string; value: ReactNode; tone?: 'ok' | 'bad' | 'warn' }

const skillNames = (skills: Skill[]) => skills.map((s) => s.name);

const effortName = (e: Effort | null | undefined) => e ? `effort ${e}` : 'effort 모델 기본';

/** "Opus (태그) · effort high (기본 설정)": where the model and effort of a message come from. */
function modelRow(engine: EngineName, c: { model?: ModelName; effort?: Effort }, task: TaskView | undefined, s: Settings): string {
  const modelName = (m: ModelName | null) => m ? modelLabel(m) : `${ENGINE_LABEL[engine]} 기본`;
  const part = <T,>(tag: T | undefined, kept: T | null | undefined, def: T | null, name: (v: T | null) => string) =>
    tag ? `${name(tag)} (태그)` : task ? `${name(kept ?? null)}${kept ? ' (작업 유지)' : ''}`
      : def ? `${name(def)} (기본 설정)` : name(null);
  return `${part(c.model, task?.model, s[engine].model, modelName)} · ${part(c.effort, task?.effort, s[engine].effort, effortName)}`;
}

const isRunning = (t: TaskView) => t.status === 'running' || t.status === 'waiting';

/** What happens to a message for `task` given its delivery tag (hub.sendMessage). */
function deliveryText(task: TaskView, d: Delivery | undefined): string | null {
  if (task.runner_id?.startsWith('remote-') && task.runner_connected === false) return '러너 재연결 후 순서대로 전달 (#now도 대기열에 보관)';
  if (d === 'fork') return '이 작업의 대화를 이어받은 새 작업으로 동시에 진행';
  if (d === 'new') return '같은 프로젝트에서 새 작업 시작 (이전 대화 없이)';
  if (!isRunning(task)) return d ? `실행 중이 아니라 바로 보냅니다 (#${d} 무시)` : null;
  if (d === 'now') return '실행 중인 턴에 바로 끼워넣기';
  return `지금 턴이 끝난 뒤 보내기${(task.queued ?? []).length ? ` · 앞에 ${(task.queued ?? []).length}개 대기 중` : ''}${d ? '' : ' (기본)'}`;
}

function interpretNew(text: string, projects: Project[], tasks: TaskView[], skills: Skill[], settings: Settings,
  runners: RunnerModelCatalog[], noteAttachment?: NoteContext[number]): { ok: boolean; rows: Row[]; noteOnly?: boolean; createsNote?: boolean } {
  const route = parseComposeTarget(text);
  const { mention } = route;
  const project = mention && projects.find(p => p.name.toLowerCase() === mention.name.toLowerCase());
  const addressed = project && mention?.no && !mention.path && !/^\s*#note(?=\s|$)/.test(text)
    ? tasks.find(t => t.project_id === project.id && t.seq === mention.no) : undefined;
  const note = parseNoteCompose(text);
  if (addressed?.kind === 'note' || note) {
    const rows: Row[] = [];
    if (noteAttachment) rows.push({ label: '첨부', value: '첨부한 메모를 받을 에이전트 작업을 지정하세요', tone: 'bad' });
    if (addressed?.kind === 'note') {
      const body = route.text.trim();
      rows.push({ label: '대상', value: `@${project!.name}#${addressed.seq} › “${addressed.title}”` },
        body ? { label: '메모 글', value: body } : { label: '메모 글', value: '내용을 입력하세요', tone: 'bad' });
      return { ok: !!body && !noteAttachment, rows, noteOnly: true };
    }
    const destination = note?.mention;
    const registered = destination && projects.find(p => p.name.toLowerCase() === destination.name.toLowerCase());
    const valid = registered && destination?.no == null && !destination?.path;
    rows.push(valid ? { label: '대상', value: `@${registered.name} · 새 메모` }
      : { label: '대상', value: '등록된 @프로젝트를 입력하세요', tone: 'bad' });
    rows.push(note?.title ? { label: '제목', value: note.title } : { label: '제목', value: '메모 제목을 입력하세요', tone: 'bad' });
    return { ok: !!valid && !!note?.title && !noteAttachment, rows, createsNote: true };
  }
  if (hasScheduledReply(route.text)) return { ok: false, rows: [{ label: '예약', value: scheduledReplyHint, tone: 'bad' }] };
  const modelTags = catalogModelTags(catalogsForTarget(runners,{rootPath:mention?.path ?? project?.root_path}),skillNames(skills));
  const c = parseCompose(text, skillNames(skills),true,modelTags);
  const rows: Row[] = [];
  let ok = true;
  let continuing: TaskView | undefined;
  if (!c.mention) {
    ok = false;
    rows.push({ label: '대상', value: '@프로젝트 또는 @이름:/경로가 필요합니다', tone: 'bad' });
  } else if (c.mention.path && c.mention.no) {
    ok = false;
    rows.push({ label: '대상', value: '작업 번호와 경로는 함께 쓸 수 없습니다', tone: 'bad' });
  } else if (c.mention.path) {
    rows.push({ label: '대상', value: project ? `@${project.name} · 새 작업` : `새 프로젝트 @${c.mention.name} (${c.mention.path})` });
  } else if (!project) {
    ok = false;
    rows.push({ label: '대상', value: `@${c.mention.name}은(는) 없는 프로젝트입니다. @${c.mention.name}:/경로로 만드세요`, tone: 'bad' });
  } else if (c.delivery === 'new') {
    rows.push({ label: '대상', value: `@${project.name} · 새 작업 (#new)` });
  } else if (c.mention.no) {
    continuing = tasks.find((t) => t.project_id === project.id && t.seq === c.mention!.no);
    if (!continuing) ok = false;
    rows.push(continuing ? { label: '대상', value: `@${project.name}#${continuing.seq} › “${continuing.title}” 이어가기` }
      : { label: '대상', value: `@${project.name}#${c.mention.no} 작업이 없습니다`, tone: 'bad' });
  } else {
    continuing = tasks.filter((t) => t.project_id === project.id && t.kind !== 'note').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    // Naming another engine than the latest task's starts a new task (hub.compose).
    const want = wantedEngine(c);
    if (continuing && want && want !== (continuing.engine ?? DEFAULT_ENGINE)) continuing = undefined;
    rows.push({ label: '대상', value: continuing ? `@${project.name}#${continuing.seq} › “${continuing.title}” 이어가기` : `@${project.name} · 새 작업` });
  }
  rows.push({ label: '엔진', value: continuing ? `${engineName(continuing.engine)} (작업 유지)`
    : c.engine ? `${ENGINE_LABEL[c.engine]} (태그)` : c.model ? `${ENGINE_LABEL[modelEngine(c.model)]} (#${c.model} 모델)`
    : `${ENGINE_LABEL[DEFAULT_ENGINE]} (기본)` });
  const engine = continuing ? (continuing.engine ?? DEFAULT_ENGINE) as EngineName : wantedEngine(c) ?? DEFAULT_ENGINE;
  const problem = modelProblem(engine, c);
  if (problem) ok = false;
  rows.push(problem ? { label: '모델', value: problem, tone: 'bad' } : { label: '모델', value: modelRow(engine, c, continuing, settings) });
  const mode = c.mode ?? (continuing ? continuing.permission_mode : null);
  rows.push({ label: '승인', value: c.mode ? `${MODE_LABEL[c.mode]}로 전환` : mode ? `${MODE_LABEL[mode]} (작업 유지)` : `${MODE_LABEL[DEFAULT_MODE]} 자동 승인 (기본)` });
  if (c.skills.length) rows.push({ label: '스킬', value: `${c.skills.map((k) => `#${k}`).join(' ')} (이 메시지에만)` });
  const delivery = continuing ? deliveryText(continuing, c.delivery) : c.delivery && c.delivery !== 'new' ? `새 작업이라 #${c.delivery}는 무시` : null;
  if (delivery) rows.push({ label: '전달', value: delivery });
  if (!c.body && !c.skills.length) ok = false;
  rows.push(c.body ? { label: '할 일', value: c.body }
    : c.skills.length ? { label: '할 일', value: '스킬 지침대로 진행 (추가 지시 없음)' }
    : { label: '할 일', value: '내용을 입력하세요', tone: 'bad' });
  return { ok, rows };
}

function Preview({ ok, rows }: { ok: boolean; rows: Row[] }) {
  return (
    <dl className="preview">
      <div className="title"><span>해석 미리보기</span><span className={ok ? 'ok' : 'bad'}>{ok ? '보낼 수 있음' : '입력 필요'}</span></div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'contents' }}><dt>{r.label}</dt><dd className={r.tone}>{r.value}</dd></div>
      ))}
    </dl>
  );
}

// ── 작성 서랍 ──

/** Left drawer for new work: `@project` continues its last task, `@name:/path` starts a project. */
export function ComposeDrawer({ projects: allProjects, tasks: allTasks, inputRef, onClose, onSent, noteAttachment, onClearNoteAttachment }: {
  projects: Project[]; tasks: TaskView[]; inputRef: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void; onSent: (task: TaskView) => void;
  noteAttachment?: NoteContext[number]; onClearNoteAttachment?: (attachment: NoteContext[number]) => void;
}) {
  const sources=useSources();
  const [target,setTarget]=useState(()=>getDraft<string>('drawer-target')??'auto');
  useEffect(()=>{setDraft('drawer-target',target,{empty:target==='auto'});},[target]);
  useDraftSync<string>('drawer-target',v=>{revision.current++;setTarget(v??'auto');});
  const projects=target==='auto'?allProjects:allProjects.filter(p=>splitId(p.id)[0]===target);
  const tasks=target==='auto'?allTasks:allTasks.filter(t=>splitId(t.id)[0]===target);
  // Unsent text stays while the drawer is closed and across reloads (drafts.ts).
  const [text, setText] = useState(() => getDraft<string>('drawer') ?? '');
  const revision = useRef(0);
  const mounted = useRef(true);
  const latestAttachment = useRef(noteAttachment);
  latestAttachment.current = noteAttachment;
  const editText = (value: string) => { revision.current++; setText(value); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft('drawer', text, { empty: !text.trim() }); }, [text]);
  useDraftSync<string>('drawer', (v) => editText(v ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let selectedSource='';
  try{selectedSource=composeSource(text,allProjects,target==='auto'?undefined:target);}catch{/* submit explains ambiguity */}
  const skills = useSkills(selectedSource);
  const settings = useSettings(selectedSource);
  const inventory = useModelCatalogs(selectedSource);
  const hint = useMemo(() => interpretNew(text, projects, tasks, skills, settings, inventory.runners, noteAttachment),
    [text, projects, tasks, skills, settings, inventory.runners, noteAttachment]);
  const recent = useMemo(() => rankProjects(projects, tasks)[0]?.project.name, [projects, tasks]);

  const submit = async () => {
    if (!hint.ok || busy) return;
    const unchanged = revision.current;
    const submittedDraft = getDraft('drawer');
    const clearSubmitted = () => {
      // A delayed response must preserve edits made here or after reopening the drawer.
      if (revision.current !== unchanged || latestAttachment.current !== noteAttachment || (!mounted.current && getDraft('drawer') !== submittedDraft)) return false;
      setDraft('drawer', '', { empty: true });
      setText('');
      return true;
    };
    setBusy(true); setError(null);
    try {
      const task = await api.compose(text, target === 'auto' ? undefined : target,
        noteAttachment ? [noteAttachment] : undefined, hint.noteOnly);
      if (noteAttachment) onClearNoteAttachment?.(noteAttachment);
      // onSent closes the drawer in the same render, before the effect would see the empty text.
      if (clearSubmitted() && mounted.current) onSent(task);
      else if (mounted.current) setError('이전 지시를 보냈습니다. 현재 작성 중인 내용은 보관했습니다.');
    } catch (e) {
      if (e instanceof SharedPending) {
        clearSubmitted();
        if (noteAttachment) onClearNoteAttachment?.(noteAttachment);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const example = (s: string) => {
    editText(s);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(s.length, s.length); });
  };

  return (
    <aside className="compose" aria-label="새 작업">
      <header className="cmp-head">
        <h2>새 작업 · 지시</h2>
        <button className="icon-btn" title="닫기" aria-label="닫기" onClick={onClose}><X /></button>
      </header>
      <div className="cmp-body">
        {(!!sources.length||(target&&target!=='auto'))&&<label>새 지시의 실행 대상<select className="input" aria-label="새 지시의 실행 대상" value={target} onChange={e=>{revision.current++;setTarget(e.target.value);}}>
          {target&&target!=='auto'&&!sources.some(s=>s.id===target)&&<option value={target}>연결되지 않은 공유 실행 대상</option>}
          <option value="auto">프로젝트에 따라 자동 선택</option><option value="">이 허브 · 로컬/원격 러너</option>
          {sources.map(s=><option key={s.id} value={s.id}>{s.name} · 공유</option>)}
        </select></label>}
        <ComposeField value={text} onChange={editText} onSubmit={submit} onEscape={onClose} inputRef={inputRef} rows={6} resizeFrom="bottom"
          projects={projects} tasks={tasks} mentions="route" source={selectedSource}
          placeholder={noteAttachment ? '@프로젝트 지시 또는 @프로젝트#작업번호 지시'
            : '@프로젝트 할 일\n새 프로젝트는 @이름:/경로 · 원격은 @이름:서버:~/경로 할 일'} />
        {noteAttachment && <div className="note-attachment">
          <NotePreview note={noteAttachment} />
          <button type="button" className="icon-btn" title="메모 첨부 해제" aria-label="메모 첨부 해제" disabled={busy}
            onClick={() => onClearNoteAttachment?.(noteAttachment)}><X /></button>
        </div>}
        <Preview ok={hint.ok} rows={hint.rows} />
        {error && <p className="error">{error}</p>}
        <div className="cmp-actions">
          <span><kbd>⌘</kbd><kbd>↵</kbd> 보내기</span>
          <span className="spacer" />
          <button className="btn primary" disabled={!hint.ok || busy} onClick={submit}>{hint.createsNote ? '메모 만들기' : '게시'}</button>
        </div>
        <div className="examples">
          <span className="lbl">예시 넣기</span>
          {recent && <button onClick={() => example(`@${recent} 이어서 테스트를 돌리고 결과를 정리해줘`)}>@{recent} 이어서 테스트를 돌리고…</button>}
          <button onClick={() => example('@demo:/tmp/demo 간단한 README를 써줘')}>@demo:/tmp/demo 간단한 README를…</button>
          {recent && <button onClick={() => example(`@${recent} #auto 린트 오류를 모두 고쳐줘`)}>@{recent} #auto 린트 오류를…</button>}
          {recent && !noteAttachment && <button onClick={() => example(`@${recent} #note 회의 메모`)}>@{recent} #note 회의 메모</button>}
        </div>
        <div className="syntax">
          <span className="lbl">문법</span>
          <code>@프로젝트</code><span>그 프로젝트의 최근 에이전트 작업 이어가기</span>
          <code>@프로젝트#2</code><span>그 프로젝트의 2번 작업 이어가기</span>
          <code>@프로젝트 #note 제목</code><span>프로젝트에 메모 만들기</span>
          <code>#new</code><span>같은 프로젝트에서 새 작업 시작 (이전 대화 없이)</span>
          <code>@이름:/경로</code><span>프로젝트를 만들고 새 작업 시작</span>
          <code>#auto</code><span>이제부터 자동 승인 (새 작업 기본)</span>
          <code>#ask</code><span>이제부터 매번 확인</span>
          {ENGINES.map((e) => <Fragment key={e}><code>#{e}</code><span>새 작업을 {ENGINE_INFO[e].tagLabel}로{e === DEFAULT_ENGINE ? ' (기본)' : ''}</span></Fragment>)}
          {ENGINES.map((e) => <Fragment key={e}><code>{modelTagsOf(e)}</code><span>{modelHelpOf(e)} (작업에 유지)</span></Fragment>)}
          <code>#low … #max</code><span>effort 고르기 (작업에 유지, {effortNote()})</span>
          <code>#스킬이름</code><span>데스크 스킬을 이 메시지에만 사용</span>
          <code>#later</code><span>실행 중이면 지금 턴 뒤에 보내기 · 스레드 답글에서 #later {'{+2m}'}로 전송 예약</span>
          <code>#now</code><span>실행 중인 턴에 바로 끼워넣기</span>
          <code>#fork</code><span>작업의 대화를 이어받은 새 작업으로 동시에 진행</span>
        </div>
      </div>
    </aside>
  );
}

// ── 스레드 답글 상자 ──

/**
 * Inline reply at the bottom of the thread column; the #auto toggle switches the task's mode.
 * While the task works, the #later/#now buttons pick what happens to the reply; #new and #fork
 * send it to a new task instead (a tag typed in the text wins). Waiting replies are listed above the
 * box and can be cancelled.
 */
export function ReplyBox({ task, projects, tasks, inputRef, onError, onSend, onBeforeResize }: {
  task: TaskView; inputRef: RefObject<HTMLTextAreaElement | null>; onError: (msg: string) => void;
  /** For @mentions: naming another project or task lets this task's agent ask it (desk_request) without a card. */
  projects: Project[]; tasks: TaskView[];
  /** Right before a message goes out (its event can arrive before the reply); the thread then follows it. */
  onSend?: () => void;
  onBeforeResize?: () => (() => void) | undefined;
}) {
  // Mounted per task (keyed by its id): the box restores the task's unsent reply and keeps it as a
  // draft until it is sent, across other threads and reloads.
  const answerTarget = useAnswerTarget(task.id);
  useEffect(() => {
    if (answerTarget) inputRef.current?.focus();
    const focus = (event: Event) => { if ((event as CustomEvent).detail?.taskId === task.id) inputRef.current?.focus(); };
    window.addEventListener(ANSWER_COMPOSE, focus);
    return () => window.removeEventListener(ANSWER_COMPOSE, focus);
  }, [answerTarget, inputRef, task.id]);
  const draftKey = `reply:${task.id}`;
  const [text, setText] = useState(() => getDraft<{ text: string }>(draftKey)?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Delivery | null>(() => getDraft<{ pick: Delivery | null }>(draftKey)?.pick ?? null);
  const [sent, setSent] = useState<string | null>(null);
  const shortcut = useRef(new QueuedShortcut());
  const revision = useRef(0);
  const mounted = useRef(true);
  const scheduledAttempt = useRef<{ at: string; operation: string; session?: string }>(undefined);
  const edited = () => { revision.current++; shortcut.current.reset(); scheduledAttempt.current = undefined; };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; shortcut.current.reset(); };
  }, []);
  useEffect(() => { setDraft(draftKey, { text, pick }, { taskId: task.id, empty: !text.trim() }); }, [draftKey, text, pick, task.id]);
  useDraftSync<{ text: string; pick: Delivery | null }>(draftKey, (v) => { edited(); setText(v?.text ?? ''); setPick(v?.pick ?? null); });
  const skills = useSkills(splitId(task.id)[0]);
  const inventory = useModelCatalogs(splitId(task.id)[0]);
  const modelTags = catalogModelTags(catalogsForTarget(inventory.runners,{runnerId:task.runner_id}),skillNames(skills));
  const schedule = parseScheduledReply(text);
  const scheduled = schedule && 'at' in schedule ? schedule : undefined;
  const c = parseCompose(scheduled?.text ?? text, skillNames(skills), false,modelTags);
  const scheduleError = schedule && (answerTarget ? '질문에 답하는 동안에는 메시지를 예약할 수 없습니다'
    : 'error' in schedule ? schedule.error : c.body !== schedule.text ? scheduledReplyPlainText : null);
  const name = engineName(task.engine);
  const delivery = schedule ? 'later' : c.delivery ?? pick ?? undefined;
  // #new picks its own engine by tag (else this task's); #fork and plain replies stay on this task's.
  const fresh = delivery === 'new';
  const branch = fresh || delivery === 'fork';
  const taskEngine = (task.engine ?? DEFAULT_ENGINE) as EngineName;
  const otherEngine = !fresh && !!c.engine && c.engine !== taskEngine;
  const modelTag = !!(c.model || c.effort);
  const problem = modelProblem(fresh ? wantedEngine(c) ?? taskEngine : taskEngine, c);
  const content = !!(c.body || c.skills.length);
  const auto = task.permission_mode === 'auto';
  const running = isRunning(task);
  const ok = !scheduleError && !otherEngine && !problem && !!(c.body || c.mode || modelTag || c.skills.length) && !(branch && !content);

  const send = async (body: string, attempt?: NonNullable<typeof scheduledAttempt.current>):Promise<({task_id:string;shared_pending?:boolean}&MessageReceipt)|null> => {
    setBusy(true);
    try { return attempt ? await api.scheduleReply(task.id, body, attempt.at, attempt.operation, attempt.session) : await api.send(task.id, body); }
    catch (e) {
      if (e instanceof SharedPending) return {task_id:task.id,shared_pending:true};
      onError(e instanceof Error ? e.message : String(e)); return null;
    }
    finally { setBusy(false); }
  };
  const promote = async (target: QueuedTarget | null) => {
    if (!target) return;
    setBusy(true);
    try {
      await api.sendQueuedNow(target.taskId, target.queuedId);
      setSent('방금 대기열에 넣은 메시지를 바로 보냈습니다.');
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const answerBusy = useRef(false);
  const submit = async (fromShortcut = false) => {
    if (answerTarget) {
      if (busy || answerBusy.current || !text.trim() || schedule) return;
      answerBusy.current = true; setBusy(true); shortcut.current.reset();
      const unchanged = revision.current, submitted = getDraft(draftKey);
      try {
        await submitAnswer(answerTarget, text);
        if (revision.current === unchanged && (mounted.current || getDraft(draftKey) === submitted)) {
          setDraft(draftKey, null, { empty: true }); setText(''); setPick(null);
        }
        setSent('답변을 반영했습니다. 여러 질문은 모든 답을 모아 보냅니다.');
      } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
      finally { answerBusy.current = false; setBusy(false); }
      return;
    }
    if (task.source === 'external') return;
    if (fromShortcut && shortcut.current.active) { await promote(shortcut.current.repeat()); return; }
    if (!ok || busy) return;
    shortcut.current.reset();
    const reservation = schedule && parseScheduledReply(text);
    if (reservation && 'error' in reservation) { onError(reservation.error); return; }
    const request = !reservation && fromShortcut && content && !branch && delivery !== 'now' ? shortcut.current.begin(task.id) : null;
    const unchanged = revision.current;
    const submittedDraft = getDraft(draftKey);
    if (!reservation) onSend?.();
    const attempt = reservation ? scheduledAttempt.current ??= { at: reservation.at, operation: workspaceOperationId(), session: task.reply_session_id } : undefined;
    const r = reservation ? await send(reservation.text, attempt) : await send(!c.delivery && pick ? `#${pick} ${text}` : text);
    if (!r) { if (request !== null) shortcut.current.finish(request); return; }
    // A closed box can clear its own draft, but must not erase one written after re-entering it.
    if (revision.current === unchanged && (mounted.current || getDraft(draftKey) === submittedDraft)) {
      setDraft(draftKey, null, { empty: true });
      scheduledAttempt.current = undefined;
      setText(''); setPick(null);
    }
    setSent(r.shared_pending ? (reservation ? '허브에 예약 요청을 보관했습니다. 공유 러너가 받으면 예약이 확정됩니다.' : new SharedPending().message) : r.task_id !== task.id ? `${delivery === 'fork' ? '포크한 ' : ''}새 작업을 시작했습니다. 피드에서 이어 볼 수 있습니다.`
      : attempt ? `${scheduledTime.format(new Date(attempt.at))}에 전송을 예약했습니다.`
      : r.answered ? '에이전트의 질문에 이 답글로 답했습니다.'
      : r.queued_id && task.runner_id?.startsWith('remote-') && task.runner_connected === false ? '메시지를 보관했습니다. 러너 재연결 후 순서대로 전달합니다.'
      : r.queued_id ? `대기열에 넣었습니다. 지금 턴이 끝나면 보냅니다.${fromShortcut ? ' 입력을 바꾸지 않고 ⌘Enter를 한 번 더 누르면 지금 보냅니다.' : ''}`
      : running && delivery !== 'now' && content ? '대기열에 넣었습니다. 지금 턴이 끝나면 보냅니다.' : null);
    if (request !== null) await promote(shortcut.current.finish(request, r.task_id === task.id ? r.queued_id : undefined));
  };

  /** Takes a queued message out of the queue into the box, above anything already typed there. */
  const editQueued = async (q: { id: string; text: string; scheduled_at?: string }) => {
    edited();
    // Preserve the original before any durable DELETE, including thread switches and timeouts.
    const message = q.scheduled_at ? scheduledReplyDraft(q.scheduled_at, q.text) : q.text;
    const next = text.trim() ? `${message}\n${text}` : message;
    setDraft(draftKey, { text: next, pick }, { taskId: task.id, empty: false });
    setText(next); setSent(null);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(message.length, message.length); });
    try { await api.cancelQueued(task.id, q.id); }
    catch (e) {
      onError(e instanceof SharedPending
        ? '편집할 내용을 입력창에 보존했습니다. 대기열 삭제는 전달 대기 중이니 항목이 사라진 뒤 다시 보내 주세요.'
        : `편집할 내용은 보존했지만 대기열에서 빼지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const how = content ? deliveryText(task, delivery) : null;
  const newMode = delivery === 'new' ? ` · 새 작업 승인 ${MODE_LABEL[c.mode ?? DEFAULT_MODE]}` : '';
  // A #new or #fork reply carries its tags into the new task instead of switching this task.
  const switches = branch ? '' : [c.mode && MODE_LABEL[c.mode], c.model && modelLabel(c.model), c.effort && `effort ${c.effort}`]
    .filter(Boolean).join(' · ');
  const note = scheduleError ? { warn: true, text: scheduleError }
    : scheduled ? { warn: false, text: scheduled.relativeMinutes
      ? `보낸 시각에서 ${scheduled.relativeMinutes}분 뒤에 전송을 예약합니다.`
      : `${scheduledTime.format(new Date(scheduled.at))}에 전송을 예약합니다.` }
    : otherEngine ? { warn: true, text: `이 작업은 ${name}로 진행 중입니다. 엔진은 새 작업에서만 고를 수 있습니다.` }
    : problem ? { warn: true, text: `${problem}.` }
    : branch && !content ? { warn: true, text: `#${delivery}로 맡길 지시를 함께 쓰세요.` }
    : switches ? { warn: false, text: `보내면 ${switches}로 전환${content ? '하고 이어서 지시합니다' : '만 합니다'}${modelTag && running ? ' (모델·effort는 다음 턴부터)' : ''}${how ? ` · ${how}` : ''}.` }
    : how ? { warn: false, text: `${how}${newMode}${c.skills.length ? ` · 스킬 ${c.skills.map((k) => `#${k}`).join(' ')}` : ''}` }
    : c.skills.length ? { warn: false, text: `이 답글에 스킬 ${c.skills.map((k) => `#${k}`).join(' ')}을 씁니다.` }
    : sent ? { warn: false, text: sent }
    : null;
  const choices: Delivery[] = running ? ['later', 'now', 'new', 'fork'] : ['new', 'fork'];
  const waitingCount = task.queued?.filter(q => !q.scheduled_at).length ?? 0;

  return (
    <div className="reply-box" data-answer-task={task.id}>
      {(task.queued ?? []).length > 0 && (
        <ol className="queued" aria-label="대기 중인 메시지">
          {(task.queued ?? []).map((q, i) => (
            <li key={q.id}>
              <span className="n">{q.scheduled_at ? `예약 ${scheduledTime.format(new Date(q.scheduled_at))}` : `대기 ${i + 1}`}</span>
              {q.kind ? <span className="t" title={q.text}>{q.kind === 'reset' ? '컨텍스트 재구성: 새 세션으로 넘기기' : '컨텍스트 재구성: 정리본 요청'}</span>
                : <span className="t" title={q.text}>{q.text}</span>}
              <span className="q-acts">
                {!q.scheduled_at && <><button className="icon-btn" disabled={i === 0} title="먼저 보내기"
                  aria-label="먼저 보내기" onClick={() => api.moveQueued(task.id, q.id, i - 1).catch((e) => onError(e.message))}><ArrowUp /></button>
                <button className="icon-btn" disabled={i === waitingCount - 1} title="나중에 보내기"
                  aria-label="나중에 보내기" onClick={() => api.moveQueued(task.id, q.id, i + 1).catch((e) => onError(e.message))}><ArrowDown /></button></>}
                {!q.kind && <>
                  <button className="link" title={running ? '실행 중인 턴에 바로 끼워넣기 (#now)' : '바로 보내기'}
                    onClick={() => { shortcut.current.reset(); api.sendQueuedNow(task.id, q.id).catch((e) => onError(e.message)); }}>지금 보내기</button>
                  {q.channel_entry_count === undefined && q.note_context_count === undefined &&
                    <button className="link" title="대기열에서 빼서 입력창에서 고치기" onClick={() => void editQueued(q)}>편집</button>}
                  {q.channel_entry_count !== undefined && <span className="muted small">채널 자료 {q.channel_entry_count}개</span>}
                  {q.note_context_count !== undefined && <span className="muted small">첨부 메모 {q.note_context_count}개</span>}
                </>}
                <button className="link" onClick={() => { shortcut.current.reset(); api.cancelQueued(task.id, q.id).catch((e) => onError(e.message)); }}>취소</button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <AnswerDestination taskId={task.id} />
      <div className="to"><b>@{name}</b>에게 답글 · {task.project_name}#{task.seq}</div>
      <ComposeField value={text} onChange={(v) => { edited(); setText(v); setSent(null); }} onSubmit={() => void submit(true)} onBlur={() => shortcut.current.reset()} inputRef={inputRef} rows={2} onBeforeResize={onBeforeResize}
        projects={projects} tasks={tasks} mentions="refer" source={splitId(task.id)[0]} runnerId={task.runner_id}
        placeholder={answerTarget ? '선택한 질문에 답하세요…' : task.source === 'external' ? '위 질문에서 대화창에서 답하기를 선택하세요…' : running ? '실행 중… 답글은 턴이 끝난 뒤 보냅니다  (#now 끼워넣기 · #new 새 작업 · #fork 포크)' : '답글로 지시하기…  (#auto 자동 승인 · #ask 매번 확인 · #스킬 · #new 새 작업 · #fork 포크)'} />
      {note && <div className={`reply-note${note.warn ? ' warn' : ''}`}>{note.text}</div>}
      <div className="reply-tools">
        {!answerTarget && task.source !== 'external' && <>
        <button className="toggle" aria-pressed={auto} disabled={busy}
          title={auto ? '누르면 #ask: 매번 확인' : '누르면 #auto: 자동 승인'}
          onClick={() => { shortcut.current.reset(); void send(auto ? '#ask' : '#auto'); }}>#auto</button>
        {choices.map((d) => (
          <button key={d} className="toggle" aria-pressed={delivery === d} disabled={!!c.delivery || !!schedule}
            title={c.delivery ? '본문의 태그를 따릅니다' : `이 답글을 #${d}: ${DELIVERY_LABEL[d]}`}
            onClick={() => { edited(); setPick(pick === d ? null : d); }}>#{d}</button>
        ))}
        {running && <button className="btn stop-btn" title="중단 (s) · 대기 중인 메시지도 취소" aria-label="중단" onClick={() => api.interrupt(task.id).catch((e) => onError(e.message))}><Square /> <kbd>s</kbd></button>}
        </>}
        <span className="spacer" />
        <span><kbd>⌘</kbd><kbd>↵</kbd></span>
        <button className="btn primary" disabled={busy || (answerTarget ? !text.trim() || !!schedule : task.source === 'external' || !ok)} onClick={() => void submit()}>{answerTarget ? '답변 반영' : schedule ? '예약' : branch ? DELIVERY_LABEL[delivery] : running && delivery !== 'now' && content ? '대기' : '답글'}</button>
      </div>
    </div>
  );
}

// ── 거절 사유 ──

export function DenyDialog({ approval, onClose, onDone }: { approval: Approval; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  const submit = async () => {
    try { await api.resolve(approval.id, false, text.trim() || undefined); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Modal title="거절 사유" onClose={onClose}>
      <div className="form">
        <blockquote className="quote"><b>{approval.tool_name}</b> 실행을 거절합니다.</blockquote>
        <textarea ref={area} className="input" rows={3} value={text} placeholder="에이전트에게 전달할 거절 사유 (비워도 됨)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (!imeKey(e.nativeEvent) && !e.defaultPrevented && !e.repeat && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <span className="muted"><kbd>⌘</kbd><kbd>↵</kbd> 거절 · Esc 취소</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn danger" onClick={submit}>거절</button>
        </div>
      </div>
    </Modal>
  );
}
