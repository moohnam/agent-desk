import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { Modal } from './Modal.tsx';
import { refreshSkills, useSkills } from './skills.ts';
import type { Skill } from './types.ts';

const SCRIPT_TEMPLATE = '#!/usr/bin/env bash\nset -euo pipefail\n\n';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Two clicks to delete: the first arms the button, the second acts. */
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  return (
    <button className="btn danger" onClick={() => (armed ? onDelete() : setArmed(true))}>
      {armed ? '한 번 더 누르면 삭제' : label}
    </button>
  );
}

function NewSkill({ onCreated }: { onCreated: (s: Skill) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const s = await api.createSkill(name.trim(), desc.trim());
      setName(''); setDesc('');
      await refreshSkills();
      onCreated(s);
    } catch (e) { setError(message(e)); }
  };
  return (
    <div className="sk-new">
      <input className="input" placeholder="이름 (예: review)" value={name}
        onChange={(e) => setName(e.target.value.toLowerCase())} />
      <input className="input" placeholder="언제 쓰는 스킬인지 한 줄 설명" value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      <button className="btn primary" disabled={!name.trim()} onClick={submit}>새 스킬</button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Lists the desk skills and edits their files. Skills live in one directory that Claude (as the
 * `desk` plugin) and Codex (as an extra skills root) both read; `#<name>` in a message uses one.
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const skills = useSkills();
  const [sel, setSel] = useState<string | null>(null);
  const [path, setPath] = useState('SKILL.md');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const skill = skills.find((s) => s.name === sel) ?? null;
  const dirty = content !== saved;

  useEffect(() => { if (!sel && skills.length) setSel(skills[0].name); }, [skills, sel]);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    setError(null); setNote(null);
    api.readSkillFile(sel, path)
      .then((f) => { if (live) { setContent(f.content); setSaved(f.content); } })
      .catch((e) => { if (live) { setContent(''); setSaved(''); setError(message(e)); } });
    return () => { live = false; };
  }, [sel, path]);

  const leave = () => !dirty || confirm('저장하지 않은 변경이 있습니다. 버릴까요?');
  const open = (name: string, file = 'SKILL.md') => { if (leave()) { setSel(name); setPath(file); } };

  const save = async () => {
    if (!sel) return;
    setError(null);
    try {
      await api.writeSkillFile(sel, path, content);
      setSaved(content);
      setNote('저장했습니다');
      await refreshSkills();
    } catch (e) { setError(message(e)); }
  };

  const addFile = async () => {
    const p = newPath.trim().replace(/^\/+/, '');
    if (!sel || !p || !leave()) return;
    setError(null);
    try {
      await api.writeSkillFile(sel, p, p.startsWith('scripts/') || /\.(sh|bash)$/.test(p) ? SCRIPT_TEMPLATE : '');
      setNewPath('');
      await refreshSkills();
      setPath(p);
      requestAnimationFrame(() => editor.current?.focus());
    } catch (e) { setError(message(e)); }
  };

  const removeFile = async () => {
    if (!sel) return;
    try { await api.deleteSkillFile(sel, path); await refreshSkills(); setPath('SKILL.md'); }
    catch (e) { setError(message(e)); }
  };

  const removeSkill = async () => {
    if (!sel) return;
    try { await api.deleteSkill(sel); setSel(null); setPath('SKILL.md'); await refreshSkills(); }
    catch (e) { setError(message(e)); }
  };

  return (
    <Modal title="스킬" wide onClose={() => { if (leave()) onClose(); }}>
      <div className="skills">
        <aside className="sk-list">
          <NewSkill onCreated={(s) => open(s.name)} />
          {skills.length === 0 && <p className="muted">아직 스킬이 없습니다. 이름과 설명을 넣어 만드세요.</p>}
          {skills.map((s) => (
            <button key={s.name} className={`sk-item${s.name === sel ? ' on' : ''}`} onClick={() => s.name !== sel && open(s.name)}>
              <span className="k">#{s.name}</span>
              <span className="d">{s.error ?? (s.description || '설명 없음')}</span>
            </button>
          ))}
        </aside>
        {skill ? (
          <section className="sk-main">
            <div className="sk-head">
              <code>#{skill.name}</code>
              <span className="muted">작성창·답글에 쓰면 그 메시지에만 이 스킬을 적용합니다 (Claude·Codex 공통)</span>
              <span className="spacer" />
              <DeleteButton label="스킬 삭제" onDelete={removeSkill} />
            </div>
            <div className="sk-files">
              {skill.files.map((f) => (
                <button key={f.path} className={`sk-file${f.path === path ? ' on' : ''}`}
                  title={`${f.size} bytes${f.executable ? ' · 실행 가능' : ''}`}
                  onClick={() => f.path !== path && leave() && setPath(f.path)}>
                  {f.path}{f.executable ? ' *' : ''}
                </button>
              ))}
              <input className="input sk-path" placeholder="새 파일 (예: scripts/run.sh)" value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addFile(); }} />
              <button className="btn" disabled={!newPath.trim()} onClick={addFile}>추가</button>
            </div>
            <textarea ref={editor} className="input sk-editor" spellCheck={false} value={content}
              onChange={(e) => { setContent(e.target.value); setNote(null); }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyS' || e.key === 'Enter')) { e.preventDefault(); void save(); }
              }} />
            <div className="form-actions">
              {error ? <p className="error">{error}</p>
                : <span className="muted">{note ?? (path === 'SKILL.md'
                  ? '맨 앞 --- 블록의 name·description은 필수입니다. 에이전트는 description을 보고 스킬을 고릅니다.'
                  : path.startsWith('scripts/') ? 'scripts/ 아래 파일은 실행 권한을 붙여 저장합니다.' : '')}</span>}
              <span className="spacer" />
              {path !== 'SKILL.md' && <DeleteButton label="파일 삭제" onDelete={removeFile} />}
              <span className="muted"><kbd>⌘</kbd><kbd>S</kbd></span>
              <button className="btn primary" disabled={!dirty} onClick={save}>저장</button>
            </div>
          </section>
        ) : (
          <section className="sk-main sk-empty muted">왼쪽에서 스킬을 고르거나 새로 만드세요.</section>
        )}
      </div>
    </Modal>
  );
}
