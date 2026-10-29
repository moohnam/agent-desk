import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { PROTOCOL_VERSION, checkRunnerToHub, type HubToRunner, type RunnerToHub } from '../../../shared/protocol.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, runnerToken, writeLine } from './wire.ts';

const RETRY_MS = 1000;
const SPAWN_EVERY_MS = 10_000;

/**
 * The hub's side of the runner connection. Starts the runner daemon (detached, so it survives
 * hub restarts) when nothing is listening, and reconnects whenever the connection drops.
 */
export class RunnerClient {
  private socket: Socket | null = null;
  private live = new Set<string>();
  private lastSpawn = 0;
  private onMessage: (m: RunnerToHub) => void;
  private onConnection: (connected: boolean) => void;
  id: string | null = null;
  /** The engines the connected runner runs (its hello). */
  engines = new Set<string>();

  /** `onConnection` fires after the hello is handled (true) and when an established connection drops (false). */
  constructor(onMessage: (m: RunnerToHub) => void, onConnection: (connected: boolean) => void = () => {}) {
    this.onMessage = onMessage;
    this.onConnection = onConnection;
    this.connect();
  }

  get connected() { return this.socket !== null && this.id !== null; }

  has(sessionId: string) { return this.connected && this.live.has(sessionId); }

  handle(cmd: HubToRunner) {
    if (!this.socket) throw new Error('runner not connected');
    if (cmd.type === 'start') this.live.add(cmd.sessionId);
    writeLine(this.socket, cmd);
  }

  private connect() {
    const socket = connect(RUNNER_PORT, RUNNER_HOST);
    socket.on('connect', () => {
      this.socket = socket;
      // Read now rather than once: a runner started meanwhile may have just written it.
      writeLine(socket, { type: 'auth', token: runnerToken(), protocolVersion: PROTOCOL_VERSION } satisfies HubToRunner);
      readLines(socket, (raw) => {
        const m = checkRunnerToHub(raw);
        if (typeof m === 'string') { console.error(`runner: dropped a message (${m})`); return; }
        const hello = m.type === 'hello';
        if (m.type === 'hello') {
          this.id = m.runnerId;
          this.live = new Set(m.sessions.map((s) => s.sessionId));
          this.engines = new Set(m.capabilities.engines);
          if (m.protocolVersion !== PROTOCOL_VERSION) {
            console.warn(`runner speaks protocol ${m.protocolVersion ?? '(none)'}, this hub ${PROTOCOL_VERSION}: restart the runner (npm run runner:stop)`);
          }
        } else if (m.type === 'closed') {
          this.live.delete(m.sessionId);
        }
        this.onMessage(m);
        if (hello) this.onConnection(true);
      });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') this.spawnDaemon();
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        const wasConnected = this.connected;
        this.socket = null;
        this.id = null;
        this.live.clear();
        console.warn('runner connection lost; reconnecting');
        if (wasConnected) this.onConnection(false);
      }
      setTimeout(() => this.connect(), RETRY_MS);
    });
  }

  private spawnDaemon() {
    const now = Date.now();
    if (now - this.lastSpawn < SPAWN_EVERY_MS) return;
    this.lastSpawn = now;
    mkdirSync(dirname(config.runner.log), { recursive: true });
    const log = openSync(config.runner.log, 'a');
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'daemon.ts')], {
      detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.unref();
    console.log(`started runner daemon (pid ${child.pid}, log ${config.runner.log})`);
  }
}
