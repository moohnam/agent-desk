import { useSyncExternalStore } from 'react';

type EditorMode = 'emacs' | 'vim';
const KEY = 'agent-desk.editor-mode';
const modeOf = (value: string | null): EditorMode => value === 'vim' ? 'vim' : 'emacs';
let mode: EditorMode = 'emacs';
let memoryOnly = false;
try { mode = modeOf(localStorage.getItem(KEY)); } catch { /* unavailable storage */ }
const listeners = new Set<() => void>();
function change(next: EditorMode) {
  if (mode === next) return;
  mode = next;
  listeners.forEach(listener => listener());
}
function storage(event: StorageEvent) {
  if (event.key === KEY || event.key === null) {
    memoryOnly = false;
    change(modeOf(event.newValue));
  }
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener('storage', storage);
    if (!memoryOnly) {
      // Other tabs may have changed the setting while no editor or settings panel was mounted.
      try { mode = modeOf(localStorage.getItem(KEY)); } catch { /* unavailable storage */ }
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storage);
  };
}
export function useEditorMode() {
  return useSyncExternalStore(subscribe, () => mode);
}
export function setEditorMode(next: EditorMode) {
  try { localStorage.setItem(KEY, next); memoryOnly = false; } catch { memoryOnly = true; }
  change(next);
}
