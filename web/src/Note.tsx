import { imeKey } from './keys.ts';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { api } from './api.ts';
import { EditorInput, type DeskInput } from './EditorInput.tsx';
import { ResizableEditor } from './Compose.tsx';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';
import type { Post, TaskView } from './types.ts';
import { SharedPending } from './workspace.ts';

function closeOnEscape(event: KeyboardEvent<HTMLFormElement>, close: () => void) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey
    || imeKey(event.nativeEvent)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) close();
}

function noteKey(event: globalThis.KeyboardEvent, leave: boolean, submit: () => Promise<void>, close: () => void) {
  if (imeKey(event) || event.defaultPrevented) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!event.repeat) void submit();
  } else if (event.key === 'Escape' && leave && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) close();
  }
}

export function NoteReply({ task, inputRef, onError, onSend, onEscape, onBeforeResize }: {
  task: TaskView; inputRef: RefObject<DeskInput | null>;
  onError: (message: string) => void; onSend?: () => void; onEscape: () => void;
  onBeforeResize?: () => (() => void) | undefined;
}) {
  const key = `reply:${task.id}`;
  const [text, setText] = useState(() => getDraft<{ text: string }>(key)?.text ?? '');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const sending = useRef(false);
  const mounted = useRef(false);
  const edit = (value: string) => { revision.current++; setText(value); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(key, { text }, { taskId: task.id, empty: !text.trim() }); }, [key, task.id, text]);
  useDraftSync<{ text: string }>(key, (draft) => edit(draft?.text ?? ''));

  const submit = async () => {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    const unchanged = revision.current;
    const draft = getDraft(key);
    const clearSubmitted = () => {
      if (revision.current !== unchanged || (!mounted.current && getDraft(key) !== draft)) return;
      setDraft(key, null, { empty: true });
      if (mounted.current) setText('');
    };
    onSend?.();
    try {
      await api.writeNote(task.id, text);
      clearSubmitted();
    } catch (error) {
      if (error instanceof SharedPending) clearSubmitted();
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <form className="reply-box" onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => closeOnEscape(event, onEscape)}>
    <ResizableEditor inputRef={inputRef} rows={2} onBeforeResize={onBeforeResize}>{({ id, rows }) => <div className="cmp-field">
      <EditorInput id={id} rows={rows} inputRef={inputRef} value={text} label="메모 글" placeholder="메모를 작성하세요"
        onChange={edit} onKey={(event, mode) => noteKey(event, mode.leave, submit, onEscape)} />
    </div>}</ResizableEditor>
    <div className="reply-tools">
      <span><kbd>⌘</kbd><kbd>↵</kbd> 게시</span><span className="spacer" />
      <button className="btn primary" type="submit" disabled={busy || !text.trim()}>게시</button>
    </div>
  </form>;
}

export function NoteEditor({ post, onClose, onError }: { post: Post; onClose: () => void; onError?: (message: string) => void }) {
  const [text, setText] = useState(() => String(post.event.payload.text ?? ''));
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<DeskInput>(null);
  const saving = useRef(false);
  const submit = async () => {
    if (saving.current || !text.trim()) return;
    if (text === post.event.payload.text) { onClose(); return; }
    saving.current = true;
    setBusy(true);
    try {
      await api.editNote(post.taskId, post.id, text);
      onClose();
    } catch (error) {
      if (error instanceof SharedPending) onClose();
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => closeOnEscape(event, () => { if (!busy) onClose(); })}>
    <ResizableEditor inputRef={inputRef} rows={4} resizeFrom="bottom">{({ id, rows }) => <div className="cmp-field">
      <EditorInput id={id} rows={rows} inputRef={inputRef} autoFocus value={text} disabled={busy} label="메모 글 수정"
        onChange={setText} onKey={(event, mode) => noteKey(event, mode.leave, submit, onClose)} />
    </div>}</ResizableEditor>
    <div className="reply-tools">
      <span className="spacer" />
      <button className="btn" type="button" disabled={busy} onClick={onClose}>취소</button>
      <button className="btn primary" type="submit" disabled={busy || !text.trim()}>저장</button>
    </div>
  </form>;
}
