import { useEffect, useRef, useState, type RefObject } from 'react';
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

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp)$/i;

/**
 * What a drag from a web page should become: an image (its <img src>, or an address that names an
 * image file) is downloaded into a file; any other address goes in as text.
 */
export function webDrop(url: string | null | undefined, html: string | null | undefined): { image?: string; link?: string } | null {
  const src = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : null;
  if (src && /^(https?:|data:image\/)/i.test(src)) return { image: src };
  const first = url?.split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim();
  if (!first) return null;
  try {
    const u = new URL(first);
    if (u.protocol === 'data:' && /^data:image\//i.test(first)) return { image: first };
    if (u.protocol === 'http:' || u.protocol === 'https:') return IMAGE_PATH.test(u.pathname) ? { image: first } : { link: first };
  } catch { /* not an address */ }
  return null;
}

/** Paths as message text: in backticks, so Markdown leaves them alone and spaces stay inside. */
export const pathText = (paths: string[]) => paths.map((p) => (p.includes('`') ? `"${p}"` : `\`${p}\``)).join(' ');

// The field a drop goes into: the one focused last, else the first one shown.
let lastFocused: HTMLTextAreaElement | null = null;
document.addEventListener('focusin', (e) => {
  if (e.target instanceof HTMLTextAreaElement && e.target.closest('.cmp-field')) lastFocused = e.target;
});
const dropTarget = () => (lastFocused?.isConnected ? lastFocused : document.querySelector<HTMLTextAreaElement>('.cmp-field textarea'));

/**
 * Files for a compose field: paths dropped on the app window, and files dropped on the field or
 * picked in a browser (uploaded to the hub, which answers with the saved path). Either way the
 * paths go in at the caret.
 */
export function useFileDrop(inputRef: RefObject<HTMLTextAreaElement | null>, value: string, onChange: (v: string) => void) {
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  const insert = (paths: string[], raw?: string) => {
    const ta = inputRef.current;
    if (!ta || (!paths.length && !raw)) return;
    const { value, onChange } = latest.current;
    const at = ta === document.activeElement || lastFocused === ta ? ta.selectionStart : value.length;
    const end = ta === document.activeElement || lastFocused === ta ? ta.selectionEnd : value.length;
    const before = value.slice(0, at), after = value.slice(end);
    const text = `${before && !/\s$/.test(before) ? ' ' : ''}${raw ?? pathText(paths)}${/^\s/.test(after) ? '' : ' '}`;
    onChange(before + text + after);
    const pos = at + text.length;
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(pos, pos); });
  };

  useEffect(() => {
    const drag = (e: CustomEvent<{ over: boolean }>) => setOver(e.detail.over && dropTarget() === inputRef.current);
    const drop = (e: CustomEvent<DeskDrop>) => {
      setOver(false);
      if (dropTarget() !== inputRef.current) return;
      if (e.detail.paths.length) insert(e.detail.paths);
      else void fromWeb(e.detail.url, e.detail.html);
    };
    window.addEventListener('desk-drag', drag);
    window.addEventListener('desk-drop', drop);
    return () => { window.removeEventListener('desk-drag', drag); window.removeEventListener('desk-drop', drop); };
  }, [inputRef]);

  /** Saves each item on the hub (by `save`) and inserts the paths of those that made it. */
  const saveAll = async <T,>(items: T[], save: (x: T) => Promise<{ path: string }>, label: (x: T) => string) => {
    if (!items.length) return;
    setError(null);
    setUploading((n) => n + items.length);
    const paths: string[] = [];
    for (const x of items) {
      try { paths.push((await save(x)).path); }
      catch (e) { setError(`${label(x)}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { setUploading((n) => n - 1); }
    }
    insert(paths);
  };
  const upload = (files: File[]) => saveAll(files, api.upload, (f) => f.name);

  /** A drag from a web page: an image is downloaded (a data: one decoded here), a link inserted. */
  async function fromWeb(url: string | null | undefined, html: string | null | undefined) {
    const w = webDrop(url, html);
    if (!w) return false;
    if (w.link) { insert([], w.link); return true; }
    const image = w.image!;
    if (image.startsWith('data:')) {
      await saveAll([image], async (d) => {
        const blob = await (await fetch(d)).blob();
        return api.upload(new File([blob], `image.${blob.type.split('/')[1]?.replace('+xml', '') || 'png'}`, { type: blob.type }));
      }, () => '이미지');
    } else {
      await saveAll([image], api.uploadUrl, (u) => u.slice(0, 80));
    }
    return true;
  }

  return { over, uploading, error, upload, fromWeb, setOver };
}
