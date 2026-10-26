import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import {
  DEFAULT_ENGINE, DEFAULT_MODE, DELIVERY_LABEL, ENGINE_LABEL, MODE_LABEL, MODEL_LABEL, modelEngine, modelProblem, parseCompose, wantedEngine,
  type Delivery, type Effort, type EngineName, type ModelName,
} from '../../hub/src/compose.ts';
import { api } from './api.ts';
import { useDeskApp, useFileDrop, webDrop } from './files.ts';
import { projectColor, rankProjects } from './projects.ts';
import { useSettings } from './settings.ts';
import { useSkills } from './skills.ts';
import type { Approval, Project, Settings, Skill, TaskView } from './types.ts';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} title="닫기 (Esc)">✕</button></header>
        {children}
      </div>
    </div>
  );
}

// ── 자동 완성 ──

interface Option { key: string; insert: string; label: string; desc?: string; color?: string; space?: boolean }
/** Rows rendered in the @ list; typing narrows it further. */
const MAX_OPTIONS = 50;

const TAG_OPTIONS: Option[] = [
  { key: 'auto', insert: 'auto', label: '#auto', desc: '이제부터 자동 승인', space: true },
  { key: 'ask', insert: 'ask', label: '#ask', desc: '이제부터 매번 확인 (기본)', space: true },
  { key: 'claude', insert: 'claude', label: '#claude', desc: '새 작업을 Claude로 (기본)', space: true },
  { key: 'codex', insert: 'codex', label: '#codex', desc: '새 작업을 Codex로', space: true },
  { key: 'opus', insert: 'opus', label: '#opus', desc: 'Claude 모델을 Opus로 (작업에 유지)', space: true },
  { key: 'sonnet', insert: 'sonnet', label: '#sonnet', desc: 'Claude 모델을 Sonnet으로 (작업에 유지)', space: true },
  { key: 'haiku', insert: 'haiku', label: '#haiku', desc: 'Claude 모델을 Haiku로 (작업에 유지)', space: true },
  { key: 'sol', insert: 'sol', label: '#sol', desc: 'Codex 모델을 Sol 계열 최신으로 (작업에 유지)', space: true },
  { key: 'astra', insert: 'astra', label: '#astra', desc: 'Codex 모델을 Astra 계열 최신으로 (작업에 유지)', space: true },
  { key: 'terra', insert: 'terra', label: '#terra', desc: 'Codex 모델을 Terra 계열 최신으로 (작업에 유지)', space: true },
  { key: 'luna', insert: 'luna', label: '#luna', desc: 'Codex 모델을 Luna 계열 최신으로 (작업에 유지)', space: true },
  { key: 'low', insert: 'low', label: '#low', desc: 'effort 낮게 (작업에 유지)', space: true },
  { key: 'medium', insert: 'medium', label: '#medium', desc: 'effort 보통 (작업에 유지)', space: true },
  { key: 'high', insert: 'high', label: '#high', desc: 'effort 높게 (작업에 유지)', space: true },
  { key: 'xhigh', insert: 'xhigh', label: '#xhigh', desc: 'effort 매우 높게 (작업에 유지)', space: true },
  { key: 'max', insert: 'max', label: '#max', desc: 'effort 최대, 지원하지 않는 모델은 high (작업에 유지)', space: true },
  { key: 'ultra', insert: 'ultra', label: '#ultra', desc: 'Codex 전용 effort 최상 (작업에 유지)', space: true },
  { key: 'later', insert: 'later', label: '#later', desc: '실행 중이면 지금 턴이 끝난 뒤 보내기 (기본)', space: true },
  { key: 'now', insert: 'now', label: '#now', desc: '실행 중인 턴에 바로 끼워넣기', space: true },
  { key: 'new', insert: 'new', label: '#new', desc: '같은 프로젝트에서 새 작업 시작 (이전 대화 없이)', space: true },
  { key: 'fork', insert: 'fork', label: '#fork', desc: '이 작업의 대화를 이어받은 새 작업으로 동시에 진행', space: true },
];

