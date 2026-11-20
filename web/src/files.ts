import { useEffect, useRef, useState, type RefObject } from 'react';
import { inputElement, type DeskInput } from './EditorInput.tsx';
import { api } from './api.ts';

declare global {
  interface Window { __AGENT_DESK_APP__?: boolean }
  interface WindowEventMap {
    'desk-drag': CustomEvent<{ over: boolean }>;
    'desk-drop': CustomEvent<DeskDrop>;
  }
}

/**
 * Whether the page runs in the desktop app (desktop/), which hands files dropped on its window over
 * by path ('desk-drop'). A browser can't see a dropped file's path, so there files are uploaded.
 */
export function useDeskApp(): boolean {
  const [app, setApp] = useState(() => window.__AGENT_DESK_APP__ === true);
  useEffect(() => {
    const on = () => setApp(true);
    window.addEventListener('desk-app', on);
    return () => window.removeEventListener('desk-app', on);
  }, []);
  return app;
}

/** A drop on the app window: files by path, or what a drag from a web page carried. */
interface DeskDrop { paths: string[]; url?: string | null; html?: string | null }

function webAddress(url: string | null | undefined, src: string | null | undefined): string | null {
  for (const candidate of [src, ...(url?.split(/\r?\n/) ?? [])]) {
    if (!candidate?.trim() || candidate.trimStart().startsWith('#')) continue;
    try {
      const address = new URL(candidate.trim());
      if ((address.protocol === 'https:' || address.protocol === 'http:') && !address.username && !address.password) return address.href;
    } catch { /* A browser can include non-URL entries in its drag data. */ }
  }
  return null;
}

/** Paths as message text: in backticks, so Markdown leaves them alone and spaces stay inside. */
export const pathText = (paths: string[]) => paths.map((p) => (p.includes('`') ? `"${p}"` : `\`${p}\``)).join(' ');

// The field a drop goes into: the one focused last, else the first one shown.
let lastFocused: HTMLElement | null = null;
document.addEventListener('focusin', (e) => {
  if (e.target instanceof HTMLElement && e.target.matches('textarea, [data-desk-input]') && e.target.closest('.cmp-field')) lastFocused = e.target;
});
const dropTarget = () => (lastFocused?.isConnected ? lastFocused : document.querySelector<HTMLElement>('.cmp-field textarea, .cmp-field [data-desk-input]'));

/**
 * Files for a compose field: paths dropped on the app window, and files dropped on the field or
 * picked in a browser (uploaded to the hub, which answers with the saved path). Either way the
 * paths go in at the caret.
 */
export function useFileDrop(inputRef: RefObject<DeskInput | null>, value: string, onChange: (v: string) => void, remote = false) {
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const latest = useRef({ value, onChange, remote });
  latest.current = { value, onChange, remote };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const insert = (paths: string[], raw?: string) => {
    const ta = inputRef.current;
    if (!mounted.current || !ta || (!paths.length && !raw)) return;
    const { value, onChange } = latest.current;
    const element = inputElement(ta);
    const focused = element === document.activeElement || lastFocused === element;
    const at = focused ? ta.selectionStart : value.length;
    const end = focused ? ta.selectionEnd : value.length;
    const before = value.slice(0, at), after = value.slice(end);
    const text = `${before && !/\s$/.test(before) ? ' ' : ''}${raw ?? pathText(paths)}${/^\s/.test(after) ? '' : ' '}`;
    if ('replaceRange' in ta) {
      ta.replaceRange(at, end, text);
      ta.focus();
    } else {
      onChange(before + text + after);
      const pos = at + text.length;
      requestAnimationFrame(() => { if (inputRef.current === ta) { ta.focus(); ta.setSelectionRange(pos, pos); } });
    }
  };

  useEffect(() => {
    const drag = (e: CustomEvent<{ over: boolean }>) => setOver(e.detail.over && dropTarget() === inputElement(inputRef.current));
    const drop = (e: CustomEvent<DeskDrop>) => {
      setOver(false);
      if (dropTarget() !== inputElement(inputRef.current)) return;
      if (remote && e.detail.paths.length) {
        setError('이 기기의 파일 경로는 공유 러너에서 사용할 수 없습니다. 파일을 공유 러너에 먼저 옮긴 뒤 원격 경로를 입력하세요.');
        return;
      }
      if (e.detail.paths.length) insert(e.detail.paths);
      else fromWeb(e.detail.url, e.detail.html);
    };
    window.addEventListener('desk-drag', drag);
    window.addEventListener('desk-drop', drop);
    return () => { window.removeEventListener('desk-drag', drag); window.removeEventListener('desk-drop', drop); };
  }, [inputRef,remote]);

  /** Saves the files on the hub and inserts the paths of those that made it. */
  const upload = async (files: File[]) => {
    if (!files.length) return;
    if(remote){setError('파일을 공유 러너에 먼저 옮긴 뒤 원격 경로를 입력하세요');return;}
    setError(null);
    setUploading((n) => n + files.length);
    const paths: string[] = [];
    for (const file of files) {
      try { paths.push((await api.upload(file)).path); }
      catch (e) { if (mounted.current) setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (mounted.current) setUploading((n) => n - 1); }
    }
    if (!mounted.current) return;
    if (latest.current.remote) { setError('파일을 공유 러너에 먼저 옮긴 뒤 원격 경로를 입력하세요'); return; }
    insert(paths);
  };
  function fromWeb(url: string | null | undefined, html: string | null | undefined, files: File[] = []) {
    let img: Element | null = null;
    if (html) {
      // Keep dragged elements inert while reading the image address.
      const template = document.createElement('template');
      template.innerHTML = html;
      img = template.content.querySelector('img');
    }
    const address = webAddress(url, img?.getAttribute('src'));
    if (address) {
      setError(null);
      insert([], address);
    } else if (files.length) {
      void upload(files);
    } else if (url || img) {
      setError('웹 주소를 가져올 수 없습니다. 이미지를 파일로 저장한 뒤 첨부하세요.');
    } else {
      return false;
    }
    return true;
  }

  return { over, uploading, error, upload, fromWeb, setOver };
}
