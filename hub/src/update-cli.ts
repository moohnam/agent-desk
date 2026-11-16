import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { readUpdateConfig, UpdateWorker, validateUpdateConfig, writePrivateJson } from './updater.ts';

const [command, configPath, ...args] = process.argv.slice(2);
if (!configPath || !['init', 'status', 'check', 'once', 'run'].includes(command)) {
  console.error('사용법: node hub/src/update-cli.ts init|status|check|once|run 설정파일 [init 옵션]');
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
  if (args.length) throw new Error('이 명령은 설정파일만 받습니다');
  const worker = new UpdateWorker(readUpdateConfig(resolve(configPath)));
  if (command === 'status') console.log(JSON.stringify({ deployment: worker.state(), runtimes: await worker.status() }, null, 2));
  else {
    worker.claim();
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    try {
      if (command === 'check') console.log(JSON.stringify({ prepared: await worker.prepare() }));
      else do {
        try { console.log(JSON.stringify({ activated: await worker.cycle(), state: worker.state() })); }
        catch (error) { console.error(error instanceof Error ? error.message : String(error)); if (command === 'once') { process.exitCode = 1; break; } }
        if (command !== 'run' || stopped) break;
        for (const deadline = Date.now() + worker.config.intervalMs; !stopped && Date.now() < deadline;) await delay(Math.min(1000, deadline - Date.now()));
      } while (!stopped);
    } finally { worker.close(); }
  }
}
