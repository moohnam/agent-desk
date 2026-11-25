// Forward a proof scoped to one operation. The engine's reusable MCP credential stays at the gateway.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export function credentialDigest(token: string) { return createHash('sha256').update(token).digest('hex'); }
function signature(digest: string, fields: readonly unknown[]) {
  return createHmac('sha256',digest).update(JSON.stringify(fields)).digest('hex');
}
export function signRequest(token: unknown, fields: readonly unknown[]) {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return undefined;
  const nonce = randomUUID();
  return nonce + '.' + signature(credentialDigest(token),[nonce,...fields]);
}
export function verifyRequest(digest: string, fields: readonly unknown[], proof: unknown) {
  if (typeof proof !== 'string' || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(proof)) return false;
  const [nonce,mac] = proof.split('.');
  return timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(signature(digest,[nonce,...fields]),'hex'));
}
export function toolFields(name: string,args: Record<string,unknown>) {
  if (name === 'desk_settings') {
    return [name,args.session_id,args.task_id,args.section,args.action,args.revision,args.worktree,args.items];
  }
  return [name,args.session_id,args.task_id,args.to,args.question,args.question_id,args.answer,args.timeout_sec];
}
