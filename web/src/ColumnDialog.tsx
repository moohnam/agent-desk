import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal.tsx';
import { KIND_LABEL, STATUS_LABEL } from './format.ts';
import { projectColor, projectListLabel, rankProjects } from './projects.ts';
import type { Channel, ColumnDef, PostKind, Project, TaskStatus, TaskView } from './types.ts';

const KINDS = Object.keys(KIND_LABEL) as PostKind[];
const STATUSES: TaskStatus[] = ['running', 'waiting', 'done', 'idle', 'error'];
/** Rows rendered in the project list; typing narrows it further. */
const MAX_ROWS = 100;

function toggle<T>(list: T[], v: T) { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]; }

/** Adds a column, or edits/deletes an existing one. Empty selections mean "all". */
export function ColumnDialog({ column, projects, tasks, channels = [], onManageChannels, onClose, onSave, onDelete }: {
  column?: ColumnDef; projects: Project[]; tasks: TaskView[]; onClose: () => void;
  onSave: (c: ColumnDef) => void; onDelete?: () => void;
  channels?: Channel[]; onManageChannels?: () => void;
}) {
  const f = column?.filter ?? {};
  const [title, setTitle] = useState(column?.title ?? '');
  const [channelId, setChannelId] = useState(column?.channelId ?? '');
  const [taskIds, setTaskIds] = useState<string[]>(f.taskIds ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(f.projectIds ?? []);
  const [kinds, setKinds] = useState<PostKind[]>(f.kinds ?? []);
  const [statuses, setStatuses] = useState<TaskStatus[]>(f.statuses ?? []);
  const [query, setQuery] = useState(f.query ?? '');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fallback = channelId ? channels.find((channel) => channel.id === channelId)?.name ?? '채널'
      : taskIds.length === 1 ? tasks.find((t) => t.id === taskIds[0])?.title ?? '작업'
      : projectIds.length
      ? projectListLabel(projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? '?'))
      : kinds.length ? kinds.map((k) => KIND_LABEL[k]).join('·') : '전체';
    onSave({
      ...(column?.byTask && !channelId ? { byTask: true } : {}),
      ...(channelId ? { channelId } : {}),
      id: column?.id ?? crypto.randomUUID(),
      title: title.trim() || fallback,
      filter: channelId ? {} : {
        taskIds: taskIds.length ? taskIds : undefined,
        projectIds: projectIds.length ? projectIds : undefined,
        kinds: kinds.length ? kinds : undefined,
        statuses: statuses.length ? statuses : undefined,
        query: query.trim() || undefined,
      },
    });
  };

  return (
    <Modal title={column ? '컬럼 편집' : '컬럼 추가'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <div className="field"><label className="lbl" htmlFor="column-content">내용</label>
          <select id="column-content" className="input" value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            <option value="">에이전트 작업</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>읽기 전용 · {channel.name}</option>)}
            {channelId && !channels.some((channel) => channel.id === channelId) && <option value={channelId}>삭제된 채널</option>}
          </select>
          <p className="muted small">작업 컬럼은 아래 필터로 구성합니다. RSS·봇 컬럼은 먼저 채널 관리에서 등록한 뒤 위 목록에서 고르세요.</p>
          {onManageChannels && <button className="link" type="button" onClick={onManageChannels}>읽기 전용 채널 관리 · 봇 알림 / RSS·Atom</button>}
        </div>
        <label className="field"><span className="lbl">제목</span>
          <input ref={first} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="비우면 필터로 정함" />
        </label>
        {!channelId && <><div className="field">
          <span className="lbl">작업<small>{taskIds.length ? `${taskIds.length}개 선택` : '선택 없으면 전체'} · 스레드의 ⋯ 메뉴나 <kbd>p</kbd>로도 추가</small></span>
          <TaskPicker tasks={tasks} value={taskIds} onChange={setTaskIds} />
        </div>
        <div className="field">
          <span className="lbl">프로젝트<small>{projectIds.length ? `${projectIds.length}개 선택` : '선택 없으면 전체'}</small></span>
          <ProjectPicker projects={projects} tasks={tasks} value={projectIds} onChange={setProjectIds} />
        </div>
        <div className="field">
          <span className="lbl">글 종류<small>선택 없으면 전체</small></span>
          <div className="pills">
            {KINDS.map((k) => (
              <button key={k} type="button" className="toggle" aria-pressed={kinds.includes(k)}
                onClick={() => setKinds(toggle(kinds, k))}>{KIND_LABEL[k]}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lbl">작업 상태<small>선택 없으면 전체</small></span>
          <div className="pills">
            {STATUSES.map((s) => (
              <button key={s} type="button" className="toggle" aria-pressed={statuses.includes(s)}
                onClick={() => setStatuses(toggle(statuses, s))}>{STATUS_LABEL[s]}</button>
            ))}
          </div>
        </div>
        <label className="field"><span className="lbl">검색어<small>본문·작업 제목</small></span>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        </>}
        <div className="form-actions">
          {onDelete && <button type="button" className="btn danger" onClick={onDelete}>컬럼 삭제</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <button className="btn primary">{column ? '저장' : '추가'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface PickItem { id: string; label: string; desc: string; color: string; title?: string }

/** Projects matching the typed text, most recently active first. */
function ProjectPicker({ projects, tasks, value, onChange }: {
  projects: Project[]; tasks: TaskView[]; value: string[]; onChange: (ids: string[]) => void;
}) {
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  return (
    <Picker value={value} onChange={onChange} total={projects.length} noun="프로젝트" empty={['맞는 프로젝트가 없습니다.', '아직 프로젝트가 없습니다.']}
      find={(q) => rankProjects(projects, tasks, q).map(({ project, last }) => (
        { id: project.id, label: project.name, desc: last ? `› ${last.title}` : project.root_path, color: projectColor(project.id) }))}
      chip={(id) => { const p = byId.get(id); return { id, label: p?.name ?? '삭제된 프로젝트', desc: '', title: p?.root_path, color: projectColor(id) }; }} />
  );
}

/** Tasks matching the typed text in their title, project name or `#number`, most recently updated first. */
function TaskPicker({ tasks, value, onChange }: { tasks: TaskView[]; value: string[]; onChange: (ids: string[]) => void }) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const sorted = useMemo(() => [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [tasks]);
  const item = (t: TaskView): PickItem => (
    { id: t.id, label: t.title, desc: `${t.project_name}#${t.seq} · ${STATUS_LABEL[t.status]}`, title: t.project_name, color: projectColor(t.project_id) });
  return (
    <Picker value={value} onChange={onChange} total={tasks.length} noun="작업" empty={['맞는 작업이 없습니다.', '아직 작업이 없습니다.']}
      find={(q) => {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        return sorted.filter((t) => {
          const hay = `${t.title} ${t.project_name} ${t.project_name}#${t.seq} #${t.seq}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        }).map(item);
      }}
      chip={(id) => { const t = byId.get(id); return t ? item(t) : { id, label: '삭제된 작업', desc: '', color: 'var(--faint)' }; }} />
  );
}

/**
 * Searchable multi-select: selected items show as chips, the dropdown lists matches. Enter toggles,
 * Backspace on an empty search removes the last chip.
 */
function Picker({ value, onChange, find, chip, total, noun, empty }: {
  value: string[]; onChange: (ids: string[]) => void; find: (q: string) => PickItem[];
  chip: (id: string) => PickItem; total: number; noun: string;
  /** What the list says with no match, and with nothing at all. */
  empty: [string, string];
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const found = useMemo(() => (open ? find(q) : []), [find, q, open]);
  const rows = found.slice(0, MAX_ROWS);
  const cur = Math.min(index, Math.max(rows.length - 1, 0));

  useEffect(() => { setIndex(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.opt.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, open]);

  return (
    <div className="picker">
      <div className="picker-box" onClick={() => input.current?.focus()}>
        {value.map((id) => {
          const c = chip(id);
          return (
            <span key={id} className="pchip" title={c.title}>
              <span className="pdot" style={{ background: c.color }} />
              <span>{c.label}</span>
              <button type="button" aria-label={`${c.label} 빼기`} onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== id)); }}><X /></button>
            </span>
          );
        })}
        <input ref={input} value={q} placeholder={value.length ? '' : `${noun} 검색 (${total}개)`}
          role="combobox" aria-expanded={open}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setIndex(Math.min(cur + 1, rows.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(cur - 1, 0)); }
            else if (e.key === 'Enter') {
              // Enter picks from the list instead of submitting the form.
              if (e.nativeEvent.isComposing) return;
              if (open && rows[cur]) { e.preventDefault(); onChange(toggle(value, rows[cur].id)); setQ(''); }
            } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
            else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
          }} />
      </div>
      {open && (
        <div className="ac" role="listbox" aria-multiselectable onMouseDown={(e) => e.preventDefault()}>
          <div className="opts" ref={list}>
            {rows.map((r, i) => (
              <div key={r.id} role="option" aria-selected={value.includes(r.id)}
                className={`opt${i === cur ? ' on' : ''}`} onMouseEnter={() => setIndex(i)}
                onClick={() => { onChange(toggle(value, r.id)); setQ(''); }}>
                <span className="check">{value.includes(r.id) ? '✓' : ''}</span>
                <span className="pdot" style={{ background: r.color }} />
                <span className="k">{r.label}</span>
                <span className="d">{r.desc}</span>
              </div>
            ))}
            {!rows.length && <div className="empty">{total ? empty[0] : empty[1]}</div>}
          </div>
          <div className="foot">
            ↑↓ 이동 · Enter 선택/해제 · Esc 닫기{found.length > MAX_ROWS ? ` · ${found.length}개 중 ${MAX_ROWS}개, 더 입력해 좁히기` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
