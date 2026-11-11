import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { PROTOCOL_VERSION, checkRunnerToHub, type HubToRunner, type RunnerToHub } from '../../../shared/protocol.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, runnerToken, writeLine } from './wire.ts';

const RETRY_MS = 1000;
const SPAWN_EVERY_MS = 10_000;

/** What the hub needs of its runner connection; tests give the hub a fake one. */
export interface RunnerPort {
  /** Connected, and the runner's hello handled. */
  readonly connected: boolean;
  readonly id: string | null;
  /** The engines the runner runs. */
  readonly engines: ReadonlySet<string>;
  /** Whether the runner still has the session open. */
  has(sessionId: string): boolean;
  /** Absent on test and legacy ports; only an explicit false forbids pinned inputs. */
  readonly skillSnapshotSupported?: boolean;
  /** Sends a command; throws when not connected. */
  handle(cmd: HubToRunner): void;
  /** Remote commands can be accepted durably while the link is down. */
  canQueue?(sessionId: string): boolean;
  ready?(sessionId: string): boolean;
}

/** Makes the hub's runner connection, which reports messages and connection changes back. */
export type RunnerFactory = (onMessage: (m: RunnerToHub) => void, onConnection: (connected: boolean) => void) => RunnerPort;

export interface RunnerClientOptions {
  spawnIfMissing?: boolean;
  host?: string;
  port?: number;
  token?: () => string;
  onError?: (error: Error) => void;
}

/**
 * The hub's side of the runner connection. Starts the runner daemon (detached, so it survives
 * hub restarts) when nothing is listening, and reconnects whenever the connection drops.
 */
export class RunnerClient implements RunnerPort {
  private socket: Socket | null = null;
  private stopped = false;
  private live = new Set<string>();
  private supportsSkillSnapshot = false;
  private lastSpawn = 0;
  private onMessage: (m: RunnerToHub) => void;
  private onConnection: (connected: boolean) => void;
  private options: RunnerClientOptions;
  id: string | null = null;
  /** The engines the connected runner runs (its hello). */
  engines = new Set<string>();

  /** `onConnection` fires after the hello is handled (true) and when an established connection drops (false). */
  constructor(onMessage: (m: RunnerToHub) => void, onConnection: (connected: boolean) => void = () => {}, options: RunnerClientOptions = {}) {
    this.onMessage = onMessage;
    this.onConnection = onConnection;
    this.options = options;
    this.connect();
  }

  /** Hand the already authenticated socket and its first hello to a fully constructed Hub. */
  handoff(onMessage: (m: RunnerToHub) => void, onConnection: (connected: boolean) => void,
    hello: Extract<RunnerToHub,{type:'hello'}>) {
    if (!this.connected || this.id !== hello.runnerId) throw new Error('기존 4318 러너 연결이 인계 전에 끊겼습니다');
    this.onMessage = onMessage;
    this.onConnection = onConnection;
    this.onMessage(hello);
    this.onConnection(true);
  }

  get connected() { return this.socket !== null && this.id !== null; }
  get skillSnapshotSupported() { return this.supportsSkillSnapshot; }

  has(sessionId: string) { return this.connected && this.live.has(sessionId); }

  handle(cmd: HubToRunner) {
    if (!this.socket) throw new Error('runner not connected');
    if ((cmd.type === 'start' || cmd.type === 'send') && cmd.skillSnapshot && !this.supportsSkillSnapshot)
      throw new HttpError(409, '현재 로컬 러너는 고정 스킬 버전을 지원하지 않습니다. 실행 중인 세션은 유지되며, 러너가 업데이트된 뒤 다시 보내주세요');
    if (cmd.type === 'start') {
      this.live.add(cmd.sessionId);
    }
    writeLine(this.socket, cmd);
  }

  /** Disconnects this authority without ending sessions in the independently living daemon. */
  close() {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    this.id = null;
    this.live.clear();
  }

  private connect() {
    if (this.stopped) return;
    const socket = connect(this.options.port ?? RUNNER_PORT, this.options.host ?? RUNNER_HOST);
    socket.on('connect', () => {
      if (this.stopped) { socket.destroy(); return; }
      this.socket = socket;
      // Read now rather than once: a runner started meanwhile may have just written it.
      writeLine(socket, { type: 'auth', token: (this.options.token ?? runnerToken)(), protocolVersion: PROTOCOL_VERSION } satisfies HubToRunner);
      readLines(socket, (raw) => {
        const m = checkRunnerToHub(raw);
        if (typeof m === 'string') { console.error(`runner: dropped a message (${m})`); return; }
        const hello = m.type === 'hello';
        if (m.type === 'hello') {
          this.id = m.runnerId;
          this.live = new Set(m.sessions.map((s) => s.sessionId));
          this.engines = new Set(m.capabilities.engines);
          this.supportsSkillSnapshot = !!m.capabilities.skillSnapshot;
          if (m.protocolVersion !== PROTOCOL_VERSION && this.options.spawnIfMissing !== false) {
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
      if (!this.stopped && err.code === 'ECONNREFUSED' && this.options.spawnIfMissing !== false) this.spawnDaemon();
      this.options.onError?.(err);
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
      if (!this.stopped) setTimeout(() => this.connect(), RETRY_MS);
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
