import { Access } from './access.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { Hub } from './hub.ts';
import { createHttpServer } from './http.ts';

const { port: PORT, host: HOST, dbPath: DB_PATH, uploadsDir: UPLOADS_DIR, accessTokenFile: TOKEN_FILE } = config;

const hub = new Hub(new Store(DB_PATH));
const access = new Access(TOKEN_FILE, PORT, undefined, config.allowedHosts);
createHttpServer(hub, access, UPLOADS_DIR).listen(PORT, HOST, async () => {
  console.log(`agent-desk hub listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') return;
  const [first, ...rest] = access.urls();
  console.log(`다른 기기에서 열기 (토큰: ${TOKEN_FILE}):\n${await access.qrTerminal(first)}${[first, ...rest].join('\n')}`);
});
