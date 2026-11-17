import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { documentHref } from './documentLinks.ts';

/** A supported file's normal click stays in the desk; only its auxiliary click uses the OS. */
export function DocumentLink({ path, taskId, previewId, onPreview, ...props }: ComponentProps<'a'> & {
  path: string; taskId: string; previewId?: string; onPreview: () => void;
}) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState<{x:number;y:number} | null>(null);
  const [notice, setNotice] = useState('');
  const scope = `${taskId}\n${path}`, current = useRef(scope); current.current = scope;
  useEffect(() => { current.current = scope; setMenu(null); setNotice(''); return () => { if (current.current === scope) current.current = ''; }; }, [scope, previewId]);
  const close = (focus = false) => { setMenu(null); if (focus) anchor.current?.focus(); };
  return <>
    <a {...props} ref={anchor} href={documentHref(taskId,path)} className="local-link"
      title={`문서 미리보기: ${path} · 가운데 클릭: 기본 앱 · 우클릭: 원본 경로 복사`}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onPreview();
      }}
      onMouseDown={event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); } }}
      onAuxClick={event => {
        if (event.button !== 1) return;
        event.preventDefault(); event.stopPropagation();
        void api.open(path,taskId).catch((error:Error) => { if (current.current === scope) setNotice(error.message); });
      }}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        setNotice(''); setMenu({x:event.clientX || box.left,y:event.clientY || box.bottom});
      }} />
    {notice && <span className="muted small" role="status"> {notice}</span>}
    {menu && createPortal(<PathMenu key={scope} {...menu} path={path} taskId={taskId} previewId={previewId}
      onClose={close} onCopied={() => { setNotice('원본 경로를 복사했습니다.'); close(true); }} />,document.body)}
  </>;
}

function PathMenu({x,y,path,taskId,previewId,onClose,onCopied}:{x:number;y:number;path:string;taskId:string;previewId?:string;onClose:(focus?:boolean)=>void;onCopied:()=>void}) {
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), manual = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  const [resolved,setResolved] = useState(''),[error,setError] = useState(''),[fallback,setFallback] = useState(false);
  useEffect(() => {
    let alive = true; active.current = true; const controller = new AbortController();
    // Resolve on menu open, leaving the actual copy inside its own user gesture (Safari/WebView).
    void api.filePath(path,taskId,previewId,AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])).then(value => {
      if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 4096 || /[\x00-\x1f]/.test(value.path)) throw new Error('원본 절대 경로를 확인하지 못했습니다');
      if (alive) setResolved(value.path);
    }).catch(error => { if (alive) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message === 'HTTP 404' || message.startsWith('no route') ? '원본 경로 복사를 사용하려면 허브와 러너를 업데이트해 주세요.' : message);
    } });
    root.current?.focus();
    return () => { alive = false; active.current = false; controller.abort(); };
  },[path,taskId,previewId]);
  useEffect(() => { if (resolved && document.activeElement === root.current) button.current?.focus(); },[resolved]);
  useEffect(() => { if (fallback) { manual.current?.focus(); manual.current?.select(); } },[fallback]);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const outside = (event:PointerEvent) => { if (!root.current?.contains(event.target as Node)) close.current(); };
    const scroll = (event:Event) => { if (!root.current?.contains(event.target as Node)) close.current(); };
    const resize = () => close.current();
    document.addEventListener('pointerdown',outside,true); document.addEventListener('scroll',scroll,true); window.addEventListener('resize',resize);
    return () => { document.removeEventListener('pointerdown',outside,true); document.removeEventListener('scroll',scroll,true); window.removeEventListener('resize',resize); };
  },[]);
  const copy = async () => {
    if (!resolved) return;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(resolved); if (active.current) onCopied(); return; }
    } catch { /* HTTP and browser permissions may require the legacy or manual path. */ }
    if (!active.current) return;
    const field = document.createElement('textarea');
    field.value = resolved; field.readOnly = true; field.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    document.body.append(field); field.select();
    let copied = false; try { copied = document.execCommand('copy'); } catch { /* Keep a selectable path. */ }
    field.remove();
    if (copied) onCopied(); else setFallback(true);
  };
  return <div ref={root} className="menu" role="menu" aria-label="파일 링크" tabIndex={-1}
    style={{left:Math.max(8,Math.min(x,window.innerWidth-360)),top:Math.max(8,Math.min(y,window.innerHeight-200)),maxWidth:'calc(100vw - 16px)',width:344,maxHeight:192,overflow:'auto'}}
    onContextMenu={event=>event.preventDefault()} onClick={event=>event.stopPropagation()}
    onKeyDown={event=>{
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
      else if (event.key === 'Tab') { event.stopPropagation(); onClose(true); }
      else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !fallback) { event.preventDefault(); event.stopPropagation(); button.current?.focus(); }
    }}>
    <button ref={button} className="item" role="menuitem" disabled={!resolved} onClick={()=>{void copy();}}>원본 파일 경로 복사</button>
    {!resolved && !error && <p className="lbl" role="status">원본 경로를 확인하는 중…</p>}
    {error && <p className="lbl" role="alert">{error}</p>}
    {fallback && <><p className="lbl">자동 복사를 사용할 수 없습니다. 선택된 경로를 직접 복사해 주세요.</p>
      <textarea ref={manual} value={resolved} readOnly aria-label="원본 파일 경로" style={{width:'100%',boxSizing:'border-box'}} /></>}
  </div>;
}
