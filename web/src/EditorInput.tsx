import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useEditorMode } from './editorMode.ts';
import { imeKey } from './keys.ts';

export type DeskInput = HTMLTextAreaElement | {
  element: HTMLElement;
  selectionStart: number;
  selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  replaceRange(from: number, to: number, text: string): void;
};

export const deskInputSelector = 'textarea, [data-desk-input]';
export const inputElement = (input: DeskInput | null) => input && ('element' in input ? input.element : input);
export const editorText = (text: string) => text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;

export interface EditorProps {
  inputRef: RefObject<DeskInput | null>;
  id: string;
  rows: number;
  value: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange(value: string, caret: number): void;
  onSelect?(caret: number): void;
  onFocus?(): void;
  onBlur?(): void;
  onMode?(insert: boolean): void;
  onKey?(event: KeyboardEvent, context: { insert: boolean; leave: boolean }): void;
}

type VimInput = typeof import('./VimInput.tsx').VimInput;
let loadedVim: VimInput | undefined;
let loading: Promise<VimInput> | undefined;
const loadVim = () => loading ??= import('./VimInput.tsx').then(module => loadedVim = module.VimInput).catch(error => {
  loading = undefined;
  throw error;
});

export function EditorInput(props: EditorProps) {
  const { inputRef, onMode } = props;
  const vim = useEditorMode() === 'vim';
  const [Loaded, setLoaded] = useState(() => vim ? loadedVim : undefined);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);
  const composingNow = useRef(false);
  const [startInInsert, setStartInInsert] = useState(true);
  const escapeArmed = useRef(false);
  const native = useRef<HTMLTextAreaElement>(null);
  const handoff = useRef<{ focused: boolean; start: number; end: number }>(undefined);
  const attach = useCallback((element: HTMLTextAreaElement | null) => {
    if (element) {
      native.current = element;
      inputRef.current = element;
    } else {
      const input = native.current;
      const target = handoff.current;
      if (input && target) {
        target.focused = input === document.activeElement;
        target.start = input.selectionStart;
        target.end = input.selectionEnd;
      }
      if (inputRef.current === input) inputRef.current = null;
      native.current = null;
    }
  }, [inputRef]);
  useEffect(() => {
    if (!vim) { setLoaded(undefined); setFailed(false); setStartInInsert(true); escapeArmed.current = false; handoff.current = undefined; return; }
    if (composing || Loaded) return;
    let active = true;
    void loadVim().then(component => {
      if (!active || composingNow.current) return;
      const input = native.current;
      handoff.current = input ? { focused: input === document.activeElement, start: input.selectionStart, end: input.selectionEnd } : undefined;
      setLoaded(() => component);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [vim, composing, Loaded]);
  const showVim = vim && !!Loaded;
  const pending = vim && !failed;
  const readOnly = pending && !startInInsert && !composing;
  useEffect(() => { if (!showVim) onMode?.(!readOnly); }, [showVim, readOnly, onMode]);
  if (showVim) return <Loaded {...props} handoff={handoff.current} startInInsert={startInInsert} startEscapeArmed={escapeArmed.current} />;

  return <>
    <textarea id={props.id} className="input" ref={attach} rows={props.rows} value={props.value} aria-label={props.label}
      placeholder={props.placeholder} disabled={props.disabled} readOnly={readOnly} autoFocus={props.autoFocus}
      onChange={e => { if (!readOnly) props.onChange(e.target.value, e.target.selectionStart); }}
      onSelect={e => props.onSelect?.(e.currentTarget.selectionStart)}
      onFocus={props.onFocus} onBlur={() => { escapeArmed.current = false; props.onBlur?.(); }}
      onPointerDown={() => { escapeArmed.current = false; }}
      onCompositionStart={() => { composingNow.current = true; setComposing(true); }}
      onCompositionEnd={() => { composingNow.current = false; setComposing(false); }}
      onKeyDown={e => {
        if (!pending) { props.onKey?.(e.nativeEvent, { insert: true, leave: true }); return; }
        const escape = e.key === 'Escape' || (e.code === 'Escape' && imeKey(e.nativeEvent));
        if (escape && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const plain = !imeKey(e.nativeEvent) && !composingNow.current;
          if (!e.repeat) {
            if (!startInInsert && escapeArmed.current && plain) e.currentTarget.blur();
            else { escapeArmed.current = true; setStartInInsert(false); }
          }
          if (plain) e.preventDefault();
          e.stopPropagation();
          return;
        }
        escapeArmed.current = false;
        props.onKey?.(e.nativeEvent, { insert: !readOnly, leave: false });
      }} />
    {vim && <div className="editor-mode muted small" role="status">{failed ? 'Vim 편집기를 불러오지 못했습니다. 기본 입력창을 사용 중입니다.' : 'Vim 편집기를 불러오는 중입니다.'}</div>}
  </>;
}
