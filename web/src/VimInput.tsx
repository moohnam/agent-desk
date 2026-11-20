import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Annotation, Compartment, EditorState, Prec, Transaction, type Text } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import { editorText, type DeskInput, type EditorProps } from './EditorInput.tsx';
import { imeKey, latinKey } from './keys.ts';

type Mode = 'insert' | 'normal' | 'visual' | 'replace';
const labels: Record<Mode, string> = { insert: '입력', normal: '일반', visual: '선택', replace: '바꾸기' };
const fromDesk = Annotation.define<boolean>();
const webkit = /AppleWebKit/.test(navigator.userAgent) && !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);
const delayedImeCommit = webkit || /Android/.test(navigator.userAgent);
const koreanLetters = 'ㅁㅠㅊㅇㄷㄹㅎㅗㅑㅓㅏㅣㅡㅜㅐㅔㅂㄱㄴㅅㅕㅍㅈㅌㅛㅋ';
const shiftedKoreanLetters: Record<string, string> = { ㅃ: 'Q', ㄸ: 'E', ㄲ: 'R', ㅆ: 'T', ㅉ: 'W', ㅒ: 'O', ㅖ: 'P' };
const imePairMs = 100;
const vimMotionLetter = /^[hjklwbeWBE]$/;
const hangulText = /^\p{Script=Hangul}+$/u;
function koreanLetter(key: string) {
  if (key.length !== 1) return undefined;
  const index = koreanLetters.indexOf(key);
  return shiftedKoreanLetters[key] ?? (index < 0 ? undefined : String.fromCharCode(97 + index));
}
type CommandStroke = { key: string; ime: boolean; repeat: boolean; at: number; composing?: boolean };
function sameImeText(stroke: CommandStroke | undefined, text: string | null): stroke is CommandStroke {
  return !!stroke && text != null && performance.now() - stroke.at < imePairMs &&
    (text === stroke.key || koreanLetter(text)?.toLowerCase() === stroke.key.toLowerCase());
}

