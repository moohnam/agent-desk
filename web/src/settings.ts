import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Settings } from './types.ts';

// The desk's defaults for new tasks of each engine, shared by the compose preview and the settings dialog.
let settings: Settings = { claude: { model: null, effort: null }, codex: { model: null, effort: null }, agy: { model: null, effort: null } };
let loading: Promise<void> | null = null;
let revision = 0;
const listeners = new Set<(s: Settings) => void>();

function publish(s: Settings) { settings = s; listeners.forEach((f) => f(s)); }

export function refreshSettings() {
  const startedAt = revision;
  const request = api.settings().then(value => { if (revision === startedAt && loading === request) publish(value); })
    .catch(() => { /* hub unreachable or not restarted yet: keep the engines' defaults */ })
    .finally(() => { if (loading === request) loading = null; });
  loading = request;
  return request;
}

export async function saveSettings(s: Parameters<typeof api.saveSettings>[0], signal?: AbortSignal) {
  const saved = await api.saveSettings(s, signal);
  revision++;
  publish(saved);
}

export function useSettings(source=''): Settings {
  const [cur, setCur] = useState(settings);
  useEffect(() => {
    if(source){let alive=true;setCur({claude:{model:null,effort:null},codex:{model:null,effort:null},agy:{model:null,effort:null}});void api.settings(source).then(v=>{if(alive)setCur(v);},()=>{});return()=>{alive=false;};}
    listeners.add(setCur);
    if (!loading) void refreshSettings();
    return () => { listeners.delete(setCur); };
  }, [source]);
  return cur;
}
