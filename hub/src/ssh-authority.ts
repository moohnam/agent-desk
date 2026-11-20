import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.ts';
import { SSH_NAMESPACE, validatePublicKey, verifySignature } from './ssh-signature.ts';
export interface HubIdentity { peerId:string; ownerId:string; ownerName:string; fingerprint:string }
export interface SshPeer extends HubIdentity { name:string; publicKey:string; admin:boolean; revoked:boolean }
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>100||/[\x00-\x1f]/.test(v))throw new HttpError(400,'이름은 1~100자여야 합니다');return v.trim();};
export class SshAuthority {
  private db:DatabaseSync; readonly workspaceId:string;
  constructor(db:DatabaseSync,workspaceId:string){
    this.db=db;this.workspaceId=workspaceId;
    db.exec(`CREATE TABLE IF NOT EXISTS ssh_auth_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ssh_peer (peer_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,owner_name TEXT NOT NULL,public_key TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,admin INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ssh_challenge (id TEXT PRIMARY KEY,peer_id TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ssh_session (token_hash TEXT PRIMARY KEY,peer_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ssh_generation (peer_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);`);
    if(!(db.prepare('PRAGMA table_info(ssh_challenge)').all() as {name:string}[]).some(column=>column.name==='generation'))
      db.exec('ALTER TABLE ssh_challenge ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    if(!(db.prepare('PRAGMA table_info(ssh_session)').all() as {name:string}[]).some(column=>column.name==='generation'))
      db.exec('ALTER TABLE ssh_session ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  }
  get enabled(){return !!this.db.prepare('SELECT 1 FROM ssh_auth_config WHERE id=1 AND enabled=1').get();}
  peers():SshPeer[]{return (this.db.prepare(`SELECT s.*,p.name,p.revoked FROM ssh_peer s JOIN workspace_peer p ON p.id=s.peer_id`).all() as any[]).map(p=>({peerId:p.peer_id,ownerId:p.owner_id,ownerName:p.owner_name,publicKey:p.public_key,fingerprint:p.fingerprint,name:p.name,admin:!!p.admin,revoked:!!p.revoked}));}
  identity(peer:string){const p=this.peers().find(p=>p.peerId===peer&&!p.revoked);if(!p)throw new HttpError(401,'허브 연결 권한이 취소되었습니다');return p;}
  assertAdmin(peer:string){if(!this.identity(peer).admin)throw new HttpError(403,'첫 관리자 허브만 연결을 승인할 수 있습니다');}
  async register(input:{name?:unknown;ownerName?:unknown;publicKey?:unknown},adminPeer?:string,existingPeer?:string,authorize?:()=>void){
    authorize?.();
    if(adminPeer)this.assertAdmin(adminPeer);else if(this.enabled)throw new HttpError(409,'첫 관리자 등록은 이미 완료됐습니다');
    const name=text(input.name),ownerName=text(input.ownerName),key=await validatePublicKey(input.publicKey);
    this.db.exec('SAVEPOINT ssh_register');
    try{
      authorize?.();
      if(adminPeer)this.assertAdmin(adminPeer);else if(this.enabled)throw new HttpError(409,'첫 관리자 등록은 이미 완료됐습니다');
      if(this.db.prepare('SELECT 1 FROM ssh_peer WHERE fingerprint=?').get(key.fingerprint))throw new HttpError(409,'이미 등록한 공개키입니다');
      if(existingPeer && (adminPeer || !this.db.prepare('SELECT 1 FROM workspace_peer WHERE id=? AND revoked=0').get(existingPeer)))throw new HttpError(409,'기존 허브를 최초 관리자로 전환할 수 없습니다');
      const peer=existingPeer ?? randomUUID();
      if(!existingPeer)this.db.prepare('INSERT INTO workspace_peer(id,name,token_hash) VALUES (?,?,?)').run(peer,name,hash(randomBytes(32).toString('hex')));
      this.db.prepare('INSERT INTO ssh_peer VALUES (?,?,?,?,?,?)').run(peer,randomUUID(),ownerName,key.key,key.fingerprint,adminPeer?0:1);
      this.db.prepare('INSERT OR IGNORE INTO ssh_auth_config VALUES(1,1)').run();
      this.db.exec('RELEASE ssh_register');return this.identity(peer);
    }catch(e){this.db.exec('ROLLBACK TO ssh_register; RELEASE ssh_register');throw e;}
  }
  /** Local recovery retains the hub and owner IDs but invalidates all old credentials. */
  async rotate(peerId:string,input:unknown) {
    this.identity(peerId);
    const key=await validatePublicKey(input);
    this.db.exec('SAVEPOINT ssh_rotate');
    try {
      this.identity(peerId);
      if(this.peers().some(p=>p.peerId!==peerId&&p.fingerprint===key.fingerprint))throw new HttpError(409,'다른 허브가 사용하는 공개키입니다');
      this.db.prepare('UPDATE ssh_peer SET public_key=?,fingerprint=? WHERE peer_id=?').run(key.key,key.fingerprint,peerId);
      this.invalidate(peerId);
      this.db.exec('RELEASE ssh_rotate');return this.identity(peerId);
    } catch(error) {this.db.exec('ROLLBACK TO ssh_rotate; RELEASE ssh_rotate');throw error;}
  }
  challenge(fingerprint:unknown,workspace:unknown){
    if(!this.enabled||workspace!==this.workspaceId)throw new HttpError(401,'연결 대상 작업공간을 확인하세요');
    const peer=this.peers().find(p=>p.fingerprint===fingerprint&&!p.revoked);
    if(!peer)throw new HttpError(401,'등록되지 않았거나 취소된 공개키입니다');
    const now=Date.now();this.db.prepare('DELETE FROM ssh_challenge WHERE expires<=?').run(now);
    if(Number((this.db.prepare('SELECT count(*) n FROM ssh_challenge').get() as any).n)>=128)throw new HttpError(429,'인증 요청이 많습니다. 잠시 뒤 다시 시도하세요');
    const id=randomBytes(32).toString('base64url'),expires=now+60_000;
    const message=JSON.stringify({version:1,namespace:SSH_NAMESPACE,workspaceId:this.workspaceId,peerId:peer.peerId,fingerprint:peer.fingerprint,nonce:id,expires});
    this.db.prepare('INSERT INTO ssh_challenge(id,peer_id,message,expires,generation) VALUES(?,?,?,?,?)').run(id,peer.peerId,message,expires,this.generation(peer.peerId));
    return {id,message,expires};
  }
  async authenticateChallenge(id:unknown,signature:unknown){
    if(typeof id!=='string'||id.length>100)throw new HttpError(401,'인증 요청이 잘못되었습니다');
    // Consumed before async verification; concurrent replay cannot issue another session.
    const c=this.db.prepare('DELETE FROM ssh_challenge WHERE id=? RETURNING *').get(id) as {peer_id:string;message:string;expires:number;generation:number}|undefined;
    if(!c||c.expires<=Date.now())throw new HttpError(401,'인증 요청이 만료됐거나 이미 사용됐습니다');
    const peer=this.identity(c.peer_id);
    const generation=c.generation;
    if(!await verifySignature(peer.publicKey,c.message,signature))throw new HttpError(401,'SSH 서명이 일치하지 않습니다');
    const latest=this.identity(peer.peerId);
    if(latest.fingerprint!==peer.fingerprint||generation!==this.generation(peer.peerId)||c.expires<=Date.now())throw new HttpError(401,'인증 정보가 변경됐습니다');
    const token=randomBytes(32).toString('base64url'),expires=Date.now()+15*60_000;
    this.db.prepare('DELETE FROM ssh_session WHERE expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM ssh_session WHERE token_hash IN (SELECT token_hash FROM ssh_session WHERE peer_id=? ORDER BY expires DESC LIMIT -1 OFFSET 7)').run(peer.peerId);
    this.db.prepare('INSERT INTO ssh_session(token_hash,peer_id,expires,generation) VALUES(?,?,?,?)').run(hash(token),peer.peerId,expires,generation);
    return {token,expires,peer:latest,workspaceId:this.workspaceId};
  }
  authenticate(token:string){
    const s=this.db.prepare('SELECT s.peer_id FROM ssh_session s LEFT JOIN ssh_generation g ON g.peer_id=s.peer_id WHERE s.token_hash=? AND s.expires>? AND s.generation=coalesce(g.generation,0)').get(hash(token),Date.now()) as {peer_id:string}|undefined;
    if(!s)throw new HttpError(401,'SSH 인증 세션이 만료됐습니다');
    return this.identity(s.peer_id).peerId;
  }
  private generation(peer:string){return (this.db.prepare('SELECT generation FROM ssh_generation WHERE peer_id=?').get(peer) as {generation:number}|undefined)?.generation ?? 0;}
  invalidate(peer:string){this.db.prepare('INSERT INTO ssh_generation VALUES(?,1) ON CONFLICT(peer_id) DO UPDATE SET generation=generation+1').run(peer);this.db.prepare('DELETE FROM ssh_session WHERE peer_id=?').run(peer);this.db.prepare('DELETE FROM ssh_challenge WHERE peer_id=?').run(peer);}
}
