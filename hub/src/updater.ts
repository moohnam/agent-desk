import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest, type RuntimeRole, type RuntimeStatus } from './runtime-control.ts';
import { assertTrustedPath, assertTrustedTree, destinationPath } from './trusted-path.ts';
import { resolveLocalLaunchSettings } from './runner/local-launch.ts';
import { updateCiPassed, usesUpdateCi } from './update-ci.ts';
import { openRuntimeLog } from './runtime-log.ts';
import { managedPortEnvironment } from './ports.ts';

const exec = promisify(execFile);
const ROLES: RuntimeRole[] = ['daemon', 'local', 'hub', 'shared', 'remote'];
const ENTRY: Record<RuntimeRole, string> = { hub: 'hub/src/index.ts', daemon: 'hub/src/runner/daemon.ts', local: 'hub/src/runner/local.ts', shared: 'hub/src/runner/shared.ts', remote: 'hub/src/runner/remote.ts' };
export interface UpdateConfig {
  version: 1; enabled: true; source: string; ref: string; deploymentDir: string; dataDir: string;
  roles: RuntimeRole[]; environment: Record<string, string>; intervalMs: number;
}
type CandidateIdentity = Pick<RuntimeStatus, 'owner' | 'commit' | 'instance' | 'pid'>;
type PreparedRuntime = { role: RuntimeRole; runtime: RuntimeStatus; lease: string };
export interface UpdateApproval { commit: string; mode: 'immediate' | 'when-idle'; token: string }
export interface UpdateState { current?: string; candidate?: string; attempted?: string; restoreCurrent?: string; recovered?: string; blockedPort?: number; spentApproval?: string; approval?: UpdateApproval; started?: Partial<Record<RuntimeRole, CandidateIdentity>>; phase: 'preparing' | 'waiting' | 'switching' | 'active' | 'failed'; error?: string }
type WorkerLock = { host: string; pid: number; at?: number; token?: string };
export class UpdateWorkerBusyError extends Error {
  constructor() { super('이 배포 경로를 관리하는 워커가 이미 있습니다'); }
}
class RuntimePortError extends Error {
  readonly port: number;
  constructor(port: number, role: RuntimeRole) {
    super(`${role} 포트 ${port}을(를) 기존 프로세스가 사용 중입니다. 기존 작업이 끝나면 해당 서비스를 정상 종료한 뒤 다시 시도하세요`);
    this.port = port;
  }
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const within = (base: string, path: string) => { const rel = relative(base, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
const persistentEnvironmentPath = (key: string) => /(?:_DB|_DIR|_FILE|_HOME|RUNNER_LOG|AGENT_DESK_UPLOADS)$/.test(key);
/** Not for the runtimes or build commands: the launching agent session's identity and the terminal's state. */
const SESSION_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CODEX_THREAD_ID$|AI_AGENT$|GHOSTTY_|STARSHIP_|TERM_PROGRAM|XPC_|SECURITYSESSIONID$|SHLVL$|OLDPWD$|PWD$|_$)/;
export function inheritedUpdateEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(AGENT_DESK_|RUNNER_|PORT$|HOST$)/.test(key) && !SESSION_ENV.test(key)));
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
function previousBoot(at: number | undefined): boolean {
  if (at === undefined) return false;
  try { return at < Date.now() - uptime() * 1000 - 5000; }
  catch { return false; } // Some restricted environments cannot read the boot time.
}

