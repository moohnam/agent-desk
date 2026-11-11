import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { discoverSources } from './federation.ts';
import { LEGACY_MIGRATION_KEY } from './legacyMigration.ts';
import { installEmacsKeys } from './emacsKeys.ts';
import './styles.css';

installEmacsKeys();
async function start() {
  // Rewrite old browser references before hooks read them on the first render.
  let rendering = false;
  window.addEventListener('desk-legacy-migrated', () => { if(rendering)location.reload(); });
  try {
    await Promise.race([discoverSources(true), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
  } catch { /* The local hub can still be usable. */ }
  rendering = true;
  const { App } = await import('./App.tsx');
  window.addEventListener('storage', (event) => {
    if(event.key!==LEGACY_MIGRATION_KEY)return;
    if(!window.dispatchEvent(new Event('desk-before-legacy-migration',{cancelable:true})))return;
    void discoverSources(true).then(() => location.reload(), () => {});
  });
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void start();
