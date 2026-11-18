import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/** Close functions of the open dialogs, the topmost last. */
const openModals: { close: () => void; element: HTMLElement }[] = [];
const controls = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>(
  'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
)].filter(element => element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[inert]'));
const focusDialog = (dialog: HTMLElement) => (controls(dialog)[0] ?? dialog).focus();
const markTop = () => openModals.forEach((entry, index) => entry.element.setAttribute('aria-modal', String(index === openModals.length - 1)));
// Esc closes the topmost dialog wherever the focus is (it often stays on the button that opened it).
// On the document, so a field inside that handles Esc itself (stopping it) goes first, and the
// desk's own keys on the window never see it.
document.addEventListener('keydown', (e) => {
  if (!openModals.length || e.defaultPrevented) return;
  const top = openModals[openModals.length - 1];
  if (e.key === 'Tab') {
    const available = controls(top.element), first = available[0], last = available.at(-1);
    if (!first || !top.element.contains(document.activeElement)) {
      e.preventDefault(); (e.shiftKey ? last ?? top.element : first ?? top.element).focus();
    } else if (e.shiftKey && (document.activeElement === first || document.activeElement === top.element)) {
      e.preventDefault(); last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key !== 'Escape' || e.isComposing || e.repeat) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
});

/** Whether any dialog is open; the desk's keys stay off while one is. */
export const modalOpen = () => openModals.length > 0;

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  closeRef.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    const entry = { close: () => closeRef.current(), element };
    openModals.push(entry);
    markTop();
    if (!element.contains(document.activeElement)) focusDialog(element);
    return () => {
      const wasTop = openModals.at(-1) === entry;
      openModals.splice(openModals.indexOf(entry), 1);
      markTop();
      if (!wasTop) return;
      if (opener.current?.isConnected && !opener.current.closest('[inert]')) opener.current.focus();
      else if (openModals.length) focusDialog(openModals[openModals.length - 1].element);
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}>
      <div ref={dialog} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title} aria-modal="true" tabIndex={-1}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} title="닫기 (Esc)" aria-label="닫기"><X /></button></header>
        {children}
      </div>
    </div>
  );
}
