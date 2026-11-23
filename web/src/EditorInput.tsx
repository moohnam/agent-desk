import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useEditorMode } from './editorMode.ts';
import { holdsImeEscape, imeKey, releaseImeEscape, type ImeEscapeStroke } from './keys.ts';
import { breakLine, indentationKey, indentTextarea } from './editorIndent.ts';
import { replaceFieldText } from './emacsKeys.ts';

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
  const imeEscapeDown = useRef<ImeEscapeStroke>(undefined);
  const tabFocus = useRef(false);
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
    if (!vim) { setLoaded(undefined); setFailed(false); setStartInInsert(true); escapeArmed.current = false; imeEscapeDown.current = undefined; handoff.current = undefined; return; }
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
  if (showVim) return <Loaded {...props} handoff={handoff.current} startInInsert={startInInsert}
    startEscapeArmed={escapeArmed.current} startImeEscapeDown={imeEscapeDown.current} />;

  return <>
    <textarea id={props.id} className="input" ref={attach} rows={props.rows} value={props.value} aria-label={props.label}
      placeholder={props.placeholder} disabled={props.disabled} readOnly={readOnly} autoFocus={props.autoFocus}
      aria-description="Tab 들여쓰기, Shift+Tab 내어쓰기. Ctrl+M 뒤 Tab으로 초점 이동."
      onChange={e => { if (!readOnly) props.onChange(e.target.value, e.target.selectionStart); }}
      onSelect={e => props.onSelect?.(e.currentTarget.selectionStart)}
      onFocus={props.onFocus} onBlur={() => {
        escapeArmed.current = false; imeEscapeDown.current = undefined; tabFocus.current = false; props.onBlur?.();
      }}
      onPointerDown={() => { escapeArmed.current = false; }}
      onCompositionStart={() => { composingNow.current = true; setComposing(true); }}
      onCompositionEnd={() => { composingNow.current = false; setComposing(false); }}
      onKeyUp={e => { imeEscapeDown.current = releaseImeEscape(imeEscapeDown.current, e.nativeEvent); }}
      onKeyDown={e => {
        const escape = e.key === 'Escape' || (e.code === 'Escape' && imeKey(e.nativeEvent));
        if (pending && escape && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const plain = !imeKey(e.nativeEvent) && !composingNow.current;
          if (!e.repeat && !holdsImeEscape(imeEscapeDown.current, e.nativeEvent)) {
            if (!startInInsert && escapeArmed.current && plain) e.currentTarget.blur();
            else {
              imeEscapeDown.current = true;
              escapeArmed.current = true;
              setStartInInsert(false);
            }
          }
          if (plain) e.preventDefault();
          e.stopPropagation();
          return;
        }
        imeEscapeDown.current = undefined;
        escapeArmed.current = false;
        if (!composingNow.current && !imeKey(e.nativeEvent) && e.ctrlKey && e.code === 'KeyM' &&
          !e.shiftKey && !e.altKey && !e.metaKey && !e.defaultPrevented) {
          tabFocus.current = true;
          e.preventDefault();
          return;
        }
        if (tabFocus.current && e.key === 'Tab') { tabFocus.current = false; return; }
        if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) tabFocus.current = false;
        props.onKey?.(e.nativeEvent, { insert: !readOnly, leave: !pending });
        if (readOnly || composingNow.current) return;
        const key = indentationKey(e.nativeEvent);
        if (!key) return;
        const input = e.currentTarget;
        if (key === 'newline') {
          const { from, to, insert } = breakLine(input.value, input.selectionStart, input.selectionEnd);
          if (insert === '\n') return; // Use native editing for a plain newline.
          e.preventDefault();
          replaceFieldText(input, from, to, insert);
          return;
        }
        e.preventDefault();
        const edit = indentTextarea(key, input.value, input.selectionStart, input.selectionEnd);
        if (edit) replaceFieldText(input, edit.from, edit.to, edit.insert, edit);
      }} />
    {vim && <div className="editor-mode muted small" role="status">{failed ? 'Vim 편집기를 불러오지 못했습니다. 기본 입력창을 사용 중입니다.' : 'Vim 편집기를 불러오는 중입니다.'}</div>}
  </>;
}
