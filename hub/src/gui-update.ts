import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTrustedPath } from './trusted-path.ts';
import { openRuntimeLog } from './runtime-log.ts';
import { inheritedUpdateEnvironment, readUpdateConfig, UpdateWorker, writePrivateJson } from './updater.ts';

const exec = promisify(execFile);
const launchctl = '/bin/launchctl';
export const guiUpdatePrefix = 'com.agent-desk.update.';
const wrapper = fileURLToPath(new URL('./gui-update-worker.ts', import.meta.url));
const xml = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

/** A launchd job created in the GUI domain can read the same keychain as other login services. */
export async function launchGuiUpdate(path: string, token: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const domain = `gui/${process.getuid!()}`;
  try { await exec(launchctl, ['print', domain], {timeout:5000, maxBuffer:2*1024*1024}); }
  catch (error) {
    if (typeof (error as {code?:unknown}).code==='number' && !(error as {killed?:boolean}).killed) return false;
    throw error;
  }
  const config = readUpdateConfig(path);
  const dir = join(config.dataDir, 'update-logs');
  const jobs=join(dir,'launch-jobs');
  assertTrustedPath(jobs,{kind:'directory',private:true,allowMissing:true});
  mkdirSync(jobs,{recursive:true,mode:0o700});
  assertTrustedPath(jobs,{kind:'directory',private:true});
  const label=guiUpdatePrefix+randomUUID(), receipt=join(jobs,label+'.json'), plist=join(jobs,label+'.plist');
  const log=join(dir,'worker.log');
  assertTrustedPath(log,{kind:'file',private:true,allowMissing:true});
  closeSync(openRuntimeLog(log));
  const args=[process.execPath,wrapper,path,label];
  let bootstrapStarted = false;
  try {
    writePrivateJson(receipt, { token, environment: inheritedUpdateEnvironment() }, true);
    writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg=>`<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`,{flag:'wx',mode:0o600});
    bootstrapStarted = true;
    await exec(launchctl,['bootstrap',domain,plist],{timeout:10000});
    for (const deadline = Date.now() + 5000; existsSync(receipt);) {
      if (Date.now() >= deadline) throw new Error('macOS 로그인 세션에서 업데이트 워커를 시작하지 못했습니다');
      await delay(50);
    }
    return true;
  } catch (error) {
    if (!bootstrapStarted) {
      if (existsSync(receipt)) unlinkSync(receipt);
      throw error;
    }
    // Registration can finish even if launchctl times out. Do not terminate a switch in progress.
    if (!existsSync(receipt)) return true;
    const worker = new UpdateWorker(config);
    try { worker.cancelApproval(undefined, token); }
    finally { worker.close(); }
    await exec(launchctl, ['bootout', `${domain}/${label}`], { timeout: 5000 }).catch(() => {});
    try { unlinkSync(receipt); } catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    throw error;
  } finally {
    // The loaded service no longer needs the plist. Its worker consumes the private receipt.
    try { unlinkSync(plist); } catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  }
}
