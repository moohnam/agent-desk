import { modelReference } from '../../../shared/compose.ts';
import { DEFAULT_INSTRUCTIONS } from '../instruction-store.ts';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { openRuntimeLog } from '../runtime-log.ts';
import type { RunnerConnectionProblem } from '../../../shared/api.ts';
import { PROTOCOL_VERSION, checkRunnerToHub, type HubToRunner, type RunnerToHub } from '../../../shared/protocol.ts';
import { RUNNER_HOST, RUNNER_PORT, readLines, readOutput, runnerToken, writeLine } from './wire.ts';

const RETRY_MS = 1000;
const SPAWN_EVERY_MS = 10_000;
const MAX_RETRY_MS = 30_000;
const connectionLog: Record<RunnerConnectionProblem, string> = {
  unreachable: '로컬 러너의 연결 주소와 실행 상태를 확인하세요.',
  authentication: '로컬 러너가 연결을 확인하지 않았습니다. 연결 토큰 설정과 러너 로그를 확인하세요.',
  token: '허브가 로컬 러너의 연결 토큰을 읽지 못했습니다. 파일 경로와 읽기 권한을 확인하세요.',
  disconnected: '로컬 러너 연결이 끊겼습니다. 재연결을 시도합니다.',
};
type ConnectionListener = (connected: boolean, problem?: RunnerConnectionProblem) => void;
export interface LocalOutputReceipt { runnerId: string; stream: string; sequence: number }
export type RunnerMessageListener = (message: RunnerToHub, receipt?: LocalOutputReceipt) => void;

/** What the hub needs of its runner connection; tests give the hub a fake one. */
export interface RunnerPort {
  /** Connected, and the runner's hello handled. */
  readonly connected: boolean;
  readonly id: string | null;
  /** The engines the runner runs. */
  readonly engines: ReadonlySet<string>;
  readonly connectionProblem?: RunnerConnectionProblem;
  /** Whether the runner still has the session open. */
  has(sessionId: string): boolean;
  /** Absent on test and legacy ports; only an explicit false forbids pinned inputs. */
  readonly skillSnapshotSupported?: boolean;
  readonly connectorMcpSupported?: boolean;
  /** Sends a command; throws when not connected. */
  handle(cmd: HubToRunner): void;
  /** Remote commands can be accepted durably while the link is down. */
  canQueue?(sessionId: string): boolean;
  ready?(sessionId: string): boolean;
  refreshModels?(force?: boolean): void;
}

/** Makes the hub's runner connection, which reports messages and connection changes back. */
export type RunnerFactory = (onMessage: RunnerMessageListener, onConnection: ConnectionListener) => RunnerPort;

export interface RunnerClientOptions {
  spawnIfMissing?: boolean;
  host?: string;
  port?: number;
  token?: () => string;
  onError?: (error: Error) => void;
  ipv6DeskMcpUrl?: () => string | undefined;
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
  private supportsInstructions = false;
  private supportsConnectorMcp = false;
  private supportsIpv6Mcp = false;
  private supportsModelCatalogs = false;
  private lastSpawn = 0;
  private retryMs = RETRY_MS;
  private retry?: ReturnType<typeof setTimeout>;
  connectionProblem?: RunnerConnectionProblem;
  private onMessage: RunnerMessageListener;
  private onConnection: ConnectionListener;
  private options: RunnerClientOptions;
  id: string | null = null;
  /** The engines the connected runner runs (its hello). */
  engines = new Set<string>();

  /** `onConnection` reports a successful handshake or a changed failure reason. */
  constructor(onMessage: RunnerMessageListener, onConnection: ConnectionListener = () => {}, options: RunnerClientOptions = {}) {
    this.onMessage = onMessage;
    this.onConnection = onConnection;
    this.options = options;
    this.connect();
  }

  /** Hand the already authenticated socket and its first hello to a fully constructed Hub. */
  handoff(onMessage: RunnerMessageListener, onConnection: ConnectionListener,
    hello: Extract<RunnerToHub,{type:'hello'}>) {
    if (!this.connected || this.id !== hello.runnerId) throw new Error('기존 로컬 러너 연결이 인계 전에 끊겼습니다');
    this.onMessage = onMessage;
    this.onConnection = onConnection;
    this.onMessage(hello);
    this.onConnection(true);
  }

  get connected() { return this.socket !== null && this.id !== null; }
  get skillSnapshotSupported() { return this.supportsSkillSnapshot; }

  get connectorMcpSupported() {
    return this.supportsConnectorMcp && (this.supportsIpv6Mcp || !this.options.ipv6DeskMcpUrl?.());
  }
  has(sessionId: string) { return this.connected && this.live.has(sessionId); }

  refreshModels(force=false) {
    if (this.connected && this.supportsModelCatalogs) this.handle({type:'refresh_models',sessionId:'model-catalog',force});
  }