export function VimInput(props: EditorProps & { handoff?: { focused: boolean; start: number; end: number }; startInInsert: boolean; startEscapeArmed: boolean }) {
  const { inputRef, disabled = false, label, placeholder: hint } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const latest = useRef(props);
  latest.current = props;
  const sent = useRef(props.value);
  const settings = useRef(new Compartment());
  const editHistory = useRef(new Compartment());
  const nativeInput = useRef(new Compartment());
  const compositionEnd = useRef(-Infinity);
  const exitAfterComposition = useRef(false);
  const settlingEscape = useRef<{ text?: string }>(undefined);
  const escapeArmed = useRef(props.startEscapeArmed);
  const resumeInsert = useRef<{ doc: Text; normal: number; insert: number }>(undefined);
  const heldCommands = useRef(new Map<string, CommandStroke>());
  const lastImeCommand = useRef<CommandStroke>(undefined);
  const discardedComposition = useRef<{ text: string; at: number }>(undefined);
  const [mode, setMode] = useState<Mode>(props.startInInsert ? 'insert' : 'normal');
  const config = () => [
    EditorState.readOnly.of(latest.current.disabled ?? false),
    latest.current.placeholder ? placeholder(latest.current.placeholder) : [],
    EditorView.contentAttributes.of({
      'data-desk-input': '', tabindex: latest.current.disabled ? '-1' : '0',
      'aria-label': latest.current.label ?? latest.current.placeholder ?? '대화 입력',
    }),
  ];

  const syncNativeInput = (editor: EditorView) => {
    if (view.current !== editor) return;
    const state = getCM(editor)?.state.vim;
    const editable = !latest.current.disabled && !!(state?.insertMode || state?.expectLiteralNext);
    if (editor.state.facet(EditorView.editable) !== editable) {
      editor.dispatch({ effects: nativeInput.current.reconfigure(EditorView.editable.of(editable)) });
    }
  };

  useLayoutEffect(() => {
    if (!host.current) return;
    const initial = latest.current;
    const doc = editorText(initial.value);
    sent.current = doc;
    const { start = doc.length, end = start, focused } = initial.handoff ?? {};
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        selection: { anchor: Math.min(start, doc.length), head: Math.min(end, doc.length) },
        extensions: [
          vim(), drawSelection(), editHistory.current.of(history()), keymap.of(historyKeymap),
          EditorView.lineWrapping, EditorState.allowMultipleSelections.of(true),
          settings.current.of(config()),
          // The browser must not maintain a composing text input in command mode.
          // Vim commands can still edit the document through CodeMirror transactions.
          nativeInput.current.of(EditorView.editable.of(false)),
          Prec.highest(EditorView.inputHandler.of((current, _from, _to, text) => {
            const stroke = lastImeCommand.current;
            const cm = getCM(current);
            const state = cm?.state.vim;
            if (!state) return false;
            // In Normal/Visual mode CodeMirror Vim's text fallback detaches the editor
            // to end an IME composition. A stray Korean composition is not an edit.
            const discarded = discardedComposition.current;
            const trailingText = discarded?.text === text && performance.now() - discarded.at < imePairMs;
            if (!state.insertMode && !state.exMode && !state.expectLiteralNext && !cm?.state.dialog &&
                (trailingText || (current.compositionStarted && (hangulText.test(text) || vimMotionLetter.test(text))))) {
              if (sameImeText(stroke, text)) stroke.composing = true;
              const composing = current.compositionStarted;
              if (composing) discardedComposition.current = { text, at: performance.now() };
              current.dispatch({ selection: current.state.selection });
              if (composing) queueMicrotask(() => {
                if (view.current === current && current.compositionStarted && !state.insertMode && !state.expectLiteralNext) {
                  current.contentDOM.dispatchEvent(new CompositionEvent('compositionend'));
                }
              });
              return true;
            }
            // Some IMEs emit composition text even after a handled keydown. Do not feed
            // that same character to Vim a second time through its text-input fallback.
            if (!sameImeText(stroke, text)) return false;
            stroke.composing ||= current.compositionStarted;
            if (!stroke.composing && (state.insertMode || state.expectLiteralNext)) return false;
            // Redraw from the authoritative selection instead of leaving provisional IME DOM behind.
            current.dispatch({ selection: current.state.selection });
            return true;
          })),
          // Vim sees literal arguments and supported native keys first. Any unhandled
          // DOM edit in command mode must not reach CodeMirror's default insertion.
          Prec.lowest(EditorView.inputHandler.of((current, _from, _to, text) => {
            const cm = getCM(current);
            const state = cm?.state.vim;
            if (!state || state.insertMode || state.exMode || cm?.state.dialog ||
                (state.expectLiteralNext && current.composing && text.length === 1)) return false;
            current.dispatch({ selection: current.state.selection });
            return true;
          })),
          Prec.highest(EditorView.domEventHandlers({ beforeinput(event) {
            const settling = settlingEscape.current;
            // A late IME commit may still belong to the previous insertion.
            return !!settling && !event.isComposing && event.inputType !== 'insertCompositionText' &&
              event.inputType !== 'insertFromComposition' && event.data !== settling.text;
          } })),
          EditorView.domEventObservers({ beforeinput(event, current) {
            const stroke = lastImeCommand.current;
            if (event.isComposing || !sameImeText(stroke, event.data) || !stroke.composing) return;
            queueMicrotask(() => {
              // Rejected composition text can leave CodeMirror waiting for a compositionend.
              if (view.current === current && lastImeCommand.current === stroke && current.compositionStarted) {
                current.contentDOM.dispatchEvent(new CompositionEvent('compositionend'));
              }
            });
          } }),
          EditorView.updateListener.of(update => {
            const caret = update.state.selection.main.head;
            if (update.docChanged) {
              sent.current = update.state.doc.toString();
              if (!update.transactions.every(tr => tr.annotation(fromDesk))) {
                latest.current.onChange(sent.current, caret);
              } else if (update.selectionSet) latest.current.onSelect?.(caret);
            } else if (update.selectionSet && getCM(update.view)?.state.vim?.insertMode) latest.current.onSelect?.(caret);
          }),
        ],
      }),
    });
    view.current = editor;
    const cm = getCM(editor)!;
    const afterVimKey = () => queueMicrotask(() => syncNativeInput(editor));
    cm.on('vim-keypress', afterVimKey);
    cm.on('vim-command-done', afterVimKey);
    cm.on('vim-mode-change', ({ mode: next }: { mode: Mode }) => {
      setMode(next);
      latest.current.onMode?.(next === 'insert' || next === 'replace');
      if (next === 'insert' || next === 'replace') latest.current.onSelect?.(editor.state.selection.main.head);
      afterVimKey();
    });
    if (initial.startInInsert) Vim.handleKey(cm, 'i', 'script');
    else initial.onMode?.(false);
    syncNativeInput(editor);
    const replaceRange = (from: number, to: number, insert: string) => {
      if (latest.current.disabled) return;
      const length = editor.state.doc.length;
      const start = Math.min(from, length);
      const text = editorText(insert);
      editor.dispatch({ changes: { from: start, to: Math.min(to, length), insert: text }, selection: { anchor: start + text.length },
        annotations: isolateHistory.of('full'), scrollIntoView: true });
    };
    const handle: DeskInput = {
      element: editor.contentDOM,
      get selectionStart() { return editor.state.selection.main.from; },
      get selectionEnd() { return editor.state.selection.main.to; },
      focus: () => editor.focus(),
      setSelectionRange: (anchor: number, head: number) => {
        const length = editor.state.doc.length;
        editor.dispatch({ selection: { anchor: Math.min(length, anchor), head: Math.min(length, head) }, scrollIntoView: true });
      },
      replaceRange,
    };
    inputRef.current = handle;
    if (focused || (initial.autoFocus && !initial.handoff)) editor.focus();
    return () => {
      if (inputRef.current === handle) inputRef.current = null;
      view.current = null;
      editor.destroy();
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    const editor = view.current;
    const doc = editorText(latest.current.value);
    if (!editor || doc === sent.current) return;
    const { anchor, head } = editor.state.selection.main;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: doc },
      selection: { anchor: Math.min(anchor, doc.length), head: Math.min(head, doc.length) },
      effects: editHistory.current.reconfigure([]),
      annotations: [fromDesk.of(true), Transaction.addToHistory.of(false)],
    });
    // A send or a draft update from another window starts a new editing history.
    editor.dispatch({ effects: editHistory.current.reconfigure(history()) });
  }, [props.value]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: settings.current.reconfigure(config()) });
    syncNativeInput(editor);
  }, [disabled, label, hint]);

  const leaveAfterIme = (editor: EditorView) => {
    const cm = getCM(editor);
    if (!cm?.state.vim?.insertMode) return;
    const { doc, selection } = editor.state;
    Vim.multiSelectHandleKey(cm, '<Esc>', 'user');
    const normal = editor.state.selection.main.head;
    // Preserve Vim's Normal-mode cursor for motions and operators. A direct return to Insert
    // restores the insertion point the IME had just used, before Vim moved one character back.
    resumeInsert.current = !cm.state.vim?.insertMode && selection.main.empty && editor.state.doc === doc && normal !== selection.main.head
      ? { doc, normal, insert: selection.main.head } : undefined;
  };
  const leaveAfterComposition = (editor: EditorView, text?: string) => {
    const settling = { text };
    settlingEscape.current = settling;
    const finish = () => {
      if (settlingEscape.current !== settling) return;
      settlingEscape.current = undefined;
      if (view.current === editor && editor.hasFocus && !editor.compositionStarted) leaveAfterIme(editor);
    };
    // CodeMirror processes queued composition mutations before this microtask.
    // Keep the measurement boundary on platforms that can deliver the commit later.
    if (delayedImeCommit) editor.requestMeasure({ read: () => undefined, write: () => queueMicrotask(finish) });
    else queueMicrotask(finish);
  };

  return <div className="vim-field" data-editor-mode="vim" id={props.id}
    style={{ '--editor-rows': props.rows } as CSSProperties}
    onPointerDown={() => { escapeArmed.current = false; }}
    onFocus={e => { if (!e.currentTarget.contains(e.relatedTarget)) props.onFocus?.(); }}
    onBlur={e => {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        exitAfterComposition.current = false;
        settlingEscape.current = undefined;
        escapeArmed.current = false;
        resumeInsert.current = undefined;
        heldCommands.current.clear();
        lastImeCommand.current = undefined;
        discardedComposition.current = undefined;
        props.onBlur?.();
      }
    }}
    onCompositionStartCapture={() => {
      const editor = view.current;
      if (!settlingEscape.current || !editor) return;
      // A new composition must see the requested Normal mode, even before the next frame.
      settlingEscape.current = undefined;
      leaveAfterIme(editor);
    }}
    onCompositionEndCapture={e => { if (e.nativeEvent.isTrusted) compositionEnd.current = performance.now(); }}
    onCompositionEnd={e => {
      if (!exitAfterComposition.current) return;
      exitAfterComposition.current = false;
      const editor = view.current;
      // CodeMirror reads the final IME edit and selection before the measurement callback.
      if (editor) leaveAfterComposition(editor, e.data);
    }}
    onKeyDown={e => {
      // Some Escape actions clear Vim state without marking the native event handled.
      if (e.key === 'Escape') e.stopPropagation();
    }}
    onKeyUpCapture={e => {
      heldCommands.current.delete(e.code);
      const korean = koreanLetter(e.key);
      if (korean) heldCommands.current.delete(`Key${korean.toUpperCase()}`);
    }}
    onKeyDownCapture={e => {
      const editor = view.current;
      if (!editor || e.target !== editor.contentDOM || disabled) return;
      const cm = getCM(editor);
      const state = cm?.state.vim;
      const event = e.nativeEvent;
      const escape = (e.key === 'Escape' || (e.code === 'Escape' && imeKey(event))) &&
        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      const secondEscape = escape && escapeArmed.current;
      if (!escape || !e.repeat) escapeArmed.current = false;
      // WebKit may send the IME confirmation key immediately after compositionend.
      const recentComposition = webkit && performance.now() - compositionEnd.current < 100;
      const hasPhysicalLetter = /^Key[A-Z]$/.test(event.code);
      const physicalLetter = hasPhysicalLetter && (event.key === 'Process' || event.key === 'Unidentified' || event.keyCode === 229);
      const korean = koreanLetter(event.key);
      const imeLetter = physicalLetter || !!korean;
      const opaqueKey = physicalLetter && event.key.length !== 1;
      const key = korean && !hasPhysicalLetter ? (event.shiftKey ? korean.toUpperCase() : korean) : latinKey(event);
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented;
      const strokeCode = hasPhysicalLetter ? event.code : /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : '';
      const now = performance.now();
      const held = strokeCode ? heldCommands.current.get(strokeCode) : undefined;
      if (bare && held && held.ime !== opaqueKey && held.key === key && held.repeat === e.repeat && now - held.at < imePairMs) {
        heldCommands.current.delete(strokeCode);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key !== 'Shift') lastImeCommand.current = undefined;
      const pending = state?.inputState;
      // A movement from a known physical key can run even while the IME is still
      // finishing a composition that started in command mode. Operators stay guarded.
      const imeMotion = imeLetter && vimMotionLetter.test(key) && !pending?.operator && !pending?.registerName &&
        !pending?.keyBuffer.some(part => !/^\d$/.test(part));
      const command = cm && state && !state.insertMode && !state.exMode && !state.expectLiteralNext && !cm.state.dialog &&
        bare && (imeMotion || (!event.isComposing && !editor.compositionStarted && (!recentComposition || !imeLetter)));
      if (command && strokeCode && /^[A-Za-z]$/.test(key)) {
        const stroke = { key, ime: opaqueKey, repeat: e.repeat, at: now };
        heldCommands.current.set(strokeCode, stroke);
        if (imeLetter) lastImeCommand.current = stroke;
      }
      if (escape && state?.insertMode && editor.compositionStarted) {
        if (!e.repeat) { exitAfterComposition.current = true; escapeArmed.current = true; }
        e.stopPropagation();
        return;
      }
      if (escape && e.repeat) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Enter' && (imeKey(event) || editor.compositionStarted ||
        recentComposition)) { e.stopPropagation(); return; }
      if (escape && cm && state?.insertMode && !e.repeat) {
        const head = editor.state.selection.main.head;
        const before = editor.state.sliceDoc(Math.max(0, head - 1), head);
        if (recentComposition || /\p{Script=Hangul}/u.test(before)) {
          props.onKey?.(event, { insert: true, leave: false });
          if (!event.defaultPrevented) {
            escapeArmed.current = true;
            if (recentComposition) leaveAfterComposition(editor);
            else leaveAfterIme(editor);
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      if (e.key === 'Escape' && (imeKey(event) || editor.compositionStarted ||
        recentComposition)) { e.stopPropagation(); return; }
      if (secondEscape && state && !state.insertMode && !state.visualMode && !state.exMode && !cm?.state.dialog &&
          !pending?.operator && !pending?.registerName && !pending?.keyBuffer.length && !pending?.prefixRepeat.length) {
        e.preventDefault();
        e.stopPropagation();
        editor.contentDOM.blur();
        return;
      }
      const resume = resumeInsert.current;
      if (resume && cm && !state?.insertMode && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
        resumeInsert.current = undefined;
        if (command && key === 'i' && !e.shiftKey &&
          editor.state.doc === resume.doc && editor.state.selection.main.empty && editor.state.selection.main.head === resume.normal) {
          e.preventDefault();
          e.stopPropagation();
          editor.dispatch({ selection: { anchor: resume.insert }, scrollIntoView: true });
          Vim.multiSelectHandleKey(cm, 'i', 'user');
          syncNativeInput(editor);
          return;
        }
      }
      // Some IMEs deliver Process/Unidentified with a physical key rather than the typed letter.
      // Only use it for Vim commands, and let the editor receive literal characters and composition.
      if (cm && command && imeLetter) {
        e.preventDefault();
        e.stopPropagation();
        Vim.multiSelectHandleKey(cm, key, 'user');
        syncNativeInput(editor);
        return;
      }
      props.onKey?.(e.nativeEvent, { insert: !!state?.insertMode, leave: false });
      if (escape && !e.defaultPrevented) escapeArmed.current = true;
    }}>
    <div className="vim-host" ref={host} />
    <div className="editor-mode muted small" role="status">Vim · {labels[mode] ?? labels.normal} 모드</div>
  </div>;
}
