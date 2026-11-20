import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateMode, UpdateSummary, UpdateView } from '../../shared/update.ts';
import { HttpError } from './errors.ts';
import { launchGuiUpdate } from './gui-update.ts';
import { assertTrustedPath } from './trusted-path.ts';
import { openRuntimeLog } from './runtime-log.ts';
import { readUpdateConfig, UpdateWorker, type UpdateApproval, type UpdateConfig } from './updater.ts';
import { updateCiPassed, usesUpdateCi } from './update-ci.ts';

const exec = promisify(execFile);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = fileURLToPath(new URL('./update-cli.ts', import.meta.url));
/** Capture the source checkout once, before a later git checkout can mislabel this running hub. */
const STARTED_SHA = (() => {
  if (sha(process.env.AGENT_DESK_RELEASE_SHA)) return process.env.AGENT_DESK_RELEASE_SHA;
  try { const value = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return sha(value) ? value : null; }
  catch { return null; }
})();

interface WorkerView {
  state: UpdateWorker['state'];
  status: UpdateWorker['status'];
  approve: UpdateWorker['approve'];
  cancelApproval: UpdateWorker['cancelApproval'];
  isVerifiedCandidate: UpdateWorker['isVerifiedCandidate'];
}
interface Options {
  configPath?: string;
  current?: string | null;
  worker?: (config: UpdateConfig) => WorkerView;
  runCheck?: (configPath: string) => Promise<void>;
  launchApproval?: (configPath: string, token: string) => Promise<void>;
  discover?: (config: UpdateConfig) => Promise<string | null>;
  ciPassed?: (commit: string) => Promise<boolean>;
}

/** Local settings facade. It never enables a service or adopts an unmanaged runtime. */
export class UpdateService {
  private readonly configPath: string;
  private readonly current: string | null;
  private readonly workerFactory: (config: UpdateConfig) => WorkerView;
  private readonly runCheck: (path: string) => Promise<void>;
  private readonly launchApproval: (path: string, token: string) => Promise<void>;
  private checking?: Promise<void>;
  private checkStarting = false;
  private approving = false;
  private failure: string | null = null;
  private summaryCache?: { key: string; value: UpdateSummary | null };
  private summaryPending?: { key: string; value: Promise<UpdateSummary | null> };
  private runtimeCache?: { key: string; until: number; value: ReturnType<WorkerView['status']> };
  private discovery?: { key: string; until: number; latest: string | null; error: string | null; ciPending?: boolean; pending?: Promise<void> };
  private discoveryChild?: ChildProcess;
  private closed = false;
  private readonly discoverOverride?: Options['discover'];
  private readonly ciPassed: (commit: string) => Promise<boolean>;
  private ciLookup?: { commit: string; until: number; result: Promise<boolean> };