/** Options for the @mention or #tag being typed just before the caret. */
function suggest(text: string, caret: number, projects: Project[], tasks: TaskView[], mentions: boolean, skills: Skill[]) {
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
      desc: last ? `› ${last.title}` : project.root_path,
    }));
    if (q && !projects.some((p) => p.name.toLowerCase() === q.toLowerCase())) {
      items.push({ key: 'new', insert: `${q}:/`, label: `@${q}:/경로`, desc: '새 프로젝트 만들기' });
    }
    return { start: caret - q.length, items, total: ranked.length };
  }
  const hash = /(^|\s)#([a-z0-9-]*)$/i.exec(before);
  if (hash) {
    const q = hash[2].toLowerCase();
    const skillOptions: Option[] = skills.map((k) => ({
      key: `skill:${k.name}`, insert: k.name, label: `#${k.name}`, desc: `스킬 · ${k.description || '설명 없음'}`, space: true,
    }));
    const items = [...TAG_OPTIONS, ...skillOptions].filter((t) => t.insert.startsWith(q) && t.insert !== q);
    return { start: caret - q.length, items, total: items.length };
  }
  return null;
}

/**
 * A textarea with @project / #tag completion. Scales to many projects: the list is filtered by
 * what is typed (name or path), ranked by recent activity, and scrolls.
 */
