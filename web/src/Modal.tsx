import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/** Close functions of the open dialogs, the topmost last. */
const openModals: { close: () => void }[] = [];
// Esc closes the topmost dialog wherever the focus is (it often stays on the button that opened it).
// On the document, so a field inside that handles Esc itself (stopping it) goes first, and the
// desk's own keys on the window never see it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openModals.length || e.defaultPrevented) return;
  e.preventDefault();
  e.stopPropagation();
  openModals[openModals.length - 1].close();
});

/** Whether any dialog is open; the desk's keys stay off while one is. */
export const modalOpen = () => openModals.length > 0;

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const entry = { close: () => closeRef.current() };
    openModals.push(entry);
    return () => { openModals.splice(openModals.indexOf(entry), 1); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} title="닫기 (Esc)" aria-label="닫기"><X /></button></header>
        {children}
      </div>
    </div>
  );
}
