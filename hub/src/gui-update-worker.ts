import { execFile, spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { guiUpdatePrefix } from './gui-update.ts';
import { assertTrustedPath } from './trusted-path.ts';
import { readUpdateConfig, UpdateWorker } from './updater.ts';

const [path,label]=process.argv.slice(2);
if (process.platform!=='darwin' || !path || !label?.startsWith(guiUpdatePrefix) ||
    !/^[0-9a-f-]{36}$/.test(label.slice(guiUpdatePrefix.length))) throw new Error('macOS 교체 작업 식별자가 올바르지 않습니다');
const service=`gui/${process.getuid!()}/${label}`;
try {
  const config = readUpdateConfig(path);
  const receipt = join(config.dataDir, 'update-logs', 'launch-jobs', label + '.json');
  assertTrustedPath(receipt,{kind:'file',private:true});
  const { token, environment } = JSON.parse(readFileSync(receipt, 'utf8'));
  if (typeof token!=='string' || !/^[0-9a-f-]{36}$/.test(token)) throw new Error('업데이트 승인 정보가 올바르지 않습니다');
  const cli=fileURLToPath(new URL('./update-cli.ts',import.meta.url));
  const child = spawn(process.execPath, [cli, 'apply', path, token], { stdio: 'inherit', env: { ...process.env, ...environment } });
  const stop=()=>{child.kill('SIGTERM');};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try {
    const [, [code]] = await Promise.all([
      once(child, 'spawn').then(() => unlinkSync(receipt)),
      once(child, 'exit'),
    ]);
    process.exitCode=code ?? 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    // A finished child cannot apply a pending approval later. Remove only its own approval.
    const worker = new UpdateWorker(config);
    try { worker.cancelApproval(undefined, token); }
    catch { /* Recovery owns the state once switching has begun. */ }
    finally { worker.close(); }
  }
} finally {
  // Runtimes started by the updater have detached; remove only this finished launchd job.
  execFile('/bin/launchctl',['bootout',service],{timeout:5000},()=>{});
}
