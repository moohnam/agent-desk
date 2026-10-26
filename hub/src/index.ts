import { dirname, join, resolve } from 'node:path';
import { Access } from './access.ts';
import { Store } from './db.ts';
import { Hub } from './hub.ts';
import { createHttpServer } from './http.ts';

const PORT = Number(process.env.PORT ?? 4317);
// Other devices on the network can connect with the access token; HOST=127.0.0.1 keeps it to this Mac.
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.AGENT_DESK_DB ?? resolve(import.meta.dirname, '../../data/agent-desk.db');
const UPLOADS_DIR = process.env.AGENT_DESK_UPLOADS ?? join(dirname(DB_PATH), 'uploads');
const TOKEN_FILE = process.env.AGENT_DESK_TOKEN_FILE ?? join(dirname(DB_PATH), 'access-token');

const hub = new Hub(new Store(DB_PATH));
const access = new Access(TOKEN_FILE, PORT);
createHttpServer(hub, access, UPLOADS_DIR).listen(PORT, HOST, async () => {
  console.log(`agent-desk hub listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') return;
  const [first, ...rest] = access.urls();
  console.log(`다른 기기에서 열기 (토큰: ${TOKEN_FILE}):\n${await access.qrTerminal(first)}${[first, ...rest].join('\n')}`);
});
