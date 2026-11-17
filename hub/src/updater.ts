import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest, type RuntimeRole, type RuntimeStatus } from './runtime-control.ts';
import { assertTrustedPath, assertTrustedTree, destinationPath } from './trusted-path.ts';
import { resolveLocalLaunchSettings } from './runner/local-launch.ts';

const exec = promisify(execFile);
const ROLES: RuntimeRole[] = ['daemon', 'local', 'hub', 'shared', 'remote'];
const ENTRY: Record<RuntimeRole, string> = { hub: 'hub/src/index.ts', daemon: 'hub/src/runner/daemon.ts', local: 'hub/src/runner/local.ts', shared: 'hub/src/runner/shared.ts', remote: 'hub/src/runner/remote.ts' };
export interface UpdateConfig {
  version: 1; enabled: true; source: string; ref: string; deploymentDir: string; dataDir: string;
  roles: RuntimeRole[]; environment: Record<string, string>; intervalMs: number;
}
type CandidateIdentity = Pick<RuntimeStatus, 'owner' | 'commit' | 'instance' | 'pid'>;
export interface UpdateState { current?: string; candidate?: string; started?: Partial<Record<RuntimeRole, CandidateIdentity>>; phase: 'preparing' | 'waiting' | 'switching' | 'active' | 'failed'; error?: string }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const within = (base: string, path: string) => { const rel = relative(base, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
const persistentEnvironmentPath = (key: string) => /(?:_DB|_DIR|_FILE|_HOME|RUNNER_LOG|AGENT_DESK_UPLOADS)$/.test(key);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

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

export function writePrivateJson(path: string, value: unknown, exclusive = false) {
  assertTrustedPath(dirname(path), {kind: 'directory', allowMissing: true});
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertTrustedPath(dirname(path), {kind: 'directory'});
  assertTrustedPath(path, {kind: 'file', private: true, allowMissing: true});
  if (exclusive) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); return; }
  const temp = path + '.' + randomUUID();
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
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
  private lock?: string;
  private readonly node: string;
  private readonly commandTimeoutMs: number;
  private prepareToken?: string;
  private prepareUncertain = false;
  constructor(config: UpdateConfig, options: { node?: string; commandTimeoutMs?: number } = {}) {
    this.config = validateUpdateConfig(config); this.node = options.node ?? process.execPath;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1) throw new Error('명령 제한 시간은 양의 정수여야 합니다');
    this.statePath = join(this.config.deploymentDir, 'state.json');
  }
  socket(role: RuntimeRole) { return join(this.config.dataDir, 'update-control', `${role}.sock`); }
  state(): UpdateState {
    assertTrustedPath(this.statePath, {kind: 'file', private: true, allowMissing: true});
    if (!existsSync(this.statePath)) return { phase: 'preparing' };
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as UpdateState;
    if ((state.current && !sha(state.current)) || (state.candidate && !sha(state.candidate))) throw new Error('배포 상태의 커밋 형식이 잘못되었습니다');
    return state;
  }
  private save(state: UpdateState) { writePrivateJson(this.statePath, state); }
  private marker(commit: string) { return join(this.config.deploymentDir, 'verified', commit + '.json'); }
  private owner() { return createHash('sha256').update(this.config.deploymentDir).digest('hex'); }
  claim() {
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
    const lock = join(this.config.deploymentDir, 'worker.lock');
    assertTrustedPath(lock, {kind: 'file', private: true, allowMissing: true});
    if (existsSync(lock)) {
      const old = JSON.parse(readFileSync(lock, 'utf8')) as { host: string; pid: number };
      if (old.host !== hostname() || !Number.isSafeInteger(old.pid) || old.pid < 1 || alive(old.pid)) throw new Error('이 배포 경로를 관리하는 워커가 이미 있습니다');
      unlinkSync(lock);
    }
    writePrivateJson(lock, { host: hostname(), pid: process.pid }, true); this.lock = lock;
  }
  close() { if (this.lock) { unlinkSync(this.lock); this.lock = undefined; } }
  private async command(command: string, args: string[], cwd: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_DESK_|RUNNER_)/.test(key)));
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
    const marker = this.preparationIdle();
    const token = randomUUID(), identity = {version:1,host:hostname(),pid:process.pid,token,startedAt:new Date().toISOString()};
    writePrivateJson(marker,identity,true);
    this.prepareToken = token; this.prepareUncertain = false;
    try { return await this.prepareRelease(); }
    catch (error) {
      if (this.prepareUncertain) throw new Error(`준비 명령이 중단되어 후손 프로세스의 종료를 확인하지 못했습니다. 준비 표시를 자동 삭제하지 않았습니다: ${marker}`,{cause:error});
      throw error;
    } finally {
      this.prepareToken = undefined;
      if (!this.prepareUncertain) {
        try {
          assertTrustedPath(marker,{kind:'file',private:true});
          const saved = JSON.parse(readFileSync(marker,'utf8')) as typeof identity;
          assertTrustedPath(this.lock,{kind:'file',private:true});
          const lock = JSON.parse(readFileSync(this.lock,'utf8')) as {host:string;pid:number};
          if (saved.token !== token || saved.host !== hostname() || saved.pid !== process.pid
            || lock.host !== hostname() || lock.pid !== process.pid) throw new Error('준비 표시 또는 워커 잠금의 소유자가 바뀌었습니다');
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
      await this.command('git', ['--git-dir', mirror, 'fetch', '--prune', 'origin'], root);
    }
    assertTrustedTree(mirror);
    const resolved = await exec('git', ['--git-dir', mirror, 'rev-parse', '--verify', this.config.ref + '^{commit}'], { maxBuffer: 4096 });
    const commit = resolved.stdout.trim();
    if (!sha(commit)) throw new Error('Git 커밋을 고정하지 못했습니다');
    this.deploymentPaths(commit);
    const release = join(root, 'releases', commit), marker = this.marker(commit);
    const policy = createHash('sha256').update(JSON.stringify({ source: this.config.source, node: process.version, checks: 1 })).digest('hex');
    if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).policy === policy && existsSync(release)) return commit;
    mkdirSync(dirname(release), { recursive: true, mode: 0o700 });
    if (!existsSync(release)) await this.command('git', ['--git-dir', mirror, 'worktree', 'add', '--detach', release, commit], root);
    // An incomplete candidate remains isolated for inspection; npm ci recreates only its dependencies.
    for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'typecheck'], ['run', 'build'], ['test']]) {
      assertTrustedTree(release);
      await this.command('npm', args, release);
    }
    assertTrustedTree(release);
    for (const role of this.config.roles) if (!existsSync(join(release, ENTRY[role]))) throw new Error(`후보에 실행 진입점이 없습니다: ${role}`);
    writePrivateJson(marker, { commit, policy }); return commit;
  }
  private environment(role: RuntimeRole, commit: string): NodeJS.ProcessEnv {
    const d = this.config.dataDir;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_DESK_|RUNNER_|PORT$|HOST$)/.test(key)));
    return { ...inherited, AGENT_DESK_DB: join(d, 'agent-desk.db'),
      AGENT_DESK_UPLOADS: join(d, 'uploads'), AGENT_DESK_TOKEN_FILE: join(d, 'access-token'),
      AGENT_DESK_INSTRUCTIONS_FILE: join(d, 'instructions.md'), AGENT_DESK_SKILLS_HOME: join(d, 'desk-plugin'),
      AGENT_DESK_SHARED_DIR: join(d, 'shared-runner'), AGENT_DESK_REMOTE_DB: join(d, 'remote-runner.db'),
      AGENT_DESK_LOCAL_MODE_FILE: join(d, 'local-mode.json'), RUNNER_TOKEN_FILE: join(d, 'runner-token'),
      RUNNER_PID_FILE: join(d, 'runner.pid'), RUNNER_LOG: join(d, 'runner.log'),
      ...this.config.environment, AGENT_DESK_MANAGED_RUNNERS: '1', AGENT_DESK_RELEASE_SHA: commit,
      AGENT_DESK_UPDATE_OWNER: this.owner(),
      AGENT_DESK_UPDATE_SOCKET: this.socket(role) };
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
    const port = role === 'hub' ? Number(env.PORT ?? 4317) : role === 'daemon' ? Number(env.RUNNER_PORT ?? 4318)
      : role === 'local' || role === 'shared' ? Number(env.AGENT_DESK_SHARED_PORT ?? 4321) : undefined;
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('관리 런타임 포트가 잘못되었습니다');
      const probe = createServer();
      try { await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, role === 'hub' ? env.HOST ?? '0.0.0.0' : '127.0.0.1', resolve); }); }
      catch { throw new Error(`${role} 포트를 기존 프로세스가 사용 중입니다. 기존 서비스는 변경하지 않았습니다`); }
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
  private async cleanupFailedCandidate(role: RuntimeRole, runtime: RuntimeStatus) {
    const started = this.state().started?.[role];
    if (runtime.ready || !started || started.owner !== this.owner() || started.owner !== runtime.owner
      || started.commit !== runtime.commit || started.instance !== runtime.instance || started.pid !== runtime.pid)
      throw new Error(`${role} 미준비 런타임이 이 워커가 시작한 실패 후보인지 확인하지 못했습니다. 기존 프로세스는 종료하지 않았습니다`);
    if (runtime.reasons.length) throw new Error(`${role} 실패 후보에 미완료 작업이 있어 정리할 수 없습니다: ${runtime.reasons.join(', ')}`);
    const hold = await controlRequest(this.socket(role), { action: 'prepare-failed-candidate', instance: runtime.instance, owner: runtime.owner, commit: runtime.commit });
    if (!hold.ok || !hold.lease) throw new Error(`${role} 실패 후보 정리 준비 실패: ${hold.error ?? '소유권 확인 실패'}`);
    try {
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
  private async start(role: RuntimeRole, commit: string) {
    let existing = await this.observe(role);
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
    const log = openSync(join(logDir, `${role}.log`), 'a', 0o600); chmodSync(join(logDir, `${role}.log`), 0o600);
    let child;
    try { child = spawn(this.node, [join(release, ENTRY[role])], { cwd: release, env: environment, detached: true, stdio: ['ignore', log, log] }); }
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
  async activate(commit: string): Promise<boolean> {
    if (!this.lock || !sha(commit)) throw new Error('워커 잠금과 고정 커밋이 필요합니다');
    this.preparationIdle();
    this.deploymentPaths(commit); this.protectedPaths();
    if (!existsSync(this.marker(commit))) throw new Error('검증하지 않은 후보는 실행할 수 없습니다');
    const previous = this.state(), prepared: { role: RuntimeRole; runtime: RuntimeStatus; lease: string }[] = [];
    const release = join(this.config.deploymentDir, 'releases', commit);
    const head = await exec('git', ['-C', release, 'rev-parse', 'HEAD'], { maxBuffer: 4096 });
    if (head.stdout.trim() !== commit) throw new Error('후보 체크아웃의 커밋이 바뀌었습니다');
    await this.command('git', ['diff', '--exit-code', 'HEAD', '--'], release);
    const anchor = (previous.phase === 'failed' || previous.phase === 'switching') ? previous.candidate ?? previous.current : previous.current;
    if (anchor && anchor !== commit) {
      try { await this.command('git', ['--git-dir', join(this.config.deploymentDir, 'repository.git'), 'merge-base', '--is-ancestor', anchor, commit], this.config.deploymentDir); }
      catch { throw new Error('자동 업데이트는 이전 실행 후보의 후속 커밋만 적용합니다. DB를 되돌리지 않았습니다'); }
    }
    try {
      for (const role of this.config.roles) if (!await this.observe(role)) await this.preflight(role, this.environment(role, commit));
      // Freeze input owners before their daemons; start later in the reverse dependency order.
      for (const role of [...this.config.roles].reverse()) {
        let runtime = await this.observe(role);
        if (runtime && !runtime.ready) { await this.cleanupFailedCandidate(role, runtime); runtime = undefined; }
        if (!runtime || runtime.commit === commit) continue;
        const reply = await controlRequest(this.socket(role), { action: 'prepare', instance: runtime.instance });
        if (!reply.ok || !reply.lease) {
          this.save({ ...previous, candidate: commit, phase: 'waiting', error: reply.error }); return false;
        }
        prepared.push({ role, runtime, lease: reply.lease });
      }
      this.save({ ...previous, candidate: commit, phase: 'switching', error: undefined });
      for (const item of prepared) {
        const reply = await controlRequest(this.socket(item.role), { action: 'stop', instance: item.runtime.instance, lease: item.lease });
        if (!reply.ok) throw new Error(reply.error);
        for (const deadline = Date.now() + 10_000; alive(item.runtime.pid);) {
          if (Date.now() >= deadline) throw new Error(`${item.role} 정상 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다`);
          await delay(100);
        }
      }
      for (const role of this.config.roles) await this.start(role, commit);
      this.save({ current: commit, phase: 'active' });
      try { await this.pruneReleases(); }
      catch (error) { this.save({ current: commit, phase: 'active', error: `오래된 릴리스 정리를 건너뛰었습니다: ${error instanceof Error ? error.message : String(error)}` }); }
      return true;
    } catch (error) {
      this.save({ ...previous, started: this.state().started, candidate: commit, phase: 'failed', error: error instanceof Error ? error.message : String(error) }); throw error;
    } finally {
      await Promise.allSettled(prepared.map(item => controlRequest(this.socket(item.role), { action: 'cancel', instance: item.runtime.instance, lease: item.lease })));
    }
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
    const state = this.state(), keep = new Set<string>([state.current, state.candidate, ...Object.values(state.started ?? {}).map(value => value?.commit)].filter((value): value is string => !!value));
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
    const state = this.state();
    // Resume an interrupted activation at its exact SHA. Never launch an old binary over a possibly migrated DB.
    if (state.candidate && state.phase === 'switching') return this.activate(state.candidate);
    const commit = await this.prepare(); return this.activate(commit);
  }
}
