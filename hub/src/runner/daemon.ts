// Runner daemon: owns the engine sessions and outlives hub restarts. The hub connects over
// loopback TCP and proves itself with the runner token; while no hub is connected, messages are
// buffered and replayed on reconnect.
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { config, recordDeskPortDefaults } from '../config.ts';
import { registerRuntimeControl, sessionBlockers } from '../runtime-control.ts';
import { PROTOCOL_VERSION, checkHubToRunner, type RunnerToHub } from '../../../shared/protocol.ts';
import { LocalRunnerOutbox } from './local-outbox.ts';
import { Runner } from './runner.ts';
import { RUNNER_HOST, RUNNER_PORT, isRunnerOutput, readLines, runnerToken, sameToken, wireSequence, writeLine } from './wire.ts';

const PID_FILE = config.runner.pidFile;

interface HubLink { socket: Socket; confirmOutput: boolean; sentThrough: number; refreshHelloPending: boolean }
let hub: HubLink | null = null;
let stopping = false;
const outbox = new LocalRunnerOutbox();
const outputStream = randomUUID();
let lastDropWarning = -Infinity;

const runner = new Runner(`local-${hostname()}`, emit, { mcp: { url: `http://127.0.0.1:${config.port}/mcp` } });

function emit(m: RunnerToHub) {
  const link = hub?.socket.destroyed ? null : hub;
  if (link && !link.socket.writableNeedDrain && (!link.confirmOutput || !isRunnerOutput(m))) {
    writeLine(link.socket, m);
    return;
  }
  if (!link && m.type === 'usage') return;
  const { entry, dropped } = outbox.enqueue(m);
  if (dropped && Date.now() - lastDropWarning >= 60_000) {
    lastDropWarning = Date.now();
    console.warn('로컬 러너 전송 대기열이 가득 차 일부 메시지를 보관하지 못했습니다.');
  }
  if (link && !link.socket.writableNeedDrain) {
    outbox.send(entry, link.confirmOutput, line => link.socket.write(line));
    link.sentThrough = entry.sequence;
  }
}

runner.startModelRefresh(() => {
  const link = hub;
  if (!link || link.socket.destroyed) return;
  if (link.socket.writableNeedDrain) link.refreshHelloPending = true;
  else writeLine(link.socket, hello(link));
});

// A failure in one session's adapter must not end the daemon and every other session with it.
process.on('unhandledRejection', (err) => console.error('runner: unhandled rejection', err));

recordDeskPortDefaults();
const token = runnerToken();
/** How long a new connection has to show the token before it is dropped. */
const AUTH_MS = 5000;
let lastAuthWarning = 0;

const server = createServer((socket) => {
  let authed = false;
  const timer = setTimeout(() => socket.destroy(), AUTH_MS);
  readLines(socket, (m) => {
    if (socket.destroyed) return;
    if (!authed) {
      if (stopping) { socket.destroy(); return; }
      // Until it shows the token the connection is nobody's: the hub already connected keeps its place.
      const auth = m as { type?: string; token?: unknown; protocolVersion?: unknown; confirmOutput?: unknown };
      if (auth?.type !== 'auth' || !sameToken(auth.token, token)) {
        if (Date.now() - lastAuthWarning >= 60_000) {
          lastAuthWarning = Date.now();
          console.error('러너가 인증되지 않은 허브 연결을 거절했습니다. 양쪽의 연결 토큰 설정을 확인하세요.');
        }
        socket.destroy(); return;
      }
      authed = true;
      clearTimeout(timer);
      if (auth.protocolVersion !== PROTOCOL_VERSION) console.warn('허브와 로컬 러너의 프로토콜 버전이 다릅니다. 필요한 기능이 지원되는지 확인하세요.');
      adopt(socket, auth.confirmOutput === true);
      return;
    }
    const ack = m as { type?: string; sequence?: unknown } | null;
    if (ack?.type === 'output_ack') {
      if (hub?.socket === socket && hub.confirmOutput && wireSequence(ack.sequence) && ack.sequence <= hub.sentThrough)
        outbox.acknowledge(ack.sequence);
      return;
    }
    if (stopping) return;
    const cmd = checkHubToRunner(m);
    if (typeof cmd === 'string') { console.error('허브 명령의 형식이 잘못되었습니다.'); return; }
    runner.handle(cmd, cmd.type === 'start' && cmd.ipv6DeskMcpUrl ? { url: cmd.ipv6DeskMcpUrl } : undefined);
  });
  const drop = () => { clearTimeout(timer); if (hub?.socket === socket) hub = null; };
  socket.on('close', drop);
  socket.on('error', drop);
  socket.on('drain', () => { if (hub?.socket === socket) flush(hub); });
});

/** Makes `socket` the hub's connection: one hub at a time, so it replaces a stale one. */
function adopt(socket: Socket, confirmOutput: boolean) {
  hub?.socket.destroy();
  const link = hub = { socket, confirmOutput, sentThrough: 0, refreshHelloPending: false };
  writeLine(socket, hello(link));
  flush(link);
}

function hello(link: HubLink): RunnerToHub {
  return {
    type: 'hello', runnerId: runner.id, host: hostname(), capabilities: { ...runner.capabilities, ipv6Mcp: true }, sessions: runner.snapshot(),
    protocolVersion: PROTOCOL_VERSION, ...(link.confirmOutput && { outputStream }),
  };
}

function flush(link: HubLink) {
  const { socket } = link;
  if (socket.destroyed || socket.writableNeedDrain) return;
  link.sentThrough = outbox.flush(link.confirmOutput, line => socket.write(line), link.sentThrough);
  if (!socket.writableNeedDrain && !stopping && link.refreshHelloPending) {
    link.refreshHelloPending = false;
    writeLine(socket, hello(link));
  }
  if (stopping && !socket.writableNeedDrain && !socket.writableEnded) socket.end(() => socket.destroy());
}

server.on('error', (err: NodeJS.ErrnoException) => {
  // Another runner already owns the port; let it serve.
  console.error(`runner: ${err.code === 'EADDRINUSE' ? `port ${RUNNER_PORT} in use, exiting` : err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(RUNNER_PORT, RUNNER_HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`agent-desk runner ${runner.id} listening on ${RUNNER_HOST}:${RUNNER_PORT} (pid ${process.pid})`);
});
function stop() {
  if (stopping) return;
  stopping = true;
  runner.shutdown();
  // Let the hub receive queued shutdown events before closing its connection.
  if (hub) flush(hub);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await registerRuntimeControl({ role: 'daemon', ready: () => server.listening,
  blockers: () => [...sessionBlockers(runner.snapshot()),
    ...(outbox.hasUnconfirmedOutput() ? ['허브에 저장되기를 기다리는 대화 출력'] : [])], stop });
