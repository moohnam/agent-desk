import { useSyncExternalStore } from 'react';

/** One 30-second clock for every relative time on the page, so a tick redraws the times alone. */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(f: () => void) {
  listeners.add(f);
  // The clock stood still while nothing watched it.
  if (timer === undefined) now = Date.now();
  timer ??= window.setInterval(() => { now = Date.now(); listeners.forEach((g) => g()); }, TICK_MS);
  return () => {
    listeners.delete(f);
    if (!listeners.size) { window.clearInterval(timer); timer = undefined; }
  };
}

/** The current time, updated every 30 seconds. */
export const useNow = () => useSyncExternalStore(subscribe, () => now);
