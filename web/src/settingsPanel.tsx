import { createContext, useContext, useId, useLayoutEffect, type ReactNode } from 'react';
import { Modal } from './Modal.tsx';

export type PanelGuard = { dirty: boolean; busy: boolean };
export const SettingsPanelContext = createContext<{
  active: boolean;
  register: (id: string, state: PanelGuard) => () => void;
} | null>(null);

/** Hidden editors retain their drafts; the owning settings dialog guards all of them on close. */
export function useSettingsPanel(dirty = false, busy = false) {
  const context = useContext(SettingsPanelContext), id = useId();
  const register = context?.register;
  useLayoutEffect(() => register?.(id, {dirty, busy}), [register, id, dirty, busy]);
  return {embedded: !!context, active: context?.active ?? true};
}
export function SettingsEditor({title, onClose, children, wide}: {title:string; onClose:()=>void; children:ReactNode; wide?:boolean}) {
  const context = useContext(SettingsPanelContext);
  return context ? <>{children}</> : <Modal title={title} onClose={onClose} wide={wide}>{children}</Modal>;
}
