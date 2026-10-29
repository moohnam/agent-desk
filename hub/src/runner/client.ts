import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import type { HubToRunner, RunnerToHub } from '../../../shared/protocol.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, writeLine } from './wire.ts';

const DATA_DIR = resolve(import.meta.dirname, '../../../data');
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
      readLines(socket, (m: RunnerToHub) => {
        const hello = m.type === 'hello';
        if (m.type === 'hello') {
          this.id = m.runnerId;
          this.live = new Set(m.sessions.map((s) => s.sessionId));
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
    mkdirSync(DATA_DIR, { recursive: true });
    const log = openSync(process.env.RUNNER_LOG ?? resolve(DATA_DIR, 'runner.log'), 'a');
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'daemon.ts')], {
      detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.unref();
    console.log(`started runner daemon (pid ${child.pid}, log data/runner.log)`);
  }
}