  handle(cmd: HubToRunner) {
    if (!this.connected || !this.socket || this.socket.destroyed || this.socket.writable===false) throw new Error('runner not connected');
    if ((cmd.type === 'start' || cmd.type === 'set_model') && cmd.model && modelReference(cmd.model) && !this.supportsModelCatalogs)
      throw new HttpError(409,'현재 로컬 러너는 실제 모델 ID 선택을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내주세요');
    if ((cmd.type === 'start' || cmd.type === 'send') && cmd.skillSnapshot && !this.supportsSkillSnapshot)
      throw new HttpError(409, '현재 로컬 러너는 고정 스킬 버전을 지원하지 않습니다. 실행 중인 세션은 유지되며, 러너가 업데이트된 뒤 다시 보내주세요');
    if (cmd.type === 'start' && cmd.instructions !== undefined && cmd.instructions !== DEFAULT_INSTRUCTIONS && !this.supportsInstructions)
      throw new HttpError(409, '현재 로컬 러너는 사용자 지침을 지원하지 않습니다. 러너를 업데이트한 뒤 다시 보내주세요');
    if (cmd.type === 'start' && cmd.connectorMcp && !this.connectorMcpSupported)
      throw new HttpError(409, '외부 연결 도구를 사용하려면 로컬 러너를 업데이트하세요');
    if (cmd.type === 'start') {
      this.live.add(cmd.sessionId);
      const ipv6DeskMcpUrl = this.supportsIpv6Mcp ? this.options.ipv6DeskMcpUrl?.() : undefined;
      if (ipv6DeskMcpUrl) cmd = { ...cmd, ipv6DeskMcpUrl };
    }
    writeLine(this.socket, cmd);
  }

  /** Disconnects this authority without ending sessions in the independently living daemon. */
  close() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
    this.socket = null;
    this.id = null;
    this.live.clear();
  }

  private connect() {
    if (this.stopped) return;
    const socket = connect(this.options.port ?? RUNNER_PORT, this.options.host ?? RUNNER_HOST);
    this.socket = socket;
    let outputStream: string | undefined;
    let problem: RunnerConnectionProblem = 'unreachable';
    const handshake = setTimeout(() => socket.destroy(), 6000);
    socket.on('connect', () => {
      if (this.stopped) { socket.destroy(); return; }
      problem = 'authentication';
      // Read now rather than once: a runner started meanwhile may have just written it.
      try { writeLine(socket, { type: 'auth', token: (this.options.token ?? runnerToken)(), protocolVersion: PROTOCOL_VERSION, confirmOutput: true } satisfies HubToRunner); }
      catch { problem = 'token'; socket.destroy(); return; }
      readLines(socket, (raw) => {
        if (this.socket !== socket || socket.destroyed) return;
        if ((raw as { type?: string } | null)?.type === 'output') {
          const output = readOutput(raw);
          if (!output || !outputStream || !this.id) { socket.destroy(); return; }
          try {
            this.onMessage(output.message, { runnerId: this.id, stream: outputStream, sequence: output.sequence });
            writeLine(socket, { type: 'output_ack', sequence: output.sequence });
          } catch {
            // Reconnect without acknowledging. The runner will send the unconfirmed event again.
            console.error('로컬 러너 출력을 저장하지 못해 재연결합니다.');
            socket.destroy();
          }
          return;
        }
        const m = checkRunnerToHub(raw);
        if (typeof m === 'string') { console.error('러너 응답의 형식이 잘못되었습니다.'); return; }
        const hello = m.type === 'hello';
        if (m.type === 'hello') {
          clearTimeout(handshake);
          this.retryMs = RETRY_MS;
          this.connectionProblem = undefined;
          this.id = m.runnerId;
          outputStream = typeof m.outputStream === 'string' && m.outputStream.length === 36 ? m.outputStream : undefined;
          this.live = new Set(m.sessions.map((s) => s.sessionId));
          this.engines = new Set(m.capabilities.engines);
          this.supportsSkillSnapshot = !!m.capabilities.skillSnapshot;
          this.supportsInstructions = !!m.capabilities.instructions;
          this.supportsConnectorMcp = !!m.capabilities.connectorMcp;
          this.supportsIpv6Mcp = m.capabilities.ipv6Mcp === true;
          this.supportsModelCatalogs = m.capabilities.modelCatalogs !== undefined;
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
      if (!this.stopped && err.code === 'ECONNREFUSED' && this.options.spawnIfMissing !== false) {
        try { this.spawnDaemon(); } catch { console.error('로컬 러너를 시작하지 못했습니다. 실행 설정과 로그 파일 권한을 확인하세요.'); }
      }
      this.options.onError?.(err);
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      if (this.socket !== socket || this.stopped) return;
      if (this.connected) problem = 'disconnected';
      this.socket = null;
      this.id = null;
      this.live.clear();
      if (this.connectionProblem !== problem) {
        this.connectionProblem = problem;
        console.warn(connectionLog[problem]);
        this.onConnection(false, problem);
      }
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });
  }

  private spawnDaemon() {
    if (process.env.AGENT_DESK_MANAGED_RUNNERS === '1') return;
    const now = Date.now();
    if (now - this.lastSpawn < SPAWN_EVERY_MS) return;
    this.lastSpawn = now;
    mkdirSync(dirname(config.runner.log), { recursive: true });
    const log = openRuntimeLog(config.runner.log);
    try {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'daemon.ts')], {
        detached: true, stdio: ['ignore', log, log], env: process.env,
      });
      child.on('error', () => console.error('로컬 러너 프로세스를 시작하지 못했습니다.'));
      child.unref();
      console.log(`started runner daemon (pid ${child.pid}, log ${config.runner.log})`);
    } finally { closeSync(log); }
  }
}
