import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { readUpdateConfig, UpdateWorker, UpdateWorkerBusyError, validateUpdateConfig, writePrivateJson } from './updater.ts';

const [command, configPath, ...args] = process.argv.slice(2);
if (!configPath || !['init', 'status', 'check', 'once', 'run', 'approve', 'apply', 'cancel', 'start'].includes(command)) {
  console.error('사용법: node hub/src/update-cli.ts init|status|check|once|run|apply|start 설정파일 | approve 설정파일 SHA immediate|when-idle | cancel 설정파일 SHA');
  process.exitCode = 1;
} else if (command === 'init') {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--ref', '--deployment-dir', '--data-dir', '--roles', '--environment-file', '--interval-ms'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw new Error('init 옵션의 이름·값을 확인하세요');
    options.set(args[i], args[i + 1]);
  }
  const config = validateUpdateConfig({ version: 1, enabled: true, source: options.get('--source'), ref: options.get('--ref'),
    deploymentDir: options.get('--deployment-dir'), dataDir: options.get('--data-dir'), roles: options.get('--roles')?.split(','),
    environment: options.has('--environment-file') ? JSON.parse(readFileSync(resolve(options.get('--environment-file')!), 'utf8')) : {},
    intervalMs: Number(options.get('--interval-ms') ?? 300_000) });
  writePrivateJson(resolve(configPath), config, true);
  console.log('이 머신의 업데이트 설정만 만들었습니다. 기존 서비스·프로세스는 변경하지 않았습니다.');
} else {
    if (command === 'approve' ? args.length !== 2 : command === 'cancel' ? args.length !== 1 : command === 'apply' ? args.length > 1 || args[0] === '' : args.length)
    throw new Error('명령의 인수를 확인하세요');
  const worker = new UpdateWorker(readUpdateConfig(resolve(configPath)));
  if (command === 'status') console.log(JSON.stringify({ deployment: worker.state(), runtimes: await worker.status() }, null, 2));
  else if (command === 'cancel') {
    if (!/^[a-f0-9]{40}$/.test(args[0])) throw new Error('취소할 정확한 40자 커밋을 지정하세요');
    console.log(JSON.stringify({cancelled: worker.cancelApproval(args[0]), state: worker.state()}));
  }
  else {
    const approval = command === 'approve' ? worker.approve(args[0], args[1] as 'immediate' | 'when-idle')
      : command === 'apply' ? worker.state().approval : undefined;
    const token = command === 'apply' ? args[0] ?? approval?.token : approval?.token;
    if (command === 'apply' && !token) throw new Error('명시적 업데이트 승인이 필요합니다');
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    let claimed = false;
    while (!stopped && (!token || approval?.token === token && worker.state().approval?.token === token)) {
      try { worker.claim(); claimed = true; break; }
      catch (error) {
        if (!token || !(error instanceof UpdateWorkerBusyError)) throw error;
        // A one-shot check/start does not consume approvals. Wait for its lock or for this approval to disappear.
        await delay(250);
      }
    }
    if (claimed) {
      try {
        if (command === 'check') console.log(JSON.stringify({ prepared: await worker.prepare() }));
        else if (command === 'start') console.log(JSON.stringify({ started: await worker.startCurrent(), state: worker.state() }));
        else do {
          if (approval && worker.state().approval?.token !== approval.token) break;
          try {
            const activated = approval ? await worker.activate(approval.commit, approval.token) : await worker.cycle();
            console.log(JSON.stringify({ activated, state: worker.state() }));
          }
          catch (error) { console.error(error instanceof Error ? error.message : String(error)); if (command !== 'run') { process.exitCode = 1; break; } }
          if (stopped || (command !== 'run' && !(approval?.mode === 'when-idle' && worker.state().approval?.token === approval.token))) break;
          const waitingToken = worker.state().approval?.token;
          for (const deadline = Date.now() + worker.config.intervalMs; !stopped && Date.now() < deadline;) {
            await delay(Math.min(1000, deadline - Date.now()));
            if (worker.state().approval?.token !== waitingToken) break;
          }
        } while (!stopped);
      } finally { worker.close(); }
    }
  }
}
