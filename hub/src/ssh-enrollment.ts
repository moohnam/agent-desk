import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SshConnectRequest } from '../../shared/workspace.ts';
import { HttpError } from './errors.ts';
import type { SshAuthority } from './ssh-authority.ts';
import { publicKey, SSH_ENROLL_NAMESPACE, verifySignature } from './ssh-signature.ts';

const minute = 60_000;
const id = () => randomBytes(32).toString('base64url');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value))
    throw new HttpError(400, '허브 이름과 소유자 표시 이름을 입력하세요');
  return value.trim();
}
type Pending = SshConnectRequest & { key: string; expires: number; decision: number };
type Challenge = Omit<Pending, 'created_at' | 'decision'> & { message: string };
export function enrollmentMessage(workspaceId: string, challenge: Pick<Challenge, 'id' | 'fingerprint' | 'expires' | 'name' | 'ownerName'>) {
  return JSON.stringify({ workspaceId, namespace: SSH_ENROLL_NAMESPACE, id: challenge.id, fingerprint: challenge.fingerprint,
    name: challenge.name, ownerName: challenge.ownerName, expires: challenge.expires });
}

export class SshEnrollment {
  private readonly db: DatabaseSync;
  private readonly ssh: SshAuthority;
  private verifying = 0;

  constructor(db: DatabaseSync, ssh: SshAuthority) {
    this.db=db; this.ssh=ssh;
    db.exec(`CREATE TABLE IF NOT EXISTS ssh_enrollment_challenge (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, fingerprint TEXT NOT NULL, name TEXT NOT NULL, ownerName TEXT NOT NULL,
      expires INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ssh_enrollment_request (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ownerName TEXT NOT NULL,
      created_at TEXT NOT NULL, expires INTEGER NOT NULL, decision INTEGER NOT NULL DEFAULT 0);`);
  }

  private cleanup() {
    this.db.prepare('DELETE FROM ssh_enrollment_challenge WHERE expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM ssh_enrollment_request WHERE expires<=?').run(Date.now());
  }

  challenge(body: { workspaceId?: unknown; publicKey?: unknown; name?: unknown; ownerName?: unknown }) {
    if (!this.ssh.enabled || body.workspaceId !== this.ssh.workspaceId) throw new HttpError(404, '연결할 작업공간을 확인하세요');
    this.cleanup();
    const key = publicKey(body.publicKey);
    if (this.ssh.peers().some(peer=>peer.revoked && peer.fingerprint===key.fingerprint))
      throw new HttpError(409,'연결 권한이 취소된 공개키입니다. 새 공개키로 요청하세요');
    const challenge = { id: id(), ...key, name: name(body.name), ownerName: name(body.ownerName), expires: Date.now()+minute };
    const message = enrollmentMessage(this.ssh.workspaceId, challenge);
    if (this.db.prepare('SELECT count(*) AS n FROM ssh_enrollment_challenge').get()!.n as number >= 64)
      throw new HttpError(429, '연결 요청이 많습니다. 잠시 뒤 다시 시도하세요');
    this.db.prepare('INSERT INTO ssh_enrollment_challenge VALUES (?,?,?,?,?,?,?)')
      .run(challenge.id,key.key,key.fingerprint,challenge.name,challenge.ownerName,challenge.expires,message);
    return { id: challenge.id, message, expires: challenge.expires };
  }

  async submit(body: { id?: unknown; signature?: unknown }) {
    if (!this.ssh.enabled || !validId(body.id)) throw new HttpError(400, '연결 요청이 올바르지 않습니다');
    if (this.verifying >= 4) throw new HttpError(429,'연결 요청이 많습니다. 잠시 뒤 다시 시도하세요');
    const proof = this.db.prepare('DELETE FROM ssh_enrollment_challenge WHERE id=? RETURNING *').get(body.id) as Challenge | undefined;
    if (!proof || proof.expires <= Date.now()) throw new HttpError(401, '유효한 공개키 서명을 확인하지 못했습니다');
    this.verifying++;
    let verified: boolean;
    try { verified=await verifySignature(proof.key,proof.message,body.signature,SSH_ENROLL_NAMESPACE); }
    finally { this.verifying--; }
    if (!verified || proof.expires<=Date.now()) throw new HttpError(401, '유효한 공개키 서명을 확인하지 못했습니다');
    if (this.ssh.peers().some(peer=>peer.revoked && peer.fingerprint===proof.fingerprint))
      throw new HttpError(409,'연결 권한이 취소된 공개키입니다. 새 공개키로 요청하세요');
    this.cleanup();
    const existing = this.db.prepare('SELECT id FROM ssh_enrollment_request WHERE fingerprint=?').get(proof.fingerprint);
    if (existing) return { id: existing.id as string };
    if (this.db.prepare('SELECT count(*) AS n FROM ssh_enrollment_request').get()!.n as number >= 64)
      throw new HttpError(429, '연결 요청이 많습니다. 잠시 뒤 다시 시도하세요');
    const requestId = id();
    this.db.prepare('INSERT INTO ssh_enrollment_request(id,key,fingerprint,name,ownerName,created_at,expires) VALUES(?,?,?,?,?,?,?)')
      .run(requestId,proof.key,proof.fingerprint,proof.name,proof.ownerName,new Date().toISOString(),Date.now()+15*minute);
    return { id: requestId };
  }

  state(requestId: unknown) {
    this.cleanup();
    const request = this.get(requestId);
    if (!request) return { status: 'expired' as const };
    if (request.decision === -1) return { status: 'rejected' as const };
    return { status: this.approved(request) ? 'approved' as const : request.decision !== 0 ? 'rejected' as const : 'pending' as const };
  }

  private get(requestId: unknown) {
    return validId(requestId) ? this.db.prepare('SELECT * FROM ssh_enrollment_request WHERE id=? AND expires>?')
      .get(requestId,Date.now()) as Pending | undefined : undefined;
  }

  private approved(request: Pending) {
    return this.ssh.peers().some(peer => !peer.revoked && peer.fingerprint === request.fingerprint);
  }

  list(peer: string): SshConnectRequest[] {
    this.ssh.assertAdmin(peer);
    this.cleanup();
    return (this.db.prepare('SELECT * FROM ssh_enrollment_request WHERE decision=0 ORDER BY created_at').all() as unknown as Pending[])
      .filter(request => !this.approved(request)).map(({ id, name, ownerName, fingerprint, created_at }) =>
        ({ id, name, ownerName, fingerprint, created_at }));
  }

  async decide(peer: string, requestId: string, approve: boolean, authorize: () => void) {
    const current = () => {
      authorize();
      this.ssh.assertAdmin(peer);
      const pending = this.get(requestId);
      if (!pending || pending.decision !== 0 || this.approved(pending)) throw new HttpError(409, '이미 처리했거나 만료된 요청입니다');
      return pending;
    };
    const pending = current();
    const decide = (decision: number) => this.db.prepare('UPDATE ssh_enrollment_request SET decision=? WHERE id=?').run(decision,requestId);
    if (approve) await this.ssh.register({ ...pending, publicKey: pending.key },peer,undefined,() => { current(); },() => { decide(1); });
    else decide(-1);
  }
}
