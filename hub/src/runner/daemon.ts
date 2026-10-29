// Runner daemon: owns the engine sessions and outlives hub restarts. The hub connects over
// loopback TCP and proves itself with the runner token; while no hub is connected, messages are
// buffered and replayed on reconnect.
import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { config } from '../config.ts';
import { PROTOCOL_VERSION, checkHubToRunner, type RunnerToHub } from '../../../shared/protocol.ts';
import { Runner } from './runner.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, runnerToken, sameToken, writeLine } from './wire.ts';

const MAX_BUFFER = 20_000;
/** Size (in characters) of the messages kept while no hub is connected; tool inputs can be large. */
const MAX_BUFFER_CHARS = 64 * 1024 * 1024;
const PID_FILE = config.runner.pidFile;

let hub: Socket | null = null;
/**
 * Messages for the next hub, serialized. Over the limits the oldest events go first; state changes
 * (engine session ids, busy, approvals, closed) are kept, as the hub can't learn them otherwise.
 */
const buffer: { line: string; event: boolean }[] = [];
let bufferSize = 0;

const runner = new Runner(`local-${hostname()}`, (m) => {
  if (hub) { writeLine(hub, m); return; }
  const line = JSON.stringify(m) + '\n';
  buffer.push({ line, event: m.type === 'event' });
  bufferSize += line.length;
  while (buffer.length > 1 && (buffer.length > MAX_BUFFER || bufferSize > MAX_BUFFER_CHARS)) {
    const i = buffer.findIndex((x) => x.event);
    const [gone] = buffer.splice(i >= 0 ? i : 0, 1);
    bufferSize -= gone.line.length;
  }
});

// A failure in one session's adapter must not end the daemon and every other session with it.
process.on('unhandledRejection', (err) => console.error('runner: unhandled rejection', err));

const token = runnerToken();
/** How long a new connection has to show the token before it is dropped. */
const AUTH_MS = 5000;

const server = createServer((socket) => {
  let authed = false;
  const timer = setTimeout(() => socket.destroy(), AUTH_MS);
  readLines(socket, (m) => {
    if (!authed) {
      // Until it shows the token the connection is nobody's: the hub already connected keeps its place.
      const auth = m as { type?: string; token?: unknown; protocolVersion?: unknown };
      if (auth?.type !== 'auth' || !sameToken(auth.token, token)) { console.error('runner: connection without the token, dropped'); socket.destroy(); return; }
      authed = true;
      clearTimeout(timer);
      if (auth.protocolVersion !== PROTOCOL_VERSION) console.warn(`runner: hub speaks protocol ${auth.protocolVersion}, this runner ${PROTOCOL_VERSION}`);
      adopt(socket);
      return;
    }
    const cmd = checkHubToRunner(m);
    if (typeof cmd === 'string') { console.error(`runner: dropped a command (${cmd})`); return; }
    runner.handle(cmd);
  });
  const drop = () => { clearTimeout(timer); if (hub === socket) hub = null; };
  socket.on('close', drop);
  socket.on('error', drop);
});

/** Makes `socket` the hub's connection: one hub at a time, so it replaces a stale one. */
function adopt(socket: Socket) {
  hub?.destroy();
  hub = socket;
  writeLine(socket, {
    type: 'hello', runnerId: runner.id, host: hostname(), capabilities: runner.capabilities, sessions: runner.snapshot(),
    protocolVersion: PROTOCOL_VERSION,
  } satisfies RunnerToHub);
  for (const { line } of buffer.splice(0)) socket.write(line);
  bufferSize = 0;
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
