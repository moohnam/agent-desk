import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Settings } from './types.ts';

// The desk's defaults for new tasks of each engine, shared by the compose preview and the settings dialog.
let settings: Settings = { claude: { model: null, effort: null }, codex: { model: null, effort: null }, agy: { model: null, effort: null } };
let loading: Promise<void> | null = null;
const listeners = new Set<(s: Settings) => void>();

function publish(s: Settings) { settings = s; listeners.forEach((f) => f(s)); }

export function refreshSettings() {
  loading = api.settings().then(publish)
    .catch(() => { /* hub unreachable or not restarted yet: keep the engines' defaults */ })
    .finally(() => { loading = null; });
  return loading;
}

export async function saveSettings(s: Parameters<typeof api.saveSettings>[0]) { publish(await api.saveSettings(s)); }

export function useSettings(): Settings {
  const [cur, setCur] = useState(settings);
  useEffect(() => {
    listeners.add(setCur);
    if (!loading) void refreshSettings();
    return () => { listeners.delete(setCur); };
  }, []);
  return cur;
}
