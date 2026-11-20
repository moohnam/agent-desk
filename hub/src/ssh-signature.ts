import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from './errors.ts';

const exec = promisify(execFile);
export const SSH_NAMESPACE = 'agent-desk-auth-v1';
export const SSH_ENROLL_NAMESPACE = 'agent-desk-connect-v1';
export async function agentPublicKeys() {
  if (!process.env.SSH_AUTH_SOCK) return [];
  try {
    const { stdout } = await exec('/usr/bin/ssh-add', ['-L'], { timeout: 3000, maxBuffer: 65536 });
    const keys = new Map<string, { key: string; fingerprint: string; comment: string }>();
    for (const line of stdout.trim().split('\n')) {
      try {
        const parsed = publicKey(line);
        keys.set(parsed.fingerprint, { ...parsed, comment: line.trim().split(/\s+/).slice(2).join(' ').slice(0, 100) });
      } catch { /* skip unsupported keys */ }
    }
    return [...keys.values()];
  } catch { return []; }
}
export function publicKey(input: unknown) {
  if (typeof input !== 'string' || input.length > 16384 || /[\r\n]/.test(input.trim())) throw new HttpError(400, '한 줄의 SSH 공개키가 필요합니다');
  const [type, encoded] = input.trim().split(/\s+/);
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(type) || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new HttpError(400, '지원하는 SSH 공개키 형식이 아닙니다');
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length < 12 || blob.readUInt32BE(0) !== type.length || blob.subarray(4,4+type.length).toString() !== type)
    throw new HttpError(400, 'SSH 공개키 내용이 잘못되었습니다');
  return { key: `${type} ${blob.toString('base64')}`, fingerprint: 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '') };
}
async function temporary<T>(work: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-sign-'));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function validatePublicKey(input: unknown) {
  const parsed = publicKey(input);
  await temporary(async dir => {
    const file = join(dir,'public'); await writeFile(file, parsed.key, {mode:0o600});
    try { await exec('/usr/bin/ssh-keygen', ['-l','-f',file], {timeout:5000,maxBuffer:16384}); }
    catch { throw new HttpError(400,'SSH 공개키를 검증하지 못했습니다'); }
  });
  return parsed;
}
export async function signWithAgent(key: string, message: string, namespace = SSH_NAMESPACE) {
  // Only a public key is written. ssh-keygen must use the local agent; no private-file fallback.
  if (!process.env.SSH_AUTH_SOCK) throw new HttpError(503,'허브의 ssh-agent 연결이 없습니다');
  return temporary(async dir => {
    const pub = join(dir,'public'), data = join(dir,'challenge');
    await writeFile(pub, publicKey(key).key, {mode:0o600}); await writeFile(data,message,{mode:0o600});
    try {
      await exec('/usr/bin/ssh-keygen',['-Y','sign','-f',pub,'-n',namespace,data],
        {timeout:15000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK,SSH_ASKPASS_REQUIRE:'never'}});
      const {readFile} = await import('node:fs/promises'); return await readFile(data+'.sig','utf8');
    } catch { throw new HttpError(503,'선택한 SSH 키를 ssh-agent에 등록한 뒤 다시 연결하세요'); }
  });
}
export async function verifySignature(key: string, message: string, signature: unknown, namespace = SSH_NAMESPACE) {
  if(typeof signature!=='string'||signature.length>16384)throw new HttpError(401,'SSH 서명이 필요합니다');
  return temporary(async dir => {
    const allowed=join(dir,'allowed'), sig=join(dir,'signature'), data=join(dir,'challenge');
    await writeFile(allowed,`desk namespaces="${namespace}" ${publicKey(key).key}\n`,{mode:0o600});
    await writeFile(sig,signature,{mode:0o600}); await writeFile(data,message,{mode:0o600});
    // execFile has no stdin option. A bounded child receives only the canonical server challenge.
    const { spawn }=await import('node:child_process');
    return await new Promise<boolean>(resolve=>{
      const child=spawn('/usr/bin/ssh-keygen',['-Y','verify','-f',allowed,'-I','desk','-n',namespace,'-s',sig],{stdio:['pipe','ignore','ignore'],env:{PATH:'/usr/bin:/bin'}});
      const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
      child.on('error',()=>{clearTimeout(timer);resolve(false);});
      child.on('close',code=>{clearTimeout(timer);resolve(code===0);});
      child.stdin.on('error',()=>{});child.stdin.end(message);
    });
  });
}
