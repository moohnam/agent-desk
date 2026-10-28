// Runner daemon: owns the engine sessions and outlives hub restarts. The hub connects over
// loopback TCP; while no hub is connected, messages are buffered and replayed on reconnect.
import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { HubToRunner, RunnerToHub } from './protocol.ts';
import { Runner } from './runner.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, writeLine } from './wire.ts';

const MAX_BUFFER = 20_000;
/** Size (in characters) of the messages kept while no hub is connected; tool inputs can be large. */
const MAX_BUFFER_CHARS = 64 * 1024 * 1024;
const PID_FILE = process.env.RUNNER_PID_FILE ?? resolve(import.meta.dirname, '../../../data/runner.pid');

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

const server = createServer((socket) => {
  // One hub at a time; a new connection replaces a stale one.
  hub?.destroy();
  hub = socket;
  writeLine(socket, {
    type: 'hello', runnerId: runner.id, host: hostname(), capabilities: runner.capabilities, sessions: runner.snapshot(),
  } satisfies RunnerToHub);
  for (const { line } of buffer.splice(0)) socket.write(line);
  bufferSize = 0;
  readLines(socket, (cmd: HubToRunner) => runner.handle(cmd));
  const drop = () => { if (hub === socket) hub = null; };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  // Another runner already owns the port; let it serve.
  console.error(`runner: ${err.code === 'EADDRINUSE' ? `port ${RUNNER_PORT} in use, exiting` : err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(RUNNER_PORT, RUNNER_HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`agent-desk runner ${runner.id} listening on ${RUNNER_HOST}:${RUNNER_PORT} (pid ${process.pid})`);
});
