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
const PID_FILE = process.env.RUNNER_PID_FILE ?? resolve(import.meta.dirname, '../../../data/runner.pid');

let hub: Socket | null = null;
const buffer: RunnerToHub[] = [];

const runner = new Runner(`local-${hostname()}`, (m) => {
  if (hub) { writeLine(hub, m); return; }
  buffer.push(m);
  if (buffer.length > MAX_BUFFER) buffer.shift();
});

const server = createServer((socket) => {
  // One hub at a time; a new connection replaces a stale one.
  hub?.destroy();
  hub = socket;
  writeLine(socket, {
    type: 'hello', runnerId: runner.id, host: hostname(), capabilities: runner.capabilities, sessions: runner.snapshot(),
  } satisfies RunnerToHub);
  for (const m of buffer.splice(0)) writeLine(socket, m);
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
