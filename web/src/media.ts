import { useEffect, useState } from 'react';

/** Below this width the compose drawer overlays the deck instead of sitting beside it. */
export const NARROW = '(max-width: 900px)';
/** Phone-sized screens: one column at a time (matches the CSS breakpoint). */
export const PHONE = '(max-width: 760px)';
export const isNarrow = () => window.matchMedia(NARROW).matches;
/** Whether a media query matches, following changes (rotating a phone, resizing a window). */
export function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}
