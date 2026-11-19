import { fileURLToPath } from 'node:url';
import { configuredPort, deskPortDefaults } from '../hub/src/ports.ts';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localDb = process.env.AGENT_DESK_DB ?? fileURLToPath(new URL('../data/agent-desk.db', import.meta.url));
const hubPort = configuredPort(process.env.PORT, deskPortDefaults(localDb, process.env, fileURLToPath(new URL('../hub/', import.meta.url))).hub);

export default defineConfig({
  plugins: [react()],
  build: { rolldownOptions: { input: { app: 'index.html', mermaid: 'mermaid-renderer.html' } } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${hubPort}` },
  },
});