function ComposeField({ value, onChange, onSubmit, inputRef, projects, tasks, mentions, placeholder, rows }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  projects: Project[]; tasks: TaskView[]; mentions: boolean; placeholder: string; rows: number;
}) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const skills = useSkills();
  const sug = useMemo(() => suggest(value, caret, projects, tasks, mentions, skills), [value, caret, projects, tasks, mentions, skills]);
  const open = !dismissed && !!sug?.items.length;
  const cur = Math.min(index, (sug?.items.length ?? 1) - 1);
  const app = useDeskApp();
  const files = useFileDrop(inputRef, value, onChange);
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
    <div className={`cmp-field${files.over ? ' drop-over' : ''}`} {...browserDrop}>
      <textarea ref={inputRef} className="input" value={value} rows={rows} placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setDismissed(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setDismissed(true)} onFocus={() => setDismissed(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); return; }
          if (open && sug) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((cur + 1) % sug.items.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((cur - 1 + sug.items.length) % sug.items.length); return; }
            if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pick(sug.items[cur]); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
          }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); }
        }} />
      {!app && (
        <>
          <button type="button" className="attach" title="파일 첨부: 허브가 있는 Mac에 올리고 경로를 넣습니다"
            onClick={() => picker.current?.click()}>📎</button>
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
              </div>
            ))}
          </div>
          <div className="foot">
            ↑↓ 이동 · Tab/Enter 선택 · Esc 닫기{sug.total > MAX_OPTIONS ? ` · ${sug.total}개 중 ${MAX_OPTIONS}개, 더 입력해 좁히기` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 해석 미리보기 ──

const engineName = (e: string | null | undefined) => ENGINE_LABEL[(e ?? DEFAULT_ENGINE) as EngineName] ?? e;

interface Row { label: string; value: ReactNode; tone?: 'ok' | 'bad' | 'warn' }

const skillNames = (skills: Skill[]) => skills.map((s) => s.name);

const effortName = (e: Effort | null | undefined) => e ? `effort ${e}` : 'effort 모델 기본';

/** "Opus (태그) · effort high (기본 설정)": where the model and effort of a message come from. */
function modelRow(engine: EngineName, c: { model?: ModelName; effort?: Effort }, task: TaskView | undefined, s: Settings): string {
  const modelName = (m: ModelName | null) => m ? MODEL_LABEL[m] : `${ENGINE_LABEL[engine]} 기본`;
  const part = <T,>(tag: T | undefined, kept: T | null | undefined, def: T | null, name: (v: T | null) => string) =>
    tag ? `${name(tag)} (태그)` : task ? `${name(kept ?? null)}${kept ? ' (작업 유지)' : ''}`
      : def ? `${name(def)} (기본 설정)` : name(null);
  return `${part(c.model, task?.model, s[engine].model, modelName)} · ${part(c.effort, task?.effort, s[engine].effort, effortName)}`;
}

const isRunning = (t: TaskView) => t.status === 'running' || t.status === 'waiting';

/** What happens to a message for `task` given its delivery tag (hub.sendMessage). */
function deliveryText(task: TaskView, d: Delivery | undefined): string | null {
  if (d === 'fork') return '이 작업의 대화를 이어받은 새 작업으로 동시에 진행';
  if (d === 'new') return '같은 프로젝트에서 새 작업 시작 (이전 대화 없이)';
  if (!isRunning(task)) return d ? `실행 중이 아니라 바로 보냅니다 (#${d} 무시)` : null;
  if (d === 'now') return '실행 중인 턴에 바로 끼워넣기';
  return `지금 턴이 끝난 뒤 보내기${(task.queued ?? []).length ? ` · 앞에 ${(task.queued ?? []).length}개 대기 중` : ''}${d ? '' : ' (기본)'}`;
}

function interpretNew(text: string, projects: Project[], tasks: TaskView[], skills: Skill[], settings: Settings) {
  const c = parseCompose(text, skillNames(skills));
  const rows: Row[] = [];
  let ok = true;
  let continuing: TaskView | undefined;
  const project = c.mention && projects.find((p) => p.name.toLowerCase() === c.mention!.name.toLowerCase());
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
    continuing = tasks.filter((t) => t.project_id === project.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
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
  rows.push({ label: '승인', value: c.mode ? `${MODE_LABEL[c.mode]}로 전환` : mode ? `${MODE_LABEL[mode]} (작업 유지)` : `${MODE_LABEL[DEFAULT_MODE]} 매번 확인 (기본)` });
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

/** The drawer's unsent text, kept while it is closed (until the page reloads). */
let drawerDraft = '';

/** Left drawer for new work: `@project` continues its last task, `@name:/path` starts a project. */
export function ComposeDrawer({ projects, tasks, inputRef, onClose, onSent }: {
  projects: Project[]; tasks: TaskView[]; inputRef: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void; onSent: (task: TaskView) => void;
}) {
  const [text, setText] = useState(drawerDraft);
  useEffect(() => { drawerDraft = text; }, [text]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skills = useSkills();
  const settings = useSettings();
  const hint = useMemo(() => interpretNew(text, projects, tasks, skills, settings), [text, projects, tasks, skills, settings]);
  const recent = useMemo(() => rankProjects(projects, tasks)[0]?.project.name, [projects, tasks]);

  const submit = async () => {
    if (!hint.ok || busy) return;
    setBusy(true); setError(null);
    try {
      const task = await api.compose(text);
      setText('');
      onSent(task);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const example = (s: string) => {
    setText(s);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(s.length, s.length); });
  };

  return (
    <aside className="compose" aria-label="새 작업">
      <header className="cmp-head">
        <h2>새 작업 · 지시</h2>
        <button className="icon-btn" title="닫기" onClick={onClose}>✕</button>
      </header>
      <div className="cmp-body">
        <ComposeField value={text} onChange={setText} onSubmit={submit} inputRef={inputRef} rows={6}
          projects={projects} tasks={tasks} mentions
          placeholder={'@프로젝트 할 일\n새 프로젝트는 @이름:/경로 할 일'} />
        <Preview ok={hint.ok} rows={hint.rows} />
        {error && <p className="error">{error}</p>}
        <div className="cmp-actions">
          <span><kbd>⌘</kbd><kbd>↵</kbd> 보내기</span>
          <span className="spacer" />
          <button className="btn primary" disabled={!hint.ok || busy} onClick={submit}>게시</button>
        </div>
        <div className="examples">
          <span className="lbl">예시 넣기</span>
          {recent && <button onClick={() => example(`@${recent} 이어서 테스트를 돌리고 결과를 정리해줘`)}>@{recent} 이어서 테스트를 돌리고…</button>}
          <button onClick={() => example('@demo:/tmp/demo 간단한 README를 써줘')}>@demo:/tmp/demo 간단한 README를…</button>
          {recent && <button onClick={() => example(`@${recent} #auto 린트 오류를 모두 고쳐줘`)}>@{recent} #auto 린트 오류를…</button>}
        </div>
        <div className="syntax">
          <span className="lbl">문법</span>
          <code>@프로젝트</code><span>그 프로젝트의 마지막 작업 이어가기</span>
          <code>@프로젝트#2</code><span>그 프로젝트의 2번 작업 이어가기</span>
          <code>#new</code><span>같은 프로젝트에서 새 작업 시작 (이전 대화 없이)</span>
          <code>@이름:/경로</code><span>프로젝트를 만들고 새 작업 시작</span>
          <code>#auto</code><span>이제부터 자동 승인</span>
          <code>#ask</code><span>이제부터 매번 확인 (기본)</span>
          <code>#claude</code><span>새 작업을 Claude로 (기본)</span>
          <code>#codex</code><span>새 작업을 Codex로</span>
          <code>#opus #sonnet #haiku</code><span>Claude 모델 고르기 (작업에 유지)</span>
          <code>#sol #astra #terra #luna</code><span>Codex 모델 계열 고르기, 최신 버전 (작업에 유지)</span>
          <code>#low … #max</code><span>effort 고르기 (작업에 유지, #ultra는 Codex만)</span>
          <code>#스킬이름</code><span>데스크 스킬을 이 메시지에만 사용</span>
          <code>#later</code><span>실행 중이면 지금 턴이 끝난 뒤 보내기 (기본)</span>
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
export function ReplyBox({ task, inputRef, onError, onSend }: {
  task: TaskView; inputRef: RefObject<HTMLTextAreaElement | null>; onError: (msg: string) => void;
  /** Right before a message goes out (its event can arrive before the reply); the thread then follows it. */
  onSend?: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Delivery | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { setText(''); setPick(null); setSent(null); }, [task.id]);
  const skills = useSkills();
  const c = parseCompose(text, skillNames(skills));
  const name = engineName(task.engine);
  const delivery = c.delivery ?? pick ?? undefined;
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
  const ok = !otherEngine && !problem && !!(c.body || c.mode || modelTag || c.skills.length) && !(branch && !content);

  const send = async (body: string) => {
    setBusy(true);
    try { return await api.send(task.id, body); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!ok || busy) return;
    onSend?.();
    const r = await send(!c.delivery && pick ? `#${pick} ${text}` : text);
    if (!r) return;
    setText(''); setPick(null);
    setSent(r.task_id !== task.id ? `${delivery === 'fork' ? '포크한 ' : ''}새 작업을 시작했습니다. 피드에서 이어 볼 수 있습니다.`
      : running && delivery !== 'now' && content ? '대기열에 넣었습니다. 지금 턴이 끝나면 보냅니다.' : null);
  };

  /** Takes a queued message out of the queue into the box, above anything already typed there. */
  const editQueued = async (q: { id: string; text: string }) => {
    try { await api.cancelQueued(task.id, q.id); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); return; }
    const next = text.trim() ? `${q.text}\n${text}` : q.text;
    setText(next); setSent(null);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(q.text.length, q.text.length); });
  };

  const how = content ? deliveryText(task, delivery) : null;
  // A #new or #fork reply carries its tags into the new task instead of switching this task.
  const switches = branch ? '' : [c.mode && MODE_LABEL[c.mode], c.model && MODEL_LABEL[c.model], c.effort && `effort ${c.effort}`]
    .filter(Boolean).join(' · ');
  const note = otherEngine ? { warn: true, text: `이 작업은 ${name}로 진행 중입니다. 엔진은 새 작업에서만 고를 수 있습니다.` }
    : problem ? { warn: true, text: `${problem}.` }
    : branch && !content ? { warn: true, text: `#${delivery}로 맡길 지시를 함께 쓰세요.` }
    : switches ? { warn: false, text: `보내면 ${switches}로 전환${content ? '하고 이어서 지시합니다' : '만 합니다'}${modelTag && running ? ' (모델·effort는 다음 턴부터)' : ''}${how ? ` · ${how}` : ''}.` }
    : how ? { warn: false, text: `${how}${c.skills.length ? ` · 스킬 ${c.skills.map((k) => `#${k}`).join(' ')}` : ''}` }
    : c.skills.length ? { warn: false, text: `이 답글에 스킬 ${c.skills.map((k) => `#${k}`).join(' ')}을 씁니다.` }
    : sent ? { warn: false, text: sent }
    : null;
  const choices: Delivery[] = running ? ['later', 'now', 'new', 'fork'] : ['new', 'fork'];

  return (
    <div className="reply-box">
      {(task.queued ?? []).length > 0 && (
        <ol className="queued" aria-label="대기 중인 메시지">
          {(task.queued ?? []).map((q, i, all) => (
            <li key={q.id}>
              <span className="n">대기 {i + 1}</span>
              <span className="t" title={q.text}>{q.text}</span>
              <span className="q-acts">
                <button className="icon-btn" disabled={i === 0} title="먼저 보내기"
                  onClick={() => api.moveQueued(task.id, q.id, i - 1).catch((e) => onError(e.message))}>↑</button>
                <button className="icon-btn" disabled={i === all.length - 1} title="나중에 보내기"
                  onClick={() => api.moveQueued(task.id, q.id, i + 1).catch((e) => onError(e.message))}>↓</button>
                <button className="link" title={running ? '실행 중인 턴에 바로 끼워넣기 (#now)' : '바로 보내기'}
                  onClick={() => api.sendQueuedNow(task.id, q.id).catch((e) => onError(e.message))}>지금 보내기</button>
                <button className="link" title="대기열에서 빼서 입력창에서 고치기" onClick={() => void editQueued(q)}>편집</button>
                <button className="link" onClick={() => api.cancelQueued(task.id, q.id).catch((e) => onError(e.message))}>취소</button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="to"><b>@{name}</b>에게 답글 · {task.project_name}#{task.seq}</div>
      <ComposeField value={text} onChange={(v) => { setText(v); setSent(null); }} onSubmit={submit} inputRef={inputRef} rows={2}
        projects={[]} tasks={[]} mentions={false}
        placeholder={running ? '실행 중… 답글은 턴이 끝난 뒤 보냅니다  (#now 끼워넣기 · #new 새 작업 · #fork 포크)' : '답글로 지시하기…  (#auto 자동 승인 · #ask 매번 확인 · #스킬 · #new 새 작업 · #fork 포크)'} />
      {note && <div className={`reply-note${note.warn ? ' warn' : ''}`}>{note.text}</div>}
      <div className="reply-tools">
        <button className="toggle" aria-pressed={auto} disabled={busy}
          title={auto ? '누르면 #ask: 매번 확인' : '누르면 #auto: 자동 승인'}
          onClick={() => void send(auto ? '#ask' : '#auto')}>#auto</button>
        {choices.map((d) => (
          <button key={d} className="toggle" aria-pressed={delivery === d} disabled={!!c.delivery}
            title={c.delivery ? '본문의 태그를 따릅니다' : `이 답글을 #${d}: ${DELIVERY_LABEL[d]}`}
            onClick={() => setPick(pick === d ? null : d)}>#{d}</button>
        ))}
        {running && <button className="btn" title="중단 (s) · 대기 중인 메시지도 취소" onClick={() => api.interrupt(task.id).catch((e) => onError(e.message))}>중단 <kbd>s</kbd></button>}
        <span className="spacer" />
        <span><kbd>⌘</kbd><kbd>↵</kbd></span>
        <button className="btn primary" disabled={!ok || busy} onClick={submit}>{branch ? DELIVERY_LABEL[delivery] : running && delivery !== 'now' && content ? '대기' : '답글'}</button>
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
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
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