  constructor(options: Options = {}) {
    this.configPath = options.configPath ?? join(homedir(), '.local/share/agent-desk/update.json');
    this.current = options.current === undefined ? STARTED_SHA : options.current;
    this.discoverOverride = options.discover;
    this.ciPassed = options.ciPassed ?? updateCiPassed;
    this.workerFactory = options.worker ?? (config => new UpdateWorker(config));
    this.runCheck = options.runCheck ?? (async path => { await exec(process.execPath, [CLI, 'check', path], { timeout: 20 * 60_000, maxBuffer: 64 * 1024 }); });
    this.launchApproval = options.launchApproval ?? (async (path,token) => {
      if (await launchGuiUpdate(path,token)) return;
      return new Promise((resolve, reject) => {
        // The worker must outlive this hub while replacing it. No shell or service edits; its output
        // goes to the data directory's update logs, where a failed switch can be read up afterwards.
        const dir = join(readUpdateConfig(path).dataDir, 'update-logs');
        const file = join(dir, 'worker.log');
        assertTrustedPath(dir, { kind: 'directory', allowMissing: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        assertTrustedPath(file, { kind: 'file', private: true, allowMissing: true });
        const log = openRuntimeLog(file);
        try {
          const child = spawn(process.execPath, [CLI, 'apply', path, token], { detached: true, stdio: ['ignore', log, log] });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        } finally { closeSync(log); }
      });
    });
  }

  private discover(config: UpdateConfig, refreshLatest = false) {
    const key = JSON.stringify([config.source, config.ref]);
    if (this.discovery?.key === key && (this.discovery.pending || !refreshLatest && this.discovery.until > Date.now())) return this.discovery;
    if (this.closed) return this.discovery;
    const entry = { key, until: Date.now() + 300_000, latest: null, error: null } as NonNullable<UpdateService['discovery']>;
    this.discovery = entry;
    const ci = usesUpdateCi(config), ref = ci ? 'refs/heads/main' : config.ref;
    // A pinned SHA cannot announce a moving version; custom rev expressions use explicit prepare.
    if (/^[a-f0-9]{40}$/.test(ref)) { entry.latest = ref; return entry; }
    const names = ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/') ? [ref]
      : !ref.startsWith('refs/') && !ref.startsWith('origin/') ? [`refs/heads/${ref}`, `refs/tags/${ref}`] : [];
    if (!names.length || names.some(name => !/^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(name))) {
      entry.error = '이 Git ref는 자동 발견을 지원하지 않습니다. 새 버전 확인으로 후보를 준비하세요.';
      return entry;
    }
    entry.pending = (async () => {
      let commit: string | null;
      if (this.discoverOverride) commit = await this.discoverOverride(config);
      else {
        const operation = exec('git', ['ls-remote', '--', config.source, ...names, ...names.filter(name => name.startsWith('refs/tags/')).map(name => `${name}^{}`)],
          { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        this.discoveryChild = operation.child;
        const response = await operation;
        const refs = new Map(response.stdout.trim().split('\n').filter(Boolean).map(line => {
          const [commit, name] = line.split(/\s+/); return [name, commit] as const;
        }));
        const commits = new Set(names.map(name => refs.get(name + '^{}') ?? refs.get(name)).filter(sha));
        if (commits.size !== 1) throw new Error('remote ref missing or ambiguous');
        commit = [...commits][0];
      }
      if (commit && ci && !await this.checkCi(commit)) {
        entry.ciPending = true;
        entry.until = Date.now() + 30_000;
      } else entry.latest = commit;
    })().catch(() => { entry.error = ci ? 'Git 또는 GitHub CI에 접속하지 못했습니다.' : '새 버전을 자동으로 찾지 못했습니다.'; })
      .finally(() => { entry.pending = undefined; this.discoveryChild = undefined; });
    return entry;
  }

  private checkCi(commit: string) {
    if (this.ciLookup?.commit === commit && this.ciLookup.until > Date.now()) return this.ciLookup.result;
    const lookup = { commit, until: Infinity, result: this.ciPassed(commit) };
    this.ciLookup = lookup;
    void lookup.result.then(passed => { lookup.until = Date.now() + (passed ? 300_000 : 30_000); }, () => { lookup.until = Date.now() + 30_000; });
    return lookup.result;
  }

  close() { this.closed = true; this.discoveryChild?.kill(); }

  private runtimes(config: UpdateConfig, worker: WorkerView) {
    const key = JSON.stringify([config.deploymentDir, config.dataDir, config.roles]);
    if (!this.runtimeCache || this.runtimeCache.key !== key || this.runtimeCache.until < Date.now()) {
      const entry = { key, until: Infinity, value: worker.status() };
      this.runtimeCache = entry;
      void entry.value.then(() => { entry.until = Date.now() + 2000; }, () => { entry.until = Date.now() + 2000; });
    }
    return this.runtimeCache.value;
  }

  private configuration(): { config: UpdateConfig; worker: WorkerView } | undefined {
    if (!existsSync(this.configPath)) return undefined;
    const config = readUpdateConfig(this.configPath);
    return { config, worker: this.workerFactory(config) };
  }

  private summary(config: UpdateConfig, candidate: string): Promise<UpdateSummary | null> {
    const key = [config.deploymentDir, this.current, candidate].join(':');
    if (this.summaryCache?.key === key) return Promise.resolve(this.summaryCache.value);
    if (this.summaryPending?.key === key) return this.summaryPending.value;
    const value = this.readSummary(config, candidate, key).finally(() => { if (this.summaryPending?.key === key) this.summaryPending = undefined; });
    this.summaryPending = { key, value };
    return value;
  }

  private async readSummary(config: UpdateConfig, candidate: string, key: string): Promise<UpdateSummary | null> {
    let value: UpdateSummary | null = null;
    if (this.current) try {
      const git = ['--git-dir', join(config.deploymentDir, 'repository.git')];
      const options = { timeout: 3000, maxBuffer: 256 * 1024 };
      const [log, diff] = await Promise.all([
        exec('git', [...git, 'log', '-20', '--format=%H%x00%s', `${this.current}..${candidate}`, '--'], options),
        exec('git', [...git, 'diff', '--name-only', '-z', this.current, candidate, '--'], options),
      ]);
      const files = diff.stdout.split('\0').filter(Boolean);
      const shared = files.some(file => file.startsWith('shared/'));
      value = { commits: log.stdout.trim().split('\n').filter(Boolean).flatMap(line => {
        const [commit, subject = ''] = line.split('\0');
        return sha(commit) ? [{ sha: commit, subject: subject.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) }] : [];
      }), files: files.length, hub: shared || files.some(file => file.startsWith('hub/') && !file.startsWith('hub/src/runner/')),
      runner: shared || files.some(file => file.startsWith('hub/src/runner/')) };
    } catch { /* An unknown anchor or oversized diff cannot produce a reliable summary. */ }
    this.summaryCache = { key, value };
    return value;
  }

  async view(refreshLatest = false): Promise<UpdateView> {
    const base = (): UpdateView => ({ configured: false, current: this.current, available: null, latest: null, discoveryError: null,
      phase: 'not-configured', checking: !!this.checking || this.checkStarting,
      targets: [], summary: null, canApply: false, reason: '이 머신의 업데이트 설정이 없습니다.', approval: null, error: this.failure });
    let configured: ReturnType<UpdateService['configuration']>;
    try { configured = this.configuration(); }
    catch { return { ...base(), phase: 'failed', reason: '업데이트 설정을 안전하게 읽을 수 없습니다. 이 머신에서 설정을 확인하세요.' }; }
    if (!configured) return base();
    const { config, worker } = configured;
    const discovered = this.discover(config, refreshLatest);
    if (refreshLatest) await discovered?.pending;
    const initial = base();
    const busyChecking = initial.checking;
    const result: UpdateView = { ...initial, configured: true, targets: config.roles, phase: busyChecking ? 'checking' : 'idle' };
    result.latest = discovered?.latest ?? null;
    result.discoveryError = discovered?.error ?? null;
    if (discovered?.ciPending) result.ciPending = true;
    try {
      const state = worker.state();
      result.available = sha(state.candidate) && (!usesUpdateCi(config) || worker.isVerifiedCandidate(state.candidate)) ? state.candidate : null;
      if (!busyChecking) result.phase = state.phase === 'preparing' ? (result.available ? 'ready' : 'idle') : state.phase;
      if (!busyChecking && state.phase === 'waiting' && !state.approval && !state.error && result.available) result.phase = 'ready';
      else if (!busyChecking && state.phase === 'waiting' && !state.approval && !state.error && !result.available) result.phase = 'idle';
      const waitingForWork = state.phase === 'waiting' && state.error === '작업이 유휴 상태가 아닙니다';
      if (state.phase === 'failed' || (state.error && !waitingForWork)) {
        result.error = state.recovered && state.recovered === state.current
          ? '이전 버전을 다시 띄웠습니다. 현재 작업은 이어서 진행할 수 있습니다. 실행 로그를 확인한 뒤 수정된 버전을 다시 적용하세요.'
          : state.attempted && !state.restoreCurrent
            ? '후보가 데이터를 변경했을 수 있습니다. 이 머신에서 실행 로그를 확인하고 수정된 후속 버전으로 복구하세요.'
            : state.blockedPort
              ? `${state.blockedPort} 포트를 사용하는 작업이 끝나면 해당 서비스를 정상 종료하고 다시 시도하세요.`
              : '업데이트 처리 중 문제가 발생했습니다. 이 머신의 워커 상태와 실행 로그를 확인하세요.';
        if (!busyChecking && state.phase === 'waiting') result.phase = 'failed';
      }
      const approval = state.approval;
      if (approval && sha(approval.commit) && ['immediate', 'when-idle'].includes(approval.mode)) result.approval = { commit: approval.commit, mode: approval.mode };
      const runtimes = await this.runtimes(config, worker);
      const managed = runtimes.length === config.roles.length && runtimes.every(item => !!item.runtime && item.runtime.ready
        && (item.role !== 'hub' || item.runtime.pid === process.pid && item.runtime.commit === this.current));
      result.reason = !managed ? '현재 서비스는 이 업데이트 워커가 관리하지 않거나 준비되지 않았습니다. 기존 수동 서비스를 자동으로 인계하지 않습니다.'
        : busyChecking ? '새 버전을 확인하고 검증하는 중입니다.'
        : this.approving || result.approval ? '승인한 버전을 처리 중입니다.'
        : state.phase === 'switching' ? '승인한 버전으로 교체 중입니다.'
        : !result.available ? '새 버전 확인을 눌러 후보를 준비하세요.'
        : config.roles.includes('hub') && result.available === this.current ? '현재 버전과 같습니다.' : null;
      result.canApply = result.reason === null;
      if (result.available) result.summary = await this.summary(config, result.available);
    } catch { result.reason = '업데이트 실행 상태를 안전하게 확인할 수 없습니다. 이 머신의 워커 상태를 확인하세요.'; result.phase = 'failed'; }
    return result;
  }

  async check(): Promise<UpdateView> {
    if (this.checking || this.checkStarting) return this.view();
    this.checkStarting = true;
    try {
      const view = await this.view();
      if (!view.configured || view.phase === 'failed' && !view.available) throw new HttpError(409, view.reason!);
      if (view.approval || this.approving || view.phase === 'switching') throw new HttpError(409, '승인한 버전의 처리가 끝난 뒤 다시 확인하세요.');
      this.failure = null;
      this.checking = Promise.resolve().then(() => this.runCheck(this.configPath)).catch(() => { this.failure = '새 버전을 준비하지 못했습니다. 이 머신의 워커 상태를 확인하세요.'; })
        .finally(() => { this.checking = undefined; this.summaryCache = undefined; });
    } finally { this.checkStarting = false; }
    return this.view();
  }

  async approve(commit: unknown, mode: unknown): Promise<UpdateView> {
    if (!sha(commit) || mode !== 'immediate' && mode !== 'when-idle') throw new HttpError(400, '정확한 40자리 커밋과 적용 방식을 지정하세요.');
    const view = await this.view();
    if (!view.canApply || view.available !== commit) throw new HttpError(409, view.available !== commit ? '확인한 새 버전이 바뀌었습니다. 다시 확인하세요.' : view.reason!);
    if (this.approving) throw new HttpError(409, '승인한 버전을 처리 중입니다.');
    this.approving = true; this.failure = null;
    let approval: UpdateApproval | undefined;
    let worker: WorkerView | undefined;
    try {
      worker = this.configuration()?.worker;
      if (!worker) throw new Error('configuration changed');
      approval = worker.approve(commit, mode);
      await this.launchApproval(this.configPath, approval.token);
    } catch {
      // Revoke only this request's token if the detached worker could not launch.
      try { if (approval) worker?.cancelApproval(commit, approval.token); } catch { /* Switching has already consumed this approval. */ }
      this.failure = approval ? '승인 워커를 시작하지 못했습니다.' : '후보가 바뀌었거나 검증되지 않아 승인하지 못했습니다. 다시 확인하세요.';
      throw new HttpError(409, this.failure);
    }
    finally { this.approving = false; }
    return this.view();
  }

  async cancel(commit: unknown): Promise<UpdateView> {
    if (!sha(commit)) throw new HttpError(400, '취소할 정확한 40자리 커밋을 지정하세요.');
    try {
      const configured = this.configuration();
      if (!configured) throw new HttpError(409, '이 머신의 업데이트 설정이 없습니다.');
      if (configured.worker.state().approval?.commit !== commit) throw new HttpError(409, '해당 커밋의 대기 중인 승인이 없습니다.');
      if (!configured.worker.cancelApproval(commit)) throw new HttpError(409, '해당 커밋의 대기 중인 승인이 없습니다.');
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(409, '승인을 안전하게 취소하지 못했습니다. 교체가 시작되었는지 확인하세요.'); }
    return this.view();
  }
}