/** Configuration is created explicitly on each machine, never supplied by another hub. */
export function validateUpdateConfig(value: unknown): UpdateConfig {
  const c = value as UpdateConfig;
  if (!c || c.version !== 1 || c.enabled !== true || typeof c.source !== 'string' || !c.source || c.source.startsWith('-')
    || typeof c.ref !== 'string' || !c.ref || c.ref.startsWith('-') || /[\s~^:?*\[\\]/.test(c.ref)
    || !isAbsolute(c.deploymentDir ?? '') || !isAbsolute(c.dataDir ?? '') || !Array.isArray(c.roles) || !c.roles.length
    || c.roles.some(r => !ROLES.includes(r)) || new Set(c.roles).size !== c.roles.length
    || !c.environment || typeof c.environment !== 'object' || Array.isArray(c.environment)
    || Object.values(c.environment).some(v => typeof v !== 'string') || !Number.isSafeInteger(c.intervalMs) || c.intervalMs < 1000)
    throw new Error('명시적 활성화·Git 소스/ref·절대 배포/데이터 경로·역할·환경·확인 주기가 필요합니다');
  const deploymentDir = resolve(c.deploymentDir), dataDir = resolve(c.dataDir);
  if (within(deploymentDir, dataDir) || within(dataDir, deploymentDir)) throw new Error('배포 경로와 데이터 경로는 서로 분리해야 합니다');
  if ((c.roles.includes('shared') || c.roles.includes('remote')) && c.roles.length !== 1)
    throw new Error('공유·원격 러너 워커는 각각 별도 설정으로 관리하세요');
  if (c.roles.includes('daemon') && !c.roles.includes('hub') && !c.roles.includes('local'))
    throw new Error('로컬 데몬은 입력을 차단할 허브 또는 로컬 작업공간과 함께 관리해야 합니다');
  if (c.roles.includes('local') && !c.roles.includes('daemon')) throw new Error('로컬 작업공간과 데몬은 함께 관리해야 합니다');
  if (isAbsolute(c.source) && (within(c.source, deploymentDir) || within(deploymentDir, c.source)))
    throw new Error('개발 체크아웃과 배포 경로는 서로 분리해야 합니다');
  for (const [key, val] of Object.entries(c.environment)) {
    if (!/^(AGENT_DESK_|RUNNER_|CODEX_BIN$|AGY_BIN$|PORT$|HOST$)/.test(key) || /UPDATE_|RELEASE_SHA|MANAGED_RUNNERS/.test(key))
      throw new Error(`지원하지 않는 실행 환경 설정: ${key}`);
    if (persistentEnvironmentPath(key) && (!isAbsolute(val) || within(deploymentDir, val)))
      throw new Error(`실행 데이터 경로는 배포 경로 밖의 절대 경로여야 합니다: ${key}`);
  }
  return { ...c, deploymentDir, dataDir, roles: ROLES.filter(r => c.roles.includes(r)) };
}

export function writePrivateJson(path: string, value: unknown, exclusive = false, durable = false) {
  assertTrustedPath(dirname(path), {kind: 'directory', allowMissing: true});
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertTrustedPath(dirname(path), {kind: 'directory'});
  assertTrustedPath(path, {kind: 'file', private: true, allowMissing: true});
  const temp = path + '.' + randomUUID();
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); if (durable) fsyncSync(fd); }
    finally { closeSync(fd); }
    if (exclusive) linkSync(temp, path);
    else renameSync(temp, path);
    if (durable) {
      const dir = openSync(dirname(path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function readUpdateConfig(path: string): UpdateConfig {
  assertTrustedPath(path, {kind: 'file', private: true});
  return validateUpdateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** A worker updates only its own detached runtimes. No SSH, port killing, service edits or DB restore. */
export class UpdateWorker {
  readonly config: UpdateConfig;
  readonly statePath: string;
  private lock?: { path: string; database: DatabaseSync; token: string };
  private readonly node: string;
  private readonly commandTimeoutMs: number;
  private readonly ciPassed: (commit: string) => Promise<boolean>;
  private prepareToken?: string;
  private prepareUncertain = false;
  private activating = false;
  /** Whether the activation in progress has stopped a runtime: only then is a failure an unfinished switch. */
  private switched = false;
  constructor(config: UpdateConfig, options: { node?: string; commandTimeoutMs?: number; ciPassed?: (commit: string) => Promise<boolean> } = {}) {
    this.config = validateUpdateConfig(config); this.node = options.node ?? process.execPath;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15 * 60_000;
    this.ciPassed = options.ciPassed ?? updateCiPassed;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) throw new Error('명령 제한 시간은 양의 정수여야 합니다');
    this.statePath = join(this.config.deploymentDir, 'state.json');
  }
  socket(role: RuntimeRole) { return join(this.config.dataDir, 'update-control', `${role}.sock`); }
  state(): UpdateState {
    assertTrustedPath(this.statePath, {kind: 'file', private: true, allowMissing: true});
    const state: UpdateState = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : { phase: 'preparing' };
    if ([state.current, state.candidate, state.attempted, state.restoreCurrent, state.recovered].some(value => value !== undefined && !sha(value))) throw new Error('배포 상태의 커밋 형식이 잘못되었습니다');
    return { ...state, approval: this.readApproval() };
  }
  // A candidate must never run with only a cached record that would allow an old binary to return after reboot.
  private save({ approval: _approval, ...state }: UpdateState) { writePrivateJson(this.statePath, state, false, true); }
  private get approvalPath() { return join(this.config.deploymentDir, 'approval.json'); }
  private readApproval(): UpdateApproval | undefined {
    assertTrustedPath(this.approvalPath, {kind: 'file', private: true, allowMissing: true});
    let value: UpdateApproval;
    try { value = JSON.parse(readFileSync(this.approvalPath, 'utf8')) as UpdateApproval; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!sha(value.commit) || !['immediate', 'when-idle'].includes(value.mode) || typeof value.token !== 'string' || !value.token)
      throw new Error('업데이트 승인 형식이 잘못되었습니다');
    return value;
  }
  private changeApproval<T>(change: () => T): T {
    const lock = join(this.config.deploymentDir, 'approval.lock');
    try { writePrivateJson(lock, {host: hostname(), pid: process.pid}, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('업데이트 승인 변경 잠금이 있습니다. 진행 중인 변경 또는 이전 프로세스의 종료를 확인하세요');
      throw error;
    }
    try { return change(); } finally { unlinkSync(lock); }
  }
  /** Records only an explicitly reviewed, verified SHA. The locked worker performs activation. */
  approve(commit: string, mode: UpdateApproval['mode']): UpdateApproval {
    if (!sha(commit) || !['immediate', 'when-idle'].includes(mode)) throw new Error('정확한 40자 커밋과 승인 방식을 지정하세요');
    return this.changeApproval(() => {
      const state = this.state();
      if (state.phase === 'switching') throw new Error('이미 업데이트를 적용 중입니다');
      if (state.approval) throw new Error('기존 업데이트 승인을 먼저 취소하세요');
      if (state.candidate !== commit) throw new Error('현재 확인한 업데이트 후보와 승인 커밋이 다릅니다');
      this.deploymentPaths(commit);
      if (!this.isVerifiedCandidate(commit)) throw new Error('검증하지 않은 후보는 승인할 수 없습니다');
      const approval = {commit, mode, token: randomUUID()};
      writePrivateJson(this.approvalPath, approval);
      return approval;
    });
  }
  /** Cross-process cancellation never rewrites deployment state or another approval. */
  cancelApproval(commit?: string, token?: string): boolean {
    return this.changeApproval(() => {
      if (this.state().phase === 'switching') throw new Error('이미 업데이트를 적용 중이라 취소할 수 없습니다');
      const approval = this.readApproval();
      if (!approval || (commit !== undefined && approval.commit !== commit) || (token !== undefined && approval.token !== token)) return false;
      unlinkSync(this.approvalPath); return true;
    });
  }
  private requireApproval(approval: UpdateApproval) {
    const current = this.readApproval();
    if (!current || current.token !== approval.token || current.commit !== approval.commit) throw new Error('업데이트 승인이 취소되거나 바뀌었습니다');
  }
  private marker(commit: string) { return join(this.config.deploymentDir, 'verified', commit + '.json'); }
  private verificationPolicy() {
    const checks = usesUpdateCi(this.config) ? 'github-main-ci-v1' : 1;
    return createHash('sha256').update(JSON.stringify({ source: this.config.source, node: process.version, checks })).digest('hex');
  }
  isVerifiedCandidate(commit: string): boolean {
    if (!sha(commit)) return false;
    const marker = this.marker(commit);
    assertTrustedPath(marker, {kind: 'file', private: true, allowMissing: true});
    if (!existsSync(marker)) return false;
    if (!usesUpdateCi(this.config)) return true;
    const recorded = JSON.parse(readFileSync(marker, 'utf8'));
    return recorded?.commit === commit && recorded.policy === this.verificationPolicy();
  }
  private owner() { return createHash('sha256').update(this.config.deploymentDir).digest('hex'); }
  claim() {
    if (this.lock) throw new UpdateWorkerBusyError();
    for (const path of [this.config.deploymentDir, this.config.dataDir]) assertTrustedPath(path, {kind: 'directory', allowMissing: true});
    mkdirSync(this.config.deploymentDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    for (const path of [this.config.deploymentDir, this.config.dataDir]) assertTrustedPath(path, {kind: 'directory'});
    // Resolve symlinks after creation as well as lexical paths before touching release files.
    const deployment = realpathSync(this.config.deploymentDir), data = realpathSync(this.config.dataDir);
    if (within(deployment, data) || within(data, deployment)) throw new Error('배포 경로와 데이터 경로가 같은 실제 경로를 가리킵니다');
    if (isAbsolute(this.config.source)) {
      const source = realpathSync(this.config.source);
      if (within(source, deployment) || within(deployment, source)) throw new Error('개발 체크아웃과 배포 경로가 겹칩니다');
    }
    for (const path of this.protectedPaths()) {
      if (within(deployment, path)) throw new Error('실행 데이터의 실제 저장 경로는 배포 경로 밖이어야 합니다');
    }
    const lockPath = join(deployment, 'worker.lock'), database = this.acquireWorkerDatabase(deployment);
    try {
      assertTrustedPath(lockPath, {kind: 'file', private: true, allowMissing: true});
      if (existsSync(lockPath)) {
        const old = JSON.parse(readFileSync(lockPath, 'utf8')) as WorkerLock;
        // Legacy workers have only a JSON marker. A PID from before this boot may have been reused.
        if (old.host !== hostname() || !Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('이전 워커 잠금의 호스트 또는 PID를 확인할 수 없습니다');
        // For a token-bearing marker the SQLite lock is authoritative, including after PID reuse.
        if (!old.token && alive(old.pid) && !previousBoot(typeof old.at === 'number' ? old.at : undefined)) throw new UpdateWorkerBusyError();
        unlinkSync(lockPath);
      }
      const token = randomUUID();
      writePrivateJson(lockPath, { host: hostname(), pid: process.pid, at: Date.now(), token }, true);
      this.lock = { path: lockPath, database, token };
    } catch (error) {
      database.close();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new UpdateWorkerBusyError();
      throw error;
    }
  }
  private acquireWorkerDatabase(deployment: string): DatabaseSync {
    const path = join(deployment, 'worker-lock.db');
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      assertTrustedPath(path + suffix, {kind: 'file', private: true, allowMissing: true});
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertTrustedPath(path, {kind: 'file', private: true});
    const database = new DatabaseSync(path);
    try {
      // The kernel releases SQLite's write lock on exit, even when worker.lock is left behind.
      database.exec('BEGIN IMMEDIATE');
      return database;
    } catch (error) {
      database.close();
      if ((error as {errcode?: number}).errcode === 5) throw new UpdateWorkerBusyError(); // SQLITE_BUSY
      throw error;
    }
  }
  close() {
    if (!this.lock) return;
    const {path, database, token} = this.lock;
    this.lock = undefined;
    try {
      assertTrustedPath(path, {kind: 'file', private: true, allowMissing: true});
      if (existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as WorkerLock).token === token) unlinkSync(path);
    } finally { database.close(); }
  }
  private async command(command: string, args: string[], cwd: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_DESK_|RUNNER_)/.test(key) && !SESSION_ENV.test(key)));
    const operation = exec(command, args, { cwd, env, timeout: this.commandTimeoutMs, maxBuffer: 2 * 1024 * 1024 });
    try {
      await operation;
      if (this.prepareToken && operation.child.killed) throw new Error('준비 명령을 중단해 후손 프로세스의 종료를 확인하지 못했습니다');
    } catch (error) {
      if (this.prepareToken) {
        const failure = error as NodeJS.ErrnoException & {killed?: boolean; signal?: string};
        const exited = typeof failure.code === 'number' && !failure.killed && !failure.signal;
        const notStarted = ['ENOENT','EACCES','ENOTDIR'].includes(String(failure.code)) && !operation.child.pid;
        if ((!exited && !notStarted) || operation.child.killed || operation.child.signalCode) this.prepareUncertain = true;
      }
      throw error;
    }
  }
  private deploymentPaths(commit?: string) {
    const root = this.config.deploymentDir;
    assertTrustedPath(root, {kind: 'directory'});
    for (const name of ['repository.git', 'releases', 'verified'])
      assertTrustedPath(join(root, name), {kind: 'directory', allowMissing: true});
    const mirror = join(root, 'repository.git');
    if (existsSync(mirror)) assertTrustedTree(mirror);
    if (commit) {
      assertTrustedPath(this.marker(commit), {kind: 'file', private: true, allowMissing: true});
      const release = join(root, 'releases', commit);
      assertTrustedPath(release, {kind: 'directory', allowMissing: true});
      if (existsSync(release)) assertTrustedTree(release);
    }
  }
  private preparationIdle(): string {
    const marker = join(this.config.deploymentDir,'prepare.pending.json');
    assertTrustedPath(marker,{kind:'file',private:true,allowMissing:true});
    if (existsSync(marker)) throw new Error(`이전 업데이트 준비의 프로세스 종료를 확인하지 못해 자동 준비를 막았습니다. 남은 설치·빌드·테스트 후손을 확인한 뒤 준비 표시를 복구하세요: ${marker}`);
    return marker;
  }
  async prepare(): Promise<string> {
    if (!this.lock) throw new Error('워커 잠금이 필요합니다');
    if (this.activating) throw new Error('업데이트 적용 중에는 후보를 준비할 수 없습니다');
    const marker = this.preparationIdle();
    const token = randomUUID(), identity = {version:1,host:hostname(),pid:process.pid,token,startedAt:new Date().toISOString()};
    writePrivateJson(marker,identity,true);
    this.prepareToken = token; this.prepareUncertain = false;
    try {
      const commit = await this.prepareRelease(), state = this.state();
      const attempted = state.attempted ?? ((state.phase === 'failed' || state.phase === 'switching') ? state.candidate : undefined);
      this.save({...state, candidate: commit, attempted, phase: state.phase === 'switching' ? 'failed' : commit === state.current ? 'active' : 'waiting', error: undefined});
      return commit;
    }
    catch (error) {
      if (this.prepareUncertain) throw new Error(`준비 명령이 중단되어 후손 프로세스의 종료를 확인하지 못했습니다. 준비 표시를 자동 삭제하지 않았습니다: ${marker}`,{cause:error});
      throw error;
    } finally {
      this.prepareToken = undefined;
      if (!this.prepareUncertain) {
        try {
          assertTrustedPath(marker,{kind:'file',private:true});
          const saved = JSON.parse(readFileSync(marker,'utf8')) as typeof identity;
          assertTrustedPath(this.lock.path,{kind:'file',private:true});
          const lock = JSON.parse(readFileSync(this.lock.path,'utf8')) as WorkerLock;
          if (saved.token !== token || saved.host !== hostname() || saved.pid !== process.pid
            || lock.host !== hostname() || lock.pid !== process.pid || lock.token !== this.lock.token) throw new Error('준비 표시 또는 워커 잠금의 소유자가 바뀌었습니다');
          unlinkSync(marker);
        } catch (error) {
          // Never clear an unknown owner's marker. Recreate a removed marker fail-closed where possible.
          if (!existsSync(marker)) writePrivateJson(marker,{...identity,error:'준비 종료 소유권을 확인하지 못했습니다'},true);
          throw new Error(`준비 종료 소유권을 확인하지 못해 자동 준비를 막았습니다: ${marker}`,{cause:error});
        }
      }
    }
  }
  private async prepareRelease(): Promise<string> {
    this.deploymentPaths(); this.protectedPaths();
    const root = this.config.deploymentDir, mirror = join(root, 'repository.git');
    if (!existsSync(mirror)) await this.command('git', ['clone', '--mirror', '--', this.config.source, mirror], root);
    else {
      const origin = await exec('git', ['--git-dir', mirror, 'remote', 'get-url', 'origin'], { maxBuffer: 4096 });
      if (origin.stdout.trim() !== this.config.source) throw new Error('설정의 Git 소스가 기존 배포 저장소와 다릅니다');
      // The next ownership check walks the mirror. Do not start maintenance that mutates it concurrently.
      await this.command('git', ['--git-dir', mirror, 'fetch', '--no-auto-gc', '--prune', 'origin'], root);
    }
    assertTrustedTree(mirror);
    const ci = usesUpdateCi(this.config), ref = ci ? 'refs/heads/main' : this.config.ref;
    const resolved = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', ref + '^{commit}'], { maxBuffer: 4096 });
    const commit = resolved.stdout.trim();
    if (!sha(commit)) throw new Error('Git 커밋을 고정하지 못했습니다');
    this.deploymentPaths(commit);
    const release = join(root, 'releases', commit), marker = this.marker(commit);
    const policy = this.verificationPolicy();
    if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).policy === policy && (!ci || this.isVerifiedCandidate(commit)) && existsSync(release)) {
      if (ci) await this.verifyCheckout(release,commit);
      return commit;
    }
    if (ci && !await this.ciPassed(commit)) throw new Error('이 커밋의 GitHub CI 통과가 아직 확인되지 않았습니다.');
    mkdirSync(dirname(release), { recursive: true, mode: 0o700 });
    if (!existsSync(release)) await this.command('git', ['--git-dir', mirror, 'worktree', 'add', '--detach', release, commit], root);
    if (ci) await this.verifyCheckout(release,commit);
    // An incomplete candidate remains isolated for inspection; npm ci recreates only its dependencies.
    const install = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], build = ['run', 'build'];
    const commands = ci ? [install, build] : [install, ['run', 'typecheck'], build, ['test']];
    for (const args of commands) {
      assertTrustedTree(release);
      await this.command('npm', args, release);
    }
    assertTrustedTree(release);
    for (const role of this.config.roles) if (!existsSync(join(release, ENTRY[role]))) throw new Error(`후보에 실행 진입점이 없습니다: ${role}`);
    writePrivateJson(marker, { commit, policy }); return commit;
  }
  private async verifyCheckout(release: string, commit: string) {
    const head = await exec('git', ['-C', release, 'rev-parse', 'HEAD'], { maxBuffer: 4096 });
    if (head.stdout.trim() !== commit) throw new Error('후보 체크아웃의 커밋이 바뀌었습니다');
    await this.command('git', ['diff', '--exit-code', 'HEAD', '--'], release);
  }
  private environment(role: RuntimeRole, commit: string): NodeJS.ProcessEnv {
    const d = this.config.dataDir;
    const inherited = inheritedUpdateEnvironment();
    const env = { ...inherited, AGENT_DESK_DB: join(d, 'agent-desk.db'),
      AGENT_DESK_UPLOADS: join(d, 'uploads'), AGENT_DESK_TOKEN_FILE: join(d, 'access-token'),
      AGENT_DESK_INSTRUCTIONS_FILE: join(d, 'instructions.md'), AGENT_DESK_SKILLS_HOME: join(d, 'desk-plugin'),
      AGENT_DESK_SHARED_DIR: join(d, 'shared-runner'), AGENT_DESK_REMOTE_DB: join(d, 'remote-runner.db'),
      AGENT_DESK_LOCAL_MODE_FILE: join(d, 'local-mode.json'), RUNNER_TOKEN_FILE: join(d, 'runner-token'),
      RUNNER_PID_FILE: join(d, 'runner.pid'), RUNNER_LOG: join(d, 'runner.log'),
      ...this.config.environment, AGENT_DESK_MANAGED_RUNNERS: '1', AGENT_DESK_RELEASE_SHA: commit,
      AGENT_DESK_UPDATE_OWNER: this.owner(),
      AGENT_DESK_UPDATE_SOCKET: this.socket(role) };
    return { ...managedPortEnvironment(d, env, role === 'shared'), ...env };
  }
  private protectedPaths(): string[] {
    const env = this.environment(this.config.roles[0], '0'.repeat(40));
    const dataDir = dirname(env.AGENT_DESK_DB!);
    const modeFile = env.AGENT_DESK_LOCAL_MODE_FILE ?? join(dataDir, 'local-mode.json');
    if (!(env.AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE && env.AGENT_DESK_GATEWAY_DB && env.AGENT_DESK_LOCAL_AUTHORITY_URL))
      assertTrustedPath(modeFile, {kind: 'file', allowMissing: true});
    const local = resolveLocalLaunchSettings(env, dataDir);
    const paths = [this.config.dataDir,
      ...Object.entries(env).filter(([key, value]) => /^(AGENT_DESK_|RUNNER_)/.test(key) && value !== undefined && persistentEnvironmentPath(key)).map(([, value]) => value!),
      local.gatewayDbPath, ...(local.tokenFile ? [local.tokenFile] : []),
      ...(this.config.roles.includes('shared') ? ['workspace.db', 'delivery.db', 'desk-plugin', 'engine-skills'].map(name => join(env.AGENT_DESK_SHARED_DIR!, name)) : [])];
    const resolved = paths.map(destinationPath), deployment = realpathSync(this.config.deploymentDir);
    if (resolved.some(path => within(deployment, path))) throw new Error('실행 데이터의 실제 저장 경로는 배포 경로 밖이어야 합니다');
    for (const path of paths) assertTrustedPath(path, {allowMissing: true});
    return [...resolved, ...(isAbsolute(this.config.source) ? [destinationPath(this.config.source)] : [])];
  }

  private async observe(role: RuntimeRole): Promise<RuntimeStatus | undefined> {
    try {
      const reply = await controlRequest(this.socket(role), { action: 'status' });
      if (!reply.ok || reply.status.role !== role || !sha(reply.status.commit) || reply.status.owner !== this.owner()) throw new Error('관리 런타임 신원 또는 배포 소유자가 다릅니다');
      return reply.status;
    } catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  }
  async status() { return Promise.all(this.config.roles.map(async role => ({ role, runtime: await this.observe(role) }))); }
  private async preflight(role: RuntimeRole, env: NodeJS.ProcessEnv) {
    // Old, unmanaged services have no control socket. Refuse before the candidate can migrate their DB.
    const port = role === 'hub' ? Number(env.PORT) : role === 'daemon' ? Number(env.RUNNER_PORT)
      : role === 'local' || role === 'shared' ? Number(env.AGENT_DESK_SHARED_PORT) : undefined;
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('관리 런타임 포트가 잘못되었습니다');
      const probe = createServer();
      try { await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, role === 'hub' ? env.HOST ?? '0.0.0.0' : '127.0.0.1', resolve); }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        throw new RuntimePortError(port, role);
      }
      finally { if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve())); }
    }
    const journal = role === 'remote' ? env.AGENT_DESK_REMOTE_DB : role === 'shared' ? join(env.AGENT_DESK_SHARED_DIR!, 'delivery.db') : undefined;
    if (journal && existsSync(journal)) {
      const db = new DatabaseSync(journal, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
          const row = db.prepare("SELECT value FROM meta WHERE key='lease'").get() as { value: string } | undefined;
          if (row) {
            const lease = JSON.parse(row.value) as { host: string; pid: number };
            if (lease.host !== hostname() || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || alive(lease.pid)) throw new Error('기존 러너가 전달 DB를 소유하고 있습니다. 기존 프로세스는 변경하지 않았습니다');
          }
        }
      } finally { db.close(); }
    }
  }
  /** Only a candidate this supervisor launched may bypass readiness for a graceful cleanup. */
  private async cleanupFailedCandidate(role: RuntimeRole, runtime: RuntimeStatus, beforeStop?: () => void) {
    const started = this.state().started?.[role];
    if (runtime.ready || !started || started.owner !== this.owner() || started.owner !== runtime.owner
      || started.commit !== runtime.commit || started.instance !== runtime.instance || started.pid !== runtime.pid)
      throw new Error(`${role} 미준비 런타임이 이 워커가 시작한 실패 후보인지 확인하지 못했습니다. 기존 프로세스는 종료하지 않았습니다`);
    if (runtime.reasons.length) throw new Error(`${role} 실패 후보에 미완료 작업이 있어 정리할 수 없습니다: ${runtime.reasons.join(', ')}`);
    const hold = await controlRequest(this.socket(role), { action: 'prepare-failed-candidate', instance: runtime.instance, owner: runtime.owner, commit: runtime.commit });
    if (!hold.ok || !hold.lease) throw new Error(`${role} 실패 후보 정리 준비 실패: ${hold.error ?? '소유권 확인 실패'}`);
    try {
      beforeStop?.();
      const reply = await controlRequest(this.socket(role), { action: 'stop', instance: runtime.instance, lease: hold.lease });
      if (!reply.ok) throw new Error(reply.error);
      for (const deadline = Date.now() + 10_000; alive(runtime.pid);) {
        if (Date.now() >= deadline) throw new Error('정상 종료를 확인하지 못했습니다');
        await delay(100);
      }
    } catch (error) {
      throw new Error(`${role} 실패 후보 정리 실패: ${error instanceof Error ? error.message : String(error)}. 강제 종료하거나 데이터를 되돌리지 않았습니다`);
    } finally {
      await controlRequest(this.socket(role), { action: 'cancel', instance: runtime.instance, lease: hold.lease }).catch(() => {});
    }
  }
  private async start(role: RuntimeRole, commit: string, beforeCandidate?: () => void) {
    let existing = await this.observe(role);
    if (existing) beforeCandidate?.();
    if (existing && !existing.ready) { await this.cleanupFailedCandidate(role, existing); existing = undefined; }
    if (existing) {
      if (existing.commit !== commit || !existing.ready) throw new Error(`${role} 기존 런타임의 커밋 또는 준비 상태가 다릅니다`);
      return;
    }
    const environment = this.environment(role, commit);
    await this.preflight(role, environment);
    this.deploymentPaths(commit); this.protectedPaths();
    const release = join(this.config.deploymentDir, 'releases', commit);
    assertTrustedPath(join(release, ENTRY[role]), {kind: 'file'});
    const logDir = join(this.config.dataDir, 'update-logs');
    assertTrustedPath(logDir, {kind: 'directory', allowMissing: true});
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    assertTrustedPath(join(logDir, `${role}.log`), {kind: 'file', private: true, allowMissing: true});
    const log = openRuntimeLog(join(logDir, `${role}.log`));
    let child;
    try {
      beforeCandidate?.();
      child = spawn(this.node, [join(release, ENTRY[role])], { cwd: release, env: environment, detached: true, stdio: ['ignore', log, log] });
    }
    finally { closeSync(log); }
    let failure: Error | undefined, recorded = false; child.on('error', error => { failure = error; }); child.unref();
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw failure ?? new Error(`${role} 후보가 준비 전에 종료되었습니다`);
      const state = await this.observe(role);
      if (state && state.commit === commit && state.pid === child.pid && !recorded) {
        const current = this.state();
        this.save({ ...current, started: { ...current.started, [role]: { owner: state.owner, commit, instance: state.instance, pid: state.pid } } });
        recorded = true;
      }
      if (state?.ready && state.commit === commit && state.pid === child.pid) return;
      if (state && state.pid !== child.pid) throw new Error(`${role} 소켓을 다른 프로세스가 소유합니다`);
      await delay(100);
    }
    throw new Error(`${role} 후보의 준비 확인 시간이 초과되었습니다. 강제 종료하거나 DB를 되돌리지 않았습니다`);
  }
  async activate(commit: string, expectedToken?: string): Promise<boolean> {
    if (!this.lock || !sha(commit)) throw new Error('워커 잠금과 고정 커밋이 필요합니다');
    const approval = this.readApproval();
    if (expectedToken !== undefined && approval?.token !== expectedToken) return false;
    if (!approval || approval.commit !== commit) {
      this.preparationIdle();
      throw new Error('정확한 커밋에 대한 명시적 업데이트 승인이 필요합니다');
    }
    if (this.state().spentApproval === approval.token) throw new Error('이미 사용한 업데이트 승인입니다. 취소 후 다시 승인하세요');
    if (this.activating) throw new Error('이미 업데이트를 적용 중입니다');
    this.activating = true; this.switched = false;
    let waiting = false;
    try { this.preparationIdle(); const activated = await this.activateApproved(commit, approval); waiting = !activated; return activated; }
    catch (error) {
      const state = this.state();
      const message = error instanceof Error ? error.message : String(error);
      this.save({...state, phase: this.switched ? 'failed' : state.phase, error: message, blockedPort: error instanceof RuntimePortError ? error.port : undefined});
      if (this.switched && state.restoreCurrent && state.restoreCurrent === state.current) {
        try { await this.restorePrevious(state); }
        catch (recovery) {
          this.save({ ...this.state(), blockedPort: recovery instanceof RuntimePortError ? recovery.port : undefined, error: `${message}\n이전 버전 복구를 마치지 못했습니다. ${recovery instanceof Error ? recovery.message : String(recovery)}` });
        }
      }
      throw error;
    }
    finally {
      this.activating = false;
      if (!waiting || approval.mode === 'immediate') {
        // Persist consumption before cleanup, so a competing/crashed approval writer cannot make a failed approval reusable.
        this.save({...this.state(), spentApproval: approval.token});
        // A consumed/cancelled approval cannot remove a newer approval.
        this.changeApproval(() => { if (this.readApproval()?.token === approval.token) unlinkSync(this.approvalPath); });
      }
    }
  }
  private async refreshPrepared(items: PreparedRuntime[]) {
    const checked = await Promise.allSettled(items.map(async ({ role, runtime, lease }) => {
      // Releases before lease renewal still support the prepared check and validate the token on stop.
      const request = runtime.leaseRenewal === true ? { action: 'renew' as const, instance: runtime.instance, lease } : { action: 'status' as const };
      const reply = await controlRequest(this.socket(role), request).catch(error => {
        throw new Error(`${role} 교체 준비 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
      const state = reply.status;
      if (!reply.ok || !state.prepared || !state.ready || state.reasons.length || state.instance !== runtime.instance
        || state.pid !== runtime.pid || state.role !== role || state.owner !== runtime.owner || state.commit !== runtime.commit)
        throw new Error(`${role} 교체 준비를 유지할 수 없습니다: ${reply.error ?? '잠금이 만료됐거나 런타임 상태가 바뀌었습니다'}`);
    }));
    const failed = checked.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  private async activateApproved(commit: string, approval: UpdateApproval): Promise<boolean> {
    this.deploymentPaths(commit); this.protectedPaths();
    if (!this.isVerifiedCandidate(commit)) throw new Error('검증하지 않은 후보는 실행할 수 없습니다');
    const previous = this.state(), prepared: PreparedRuntime[] = [];
    const release = join(this.config.deploymentDir, 'releases', commit);
    await this.verifyCheckout(release,commit);
    const anchor = previous.attempted ?? ((previous.phase === 'failed' || previous.phase === 'switching') ? previous.candidate ?? previous.current : previous.current);
    if (anchor && anchor !== commit) {
      try { await this.command('git', ['--git-dir', join(this.config.deploymentDir, 'repository.git'), 'merge-base', '--is-ancestor', anchor, commit], this.config.deploymentDir); }
      catch { throw new Error('자동 업데이트는 이전 실행 후보의 후속 커밋만 적용합니다. DB를 되돌리지 않았습니다'); }
    }
    let switching = false;
    let canRestore = !!previous.current && previous.current !== commit && !previous.attempted && previous.phase !== 'switching' && !Object.keys(previous.started ?? {}).length;
    const beforeCandidate = () => {
      canRestore = false;
      const state = this.state();
      if (state.restoreCurrent) this.save({ ...state, restoreCurrent: undefined });
    };
    const beginSwitch = () => {
      if (switching) return;
      this.changeApproval(() => {
        this.requireApproval(approval);
        // Commit the cancellation boundary immediately before the first stop, including failed-candidate cleanup.
        this.save({ ...this.state(), attempted: commit, restoreCurrent: canRestore ? previous.current : undefined, recovered: undefined, blockedPort: undefined, phase: 'switching', error: undefined });
        unlinkSync(this.approvalPath); switching = true; this.switched = true;
      });
    };
    try {
      for (const role of this.config.roles) {
        const runtime = await this.observe(role);
        if (runtime && runtime.commit !== previous.current) canRestore = false;
        if (!runtime) await this.preflight(role, this.environment(role, commit));
      }
      // Freeze input owners before their daemons; start later in the reverse dependency order.
      for (const role of [...this.config.roles].reverse()) {
        let runtime = await this.observe(role);
        if (runtime && runtime.commit !== previous.current) beforeCandidate();
        if (runtime && !runtime.ready) {
          if (!switching) this.requireApproval(approval);
          await this.refreshPrepared(prepared);
          await this.cleanupFailedCandidate(role, runtime, beginSwitch);
          runtime = undefined;
        }
        if (!runtime || runtime.commit === commit) continue;
        const reply = await controlRequest(this.socket(role), { action: 'prepare', instance: runtime.instance });
        if (!reply.ok || !reply.lease) {
          if (switching) throw new Error(reply.error ?? '실패 후보 정리 후 다른 런타임이 유휴 상태가 아닙니다');
          this.save({ ...this.state(), phase: 'waiting', error: reply.error }); return false;
        }
        prepared.push({ role, runtime, lease: reply.lease });
      }
      for (const [index, item] of prepared.entries()) {
        await this.refreshPrepared(prepared.slice(index));
        beginSwitch();
        const reply = await controlRequest(this.socket(item.role), { action: 'stop', instance: item.runtime.instance, lease: item.lease });
        if (!reply.ok) throw new Error(reply.error);
        for (const deadline = Date.now() + 10_000; alive(item.runtime.pid);) {
          if (Date.now() >= deadline) throw new Error(`${item.role} 정상 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다`);
          await delay(100);
        }
      }
      beginSwitch();
      for (const role of this.config.roles) await this.start(role, commit, beforeCandidate);
      const completed = this.state();
      this.save({ ...completed, current: commit, attempted: undefined, started: undefined, restoreCurrent: undefined, recovered: undefined, phase: completed.candidate && completed.candidate !== commit ? 'waiting' : 'active', error: undefined });
      try { this.pointCurrent(commit); }
      catch (error) { this.save({ ...this.state(), error: `현재 릴리스 링크를 갱신하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` }); }
      try { await this.pruneReleases(); }
      catch (error) { this.save({ ...this.state(), error: `오래된 릴리스 정리를 건너뛰었습니다: ${error instanceof Error ? error.message : String(error)}` }); }
      return true;
    } catch (error) {
      // Before the first stop nothing ran yet: the current runtimes stay and no anchor moves.
      const state = this.state();
      this.save({ ...state, attempted: switching ? commit : state.attempted, phase: switching ? 'failed' : state.phase, error: error instanceof Error ? error.message : String(error) }); throw error;
    } finally {
      await Promise.allSettled(prepared.map(item => controlRequest(this.socket(item.role), { action: 'cancel', instance: item.runtime.instance, lease: item.lease })));
    }
  }
  /** `current` → the activated release: a stable path for whatever starts the runtimes at login. */
  private pointCurrent(commit: string) {
    const link = join(this.config.deploymentDir, 'current'), temp = `${link}.${randomUUID()}`;
    symlinkSync(join('releases', commit), temp);
    try { renameSync(temp, link); } finally { if (existsSync(temp) || lstatSync(temp, { throwIfNoEntry: false })) unlinkSync(temp); }
  }
  /**
   * Starts the roles of the activated release that are not running (after a reboot, or a crash).
   * It never changes versions: a failed switch stays for a fixed successor commit, and a runtime of
   * another commit is left alone. Returns the roles it started.
   */
  async startCurrent(): Promise<RuntimeRole[]> {
    if (!this.lock) throw new Error('워커 잠금이 필요합니다');
    if (this.activating) throw new Error('이미 업데이트를 적용 중입니다');
    this.preparationIdle();
    const state = this.state(), commit = state.current;
    if (!commit) throw new Error('활성화한 릴리스가 없습니다. 후보를 준비하고 승인하세요');
    try {
      if (state.phase === 'switching' || state.attempted) {
        if (state.restoreCurrent === commit && state.attempted && state.attempted !== commit) return await this.restorePrevious(state);
        throw new Error('끝나지 않은 교체가 있습니다. 후보가 데이터를 변경했을 수 있습니다. status와 실행 로그를 확인하고 수정된 후속 커밋으로 복구하세요');
      }
      const started = await this.startVerifiedRelease(commit);
      if (state.blockedPort) this.save({ ...this.state(), blockedPort: undefined });
      return started;
    } catch (error) {
      if (error instanceof RuntimePortError) this.save({ ...this.state(), blockedPort: error.port, error: error.message });
      throw error;
    }
  }
  private async restorePrevious(state: UpdateState) {
    const commit = state.current!;
    const started = await this.startVerifiedRelease(commit);
    this.save({ ...this.state(), attempted: undefined, restoreCurrent: undefined, recovered: commit, started: undefined, blockedPort: undefined,
      phase: state.candidate && state.candidate !== commit ? 'waiting' : 'active',
      error: state.error ?? '새 버전 실행 전에 교체가 중단되었습니다.' });
    return started;
  }
  private async startVerifiedRelease(commit: string): Promise<RuntimeRole[]> {
    this.deploymentPaths(commit); this.protectedPaths();
    if (!existsSync(this.marker(commit))) throw new Error('검증하지 않은 릴리스는 실행할 수 없습니다');
    const release = join(this.config.deploymentDir, 'releases', commit);
    const head = await exec('git', ['-C', release, 'rev-parse', 'HEAD'], { maxBuffer: 4096 });
    if (head.stdout.trim() !== commit) throw new Error('현재 릴리스 체크아웃의 커밋이 바뀌었습니다');
    await this.command('git', ['diff', '--exit-code', 'HEAD', '--'], release);
    // Every missing role must have its port free before any starts, so a taken port leaves nothing half managed.
    const missing: RuntimeRole[] = [];
    for (const role of this.config.roles) {
      const runtime = await this.observe(role);
      if (runtime && runtime.commit !== commit) throw new Error(`${role} 런타임이 다른 커밋으로 실행 중입니다. 승인 절차로 교체하세요`);
      if (runtime?.ready) continue;
      if (!runtime) await this.preflight(role, this.environment(role, commit));
      missing.push(role);
    }
    for (const role of missing) await this.start(role, commit);
    if (missing.length) this.save({ ...this.state(), started: undefined });
    this.pointCurrent(commit);
    return missing;
  }
  /** Retain recovery/runtime anchors and three other recent releases; never traverse external roots. */
  async pruneReleases(): Promise<string[]> {
    if (!this.lock) throw new Error('워커 잠금이 필요합니다');
    this.preparationIdle();
    for (const path of [this.config.deploymentDir, this.config.dataDir]) assertTrustedPath(path, {kind: 'directory'});
    const protectedPaths = this.protectedPaths();
    const deployment = realpathSync(this.config.deploymentDir), releases = join(deployment, 'releases'), mirror = join(deployment, 'repository.git'), verified = join(deployment, 'verified');
    if (!existsSync(releases)) return [];
    for (const path of [releases, mirror, verified]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('릴리스 정리 경로가 일반 배포 디렉터리가 아닙니다');
      assertTrustedPath(path, {kind: 'directory'});
    }
    const state = this.state(), keep = new Set<string>([state.current, state.candidate, state.attempted, state.approval?.commit, ...Object.values(state.started ?? {}).map(value => value?.commit)].filter((value): value is string => !!value));
    for (const role of this.config.roles) {
      const runtime = await this.observe(role);
      if (!runtime) throw new Error(`${role} 실행 상태를 확인하지 못해 릴리스 정리를 건너뜁니다`);
      keep.add(runtime.commit);
    }
    const listing = await exec('git', ['--git-dir', mirror, 'worktree', 'list', '--porcelain', '-z'], {maxBuffer: 2 * 1024 * 1024});
    const registered = new Map<string, string>(); let worktree: string | undefined;
    for (const field of listing.stdout.split('\0')) {
      if (field.startsWith('worktree ')) worktree = resolve(field.slice(9));
      else if (field.startsWith('HEAD ') && worktree) registered.set(worktree, field.slice(5));
    }
    const candidates: {commit: string; path: string; at: number}[] = [];
    for (const commit of readdirSync(releases)) {
      if (!sha(commit)) continue;
      const path = join(releases, commit), stat = lstatSync(path);
      if (stat.isSymbolicLink() || realpathSync(path) !== path
        || protectedPaths.some(protectedPath => within(path, protectedPath) || within(protectedPath, path)))
        throw new Error('릴리스 정리 대상이 개발 체크아웃·데이터·외부 경로와 겹칩니다');
      if (!stat.isDirectory() || registered.get(path) !== commit || keep.has(commit)) continue;
      assertTrustedPath(path, {kind: 'directory'});
      const marker = this.marker(commit);
      candidates.push({commit, path, at: existsSync(marker) ? statSync(marker).mtimeMs : stat.mtimeMs});
    }
    const removed: string[] = [];
    for (const candidate of candidates.sort((a, b) => b.at - a.at || b.commit.localeCompare(a.commit)).slice(3)) {
      const currentProtectedPaths = this.protectedPaths();
      assertTrustedPath(candidate.path, {kind: 'directory'});
      if (currentProtectedPaths.some(path => within(candidate.path, path) || within(path, candidate.path)))
        throw new Error('정리 중 릴리스 경로가 데이터 저장 경로와 겹칩니다');
      if (lstatSync(candidate.path).isSymbolicLink() || realpathSync(candidate.path) !== candidate.path)
        throw new Error('정리 중 릴리스 경로가 바뀌었습니다');
      await this.command('git', ['--git-dir', mirror, 'worktree', 'remove', '--force', '--', candidate.path], deployment);
      const marker = this.marker(candidate.commit); if (existsSync(marker)) unlinkSync(marker);
      removed.push(candidate.commit);
    }
    return removed;
  }
  async cycle(): Promise<boolean> {
    if (!this.lock) throw new Error('워커 잠금이 필요합니다');
    const approval = this.readApproval();
    if (approval) return this.activate(approval.commit);
    await this.prepare();
    const pending = this.readApproval();
    return pending ? this.activate(pending.commit) : false;
  }
}
