// Opt-in authority for the existing local task database and long-lived engine daemon.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { Store } from '../db.ts';
import { config } from '../config.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { LocalRuntime, connectLocalTakeover } from './local-runtime.ts';
import { localAuthorityActivated } from './local-ownership.ts';

async function requireLegacyHubStopped() {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    throw new Error(`기존 허브 포트 ${config.host}:${config.port}가 사용 중입니다. 기존 허브를 종료한 뒤 최초 전환을 시작하세요`, {cause:error});
  } finally {
    if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
  }
}

const [command, name, file] = process.argv.slice(2);
if (command === 'grant' || command === 'revoke' || command === 'peers') {
  const store = new Store(config.dbPath);
  const workspace = new SharedWorkspace(undefined, store);
  try {
    if (command === 'grant') {
      if (!name || !file) throw new Error('grant 허브이름 토큰파일_절대경로 형식으로 실행하세요');
      const receipt = workspace.grant(name);
      try { writeFileSync(resolve(file), receipt.token + '\n', {mode:0o600,flag:'wx'}); }
      catch (error) { workspace.revoke(receipt.id); throw error; }
      console.log(JSON.stringify({peer_id:receipt.id,workspace_id:receipt.workspace_id,token_file:resolve(file)}));
    } else if (command === 'revoke') {
      if (!name) throw new Error('허브 ID가 필요합니다');
      workspace.revoke(name);
      console.log('허브 연결 권한을 취소했습니다');
    } else console.log(JSON.stringify(workspace.peers()));
  } finally { store.database.close(); }
} else {
  const liveTakeover=command==='--takeover-live';
  if (command&&!liveTakeover) throw new Error('지원하지 않는 로컬 러너 명령입니다');
  if (liveTakeover&&localAuthorityActivated(config.dbPath)) throw new Error('첫 전환에만 --takeover-live를 사용하세요');
  if (!localAuthorityActivated(config.dbPath)) await requireLegacyHubStopped();
  const runtime = liveTakeover ? await connectLocalTakeover(config.dbPath) : new LocalRuntime(config.dbPath);
  const server = runtime.server();
  server.on('error', error => { runtime.close(); console.error(error); process.exitCode = 1; });
  server.on('listening', () => runtime.hub.channels.start());
  server.listen(config.shared.port, '127.0.0.1', () =>
    console.log(`로컬 작업공간: http://127.0.0.1:${config.shared.port} (workspace ${runtime.workspace.id})`));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close(() => runtime.close());
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
