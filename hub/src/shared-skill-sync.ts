// One selected desk skill bundle per workspace operation. The gateway freezes the bundle in its
// prepared outbox payload; the target installs it before starting the operation's agent turn.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseCompose, RESERVED_TAGS } from '../../shared/compose.ts';
import type { SkillSnapshot, SkillTransfer } from '../../shared/protocol.ts';
import { HttpError } from './errors.ts';
import { frontmatter, SkillStore } from './skills.ts';

export type SkillBundle = SkillSnapshot;
export type SkillReference = Omit<SkillBundle,'files'>;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (files: SkillTransfer[]) => [...files].sort((a, b) => compare(a.name,b.name) || compare(a.path,b.path));
const json = (files: SkillTransfer[]) => JSON.stringify(sorted(files));
export const skillDigest = (files: SkillTransfer[]) => hash(json(files));
export const EMPTY_SKILL_BUNDLE: SkillBundle = { version: 1, selected: [], files: [], hashes: {}, digest: skillDigest([]) };

function refs(markdown: string, known: Set<string>) {
  // Inline code often names a conditional child; transfer its files but activate only `selected`.
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  return [...withoutCode.matchAll(/(?:^|[^\w#])#([a-z0-9][a-z0-9-]{0,63})(?![\w-])/gim)]
    .map(m => m[1].toLowerCase()).filter(name => known.has(name) && !RESERVED_TAGS.includes(name));
}

/** Collect only tags selected by this input and their available child references. */
export function collectSkillBundle(skills: SkillStore, textOrNames: string | string[]): SkillBundle | null {
  const known = new Set(skills.names());
  const selected = [...new Set((typeof textOrNames === 'string' ? parseCompose(textOrNames, known).skills : textOrNames)
    .filter(name => known.has(name)))];
  if (!selected.length) return null;
  const files: SkillTransfer[] = [], seen = new Set<string>(), stack = [...selected];
  while (stack.length) {
    const name = stack.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const skill = skills.get(name);
    for (const file of skill.files) files.push({ name, ...skills.readFile(name, file.path) });
    const md = skills.readFile(name, 'SKILL.md').content;
    for (const child of refs(md, known)) if (!seen.has(child)) stack.push(child);
    if (files.length > MAX_FILES || Buffer.byteLength(json(files)) > MAX_BYTES)
      throw new HttpError(413, '전송할 데스크 스킬은 합계 4 MiB 이하여야 합니다');
  }
  const hashes = Object.fromEntries([...seen].sort().map(name => [name, skillDigest(files.filter(f => f.name === name))]));
  const bundle:SkillBundle = { version: 1, selected, files: sorted(files), hashes, digest: skillDigest(files) };
  if(Buffer.byteLength(JSON.stringify(bundle))>MAX_BYTES)
    throw new HttpError(413,'전송할 데스크 스킬은 합계 4 MiB 이하여야 합니다');
  return bundle;
}

/** A single skill, without following its conditional references, for manifest exchange. */
export function collectSkillVersion(skills: SkillStore, name: string): SkillBundle {
  const skill = skills.get(name);
  const files = skill.files.map(file => ({ name, ...skills.readFile(name, file.path) }));
  const digest = skillDigest(files);
  const bundle:SkillBundle={ version: 1, selected: [name], files: sorted(files), hashes: { [name]: digest }, digest };
  if(Buffer.byteLength(JSON.stringify(bundle))>MAX_BYTES)
    throw new HttpError(413,`#${name} 스킬은 4 MiB 이하로 줄여야 합니다`);
  return bundle;
}

export function validateSkillBundle(input: SkillBundle) {
  if (!input || input.version !== 1 || !Array.isArray(input.selected) || !Array.isArray(input.files) || input.files.length > MAX_FILES
    || !input.hashes || typeof input.hashes !== 'object' || typeof input.digest !== 'string'
    || Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw new HttpError(400, '스킬 묶음 형식이나 크기가 잘못되었습니다');
  const groups = new Map<string, SkillTransfer[]>(), keys = new Set<string>();
  for (const f of input.files) {
    if (!f || typeof f.name !== 'string' || typeof f.path !== 'string' || typeof f.content !== 'string'
      || typeof f.executable !== 'boolean' || f.path.startsWith('/') || f.path.includes('\\')
      || f.path.split('/').some(p => !p || p.startsWith('.')) || Buffer.byteLength(f.content) > 1024 * 1024)
      throw new HttpError(400, '스킬 파일 형식이 잘못되었습니다');
    SkillStore.validName(f.name);
    const key = `${f.name}/${f.path}`;
    if (keys.has(key)) throw new HttpError(400, '스킬 파일이 중복되었습니다');
    keys.add(key);
    const group = groups.get(f.name) ?? []; group.push(f); groups.set(f.name, group);
  }
  if (input.digest !== skillDigest(input.files)
    || Object.keys(input.hashes).length !== groups.size) throw new HttpError(400, '스킬 묶음 지문이 잘못되었습니다');
  if (new Set(input.selected).size !== input.selected.length || input.selected.some(name => !groups.has(name)))
    throw new HttpError(400, '선택한 스킬 명단이 묶음과 다릅니다');
  for (const [name, files] of groups) {
    const md = files.find(f => f.path === 'SKILL.md')?.content;
    const fm = md ? frontmatter(md) : undefined;
    if (!md || fm?.name !== name || !fm.description || input.hashes[name] !== skillDigest(files))
      throw new HttpError(400, `#${name} 스킬 본문 또는 지문이 잘못되었습니다`);
  }
  return groups;
}

/** Includes hidden files and rejects links, so an edited target never looks equal by omission. */
function actualFiles(root: string, name: string): SkillTransfer[] | null {
  if (!existsSync(root)) return null;
  if (!lstatSync(root).isDirectory()) throw new HttpError(409, `대상 #${name} 경로가 디렉터리가 아닙니다`);
  const out: SkillTransfer[] = [];
  const walk = (base: string, prefix = '') => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, full = join(base, entry.name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile() && stat.size <= 1024 * 1024) out.push({ name, path: relative,
        content: readFileSync(full, 'utf8'), executable: !!(stat.mode & 0o111) });
      else throw new HttpError(409, `대상 #${name}에 링크·특수 파일 또는 너무 큰 파일이 있습니다`);
      if (out.length > MAX_FILES) throw new HttpError(409, `대상 #${name} 파일이 너무 많습니다`);
    }
  };
  walk(root);
  return out;
}
function actualDigest(root: string, name: string) {
  const files = actualFiles(root, name);
  return files === null ? null : skillDigest(files);
}
export function ensureSharedSkillTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_skill_owner (
      name TEXT PRIMARY KEY, peer_id TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_skill_pending (
      name TEXT PRIMARY KEY, peer_id TEXT NOT NULL, op_id TEXT NOT NULL,
      old_digest TEXT, new_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_skill_current (
      peer_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(peer_id,name));
    CREATE TABLE IF NOT EXISTS shared_skill_cache (
      peer_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
      bytes INTEGER NOT NULL, last_used INTEGER NOT NULL,
      PRIMARY KEY(peer_id,name,digest));
    CREATE TABLE IF NOT EXISTS shared_skill_prepare (
      peer_id TEXT NOT NULL, op_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(peer_id,op_id,name));
    CREATE TABLE IF NOT EXISTS shared_skill_cache_pin (
      op_id TEXT NOT NULL, peer_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(op_id,peer_id,name));`);
}

function cacheHome(skills: SkillStore, peer: string, name: string, digest: string) {
  return join(skills.home, '.skill-sync', 'peers', hash(peer).slice(0, 32), name, digest);
}

function installVersion(skills: SkillStore, peer: string, op: string, name: string,
  files: SkillTransfer[], expected: string) {
  const home = cacheHome(skills, peer, name, expected);
  const dest = join(home, 'skills', name);
  if (actualDigest(dest, name) === expected) return;
  // A damaged or interrupted cache entry is reconstructed from the pinned operation bytes.
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  const stageHome = `${home}.stage-${hash(op).slice(0, 16)}`;
  if (existsSync(stageHome)) rmSync(stageHome, { recursive: true, force: true });
  const stage = new SkillStore(stageHome);
  stage.create(name);
  for (const file of files) stage.writeFile(name, file.path, file.content, file.executable);
  if (actualDigest(join(stageHome, 'skills', name), name) !== expected)
    throw new HttpError(409, `#${name} 스킬 준비 지문이 일치하지 않습니다`);
  renameSync(stageHome, home);
  if (actualDigest(dest, name) !== expected)
    throw new HttpError(409, `#${name} 스킬 설치를 검증하지 못했습니다`);
}

function pruneCache(db: DatabaseSync, skills: SkillStore, protectedVersions = new Set<string>()) {
  const rows = db.prepare(`SELECT c.peer_id,c.name,c.digest,c.bytes FROM shared_skill_cache c
    LEFT JOIN shared_skill_current v ON v.peer_id=c.peer_id AND v.name=c.name AND v.digest=c.digest
    WHERE v.digest IS NULL AND NOT EXISTS (SELECT 1 FROM shared_skill_cache_pin p
      WHERE p.peer_id=c.peer_id AND p.name=c.name AND p.digest=c.digest)
    ORDER BY c.last_used`).all() as {peer_id:string;name:string;digest:string;bytes:number}[];
  const total = db.prepare('SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM shared_skill_cache').get() as {n:number;bytes:number};
  const removable=rows.filter(row=>!protectedVersions.has(JSON.stringify([row.peer_id,row.name,row.digest])));
  let count=total.n,bytes=total.bytes;
  for(const row of removable){
    if(count<=4096&&bytes<=256*1024*1024)break;
    count--;bytes-=row.bytes;
  }
  if(count>4096||bytes>256*1024*1024)
    throw new HttpError(413,'보호 중인 스킬 버전을 유지할 캐시 공간이 없습니다');
  for (const row of removable) {
    if (total.n <= 4096 && total.bytes <= 256 * 1024 * 1024) break;
    rmSync(cacheHome(skills, row.peer_id, row.name, row.digest), { recursive: true, force: true });
    db.prepare('DELETE FROM shared_skill_cache WHERE peer_id=? AND name=? AND digest=?')
      .run(row.peer_id, row.name, row.digest);
    total.n--; total.bytes -= row.bytes;
  }
}

function assertSyncCacheCapacity(db:DatabaseSync,peer:string,name:string,digest:string,newBytes:number) {
  const rows=db.prepare('SELECT peer_id,name,digest,bytes,last_used FROM shared_skill_cache ORDER BY last_used')
    .all() as {peer_id:string;name:string;digest:string;bytes:number;last_used:number}[];
  const exists=rows.some(row=>row.peer_id===peer&&row.name===name&&row.digest===digest);
  let count=rows.length+(exists?0:1),bytes=rows.reduce((sum,row)=>sum+row.bytes,exists?0:newBytes);
  if(count<=4096&&bytes<=256*1024*1024)return;
  const current=new Set((db.prepare('SELECT peer_id,name,digest FROM shared_skill_current').all() as
    {peer_id:string;name:string;digest:string}[]).filter(row=>row.peer_id!==peer||row.name!==name)
    .map(row=>JSON.stringify([row.peer_id,row.name,row.digest])));
  const pinned=new Set((db.prepare('SELECT peer_id,name,digest FROM shared_skill_cache_pin').all() as
    {peer_id:string;name:string;digest:string}[]).map(row=>JSON.stringify([row.peer_id,row.name,row.digest])));
  for(const row of rows){
    if(count<=4096&&bytes<=256*1024*1024)break;
    const key=JSON.stringify([row.peer_id,row.name,row.digest]);
    if(current.has(key)||pinned.has(key)||(row.peer_id===peer&&row.name===name&&row.digest===digest))continue;
    count--;bytes-=row.bytes;
  }
  if(count>4096||bytes>256*1024*1024)
    throw new HttpError(413,'보호 중인 스킬 버전을 유지할 캐시 공간이 없습니다');
}

/** Prepare exactly this operation's versions. Retries verify the operation ID and repair the same bytes. */
export function applySkillBundle(db: DatabaseSync, skills: SkillStore, peer: string, op: string,
  bundle: SkillBundle, prune = true) {
  if (!peer || !op) throw new HttpError(400, '스킬 전송 출처 또는 명령 ID가 없습니다');
  const groups = validateSkillBundle(bundle);
  ensureSharedSkillTables(db);
  const protectedVersions=new Set<string>();
  for (const [name, files] of groups) {
    const expected = bundle.hashes[name];
    protectedVersions.add(JSON.stringify([peer,name,expected]));
    const prior = db.prepare('SELECT digest FROM shared_skill_prepare WHERE peer_id=? AND op_id=? AND name=?')
      .get(peer, op, name) as {digest:string}|undefined;
    if (prior && prior.digest !== expected) throw new HttpError(409, `같은 명령 ID의 #${name} 스킬 내용이 바뀌었습니다`);
    db.prepare('INSERT OR IGNORE INTO shared_skill_prepare VALUES (?,?,?,?)').run(peer, op, name, expected);
    installVersion(skills, peer, op, name, files, expected);
    db.prepare(`INSERT INTO shared_skill_cache VALUES (?,?,?,?,?)
      ON CONFLICT(peer_id,name,digest) DO UPDATE SET last_used=excluded.last_used`)
      .run(peer, name, expected, Buffer.byteLength(json(files)), Date.now());
  }
  if (prune) pruneCache(db, skills,protectedVersions);
}

export function skillManifest(db: DatabaseSync, peer: string): Record<string,string> {
  ensureSharedSkillTables(db);
  return Object.fromEntries((db.prepare('SELECT name,digest FROM shared_skill_current WHERE peer_id=? ORDER BY name')
    .all(peer) as {name:string;digest:string}[]).map(row => [row.name,row.digest]));
}

export function peerSkillManifest(db: DatabaseSync, skills: SkillStore, peer: string): Record<string,string> {
  return Object.fromEntries(Object.entries(skillManifest(db,peer)).filter(([name,digest])=>{
    try { return actualDigest(join(cacheHome(skills,peer,name,digest),'skills',name),name)===digest; }
    catch { return false; }
  }));
}

export function listPeerSkills(db: DatabaseSync, skills: SkillStore, peer: string) {
  const latest=peerSkillManifest(db,skills,peer);
  const shared=Object.entries(latest).map(([name,digest])=>new SkillStore(cacheHome(skills,peer,name,digest)).get(name));
  return shared.sort((a,b)=>compare(a.name,b.name));
}

export function peerSkillStore(db: DatabaseSync, skills: SkillStore, peer: string, name: string) {
  SkillStore.validName(name);
  const digest=peerSkillManifest(db,skills,peer)[name];
  if(!digest)throw new HttpError(404,`스킬이 없습니다: ${name}`);
  return new SkillStore(cacheHome(skills,peer,name,digest));
}

/** Rebuild a pinned snapshot from this peer's verified content-addressed versions. */
export function restoreSkillBundle(skills: SkillStore, peer: string, ref: SkillReference): SkillBundle | null {
  if (!ref || ref.version!==1 || !Array.isArray(ref.selected) || !ref.hashes || typeof ref.hashes!=='object'
    || typeof ref.digest!=='string' || Object.keys(ref.hashes).length>MAX_FILES)
    throw new HttpError(400,'스킬 참조 형식이 잘못되었습니다');
  const names=Object.keys(ref.hashes);
  for(const name of names) {
    SkillStore.validName(name);
    if(!/^[a-f0-9]{64}$/.test(ref.hashes[name]))throw new HttpError(400,'스킬 지문 형식이 잘못되었습니다');
  }
  if(new Set(ref.selected).size!==ref.selected.length || ref.selected.some(name=>!names.includes(name)))
    throw new HttpError(400,'선택한 스킬 명단이 참조와 다릅니다');
  const files:SkillTransfer[]=[];
  for(const name of names){
    const home=cacheHome(skills,peer,name,ref.hashes[name]);
    const path=join(home,'skills',name);
    try {if(actualDigest(path,name)!==ref.hashes[name])return null;}
    catch {return null;}
    const store=new SkillStore(home);
    for(const file of store.get(name).files)files.push({name,...store.readFile(name,file.path)});
  }
  const bundle={...ref,files:sorted(files)};
  if(bundle.digest!==skillDigest(bundle.files))throw new HttpError(409,'스킬 묶음 참조 지문이 다릅니다');
  validateSkillBundle(bundle);
  return bundle;
}

/** Update the peer's latest manifest while leaving pinned operation versions intact. */
export function syncSkillVersion(db: DatabaseSync, skills: SkillStore, peer: string, bundle: SkillBundle) {
  if (Object.keys(bundle.hashes).length !== 1) throw new HttpError(400, '한 번에 스킬 한 개만 동기화하세요');
  const [name] = Object.keys(bundle.hashes);
  ensureSharedSkillTables(db);
  const existing=db.prepare('SELECT 1 FROM shared_skill_current WHERE peer_id=? AND name=?').get(peer,name);
  const currentCount=(db.prepare('SELECT count(*) n FROM shared_skill_current').get() as {n:number}).n;
  if(!existing&&currentCount>=4096)throw new HttpError(413,'공유 스킬 캐시의 최신 버전 개수 한도를 초과했습니다');
  const used=db.prepare(`SELECT coalesce(sum(c.bytes),0) bytes FROM shared_skill_current v
    JOIN shared_skill_cache c ON c.peer_id=v.peer_id AND c.name=v.name AND c.digest=v.digest`).get() as {bytes:number};
  const previous=db.prepare(`SELECT c.bytes FROM shared_skill_current v JOIN shared_skill_cache c
    ON c.peer_id=v.peer_id AND c.name=v.name AND c.digest=v.digest WHERE v.peer_id=? AND v.name=?`)
    .get(peer,name) as {bytes:number}|undefined;
  if(used.bytes-(previous?.bytes??0)+Buffer.byteLength(json(bundle.files))>256*1024*1024)
    throw new HttpError(413,'공유 스킬 캐시의 최신 버전 용량 한도를 초과했습니다');
  assertSyncCacheCapacity(db,peer,name,bundle.hashes[name],Buffer.byteLength(json(bundle.files)));
  applySkillBundle(db, skills, peer, `sync-${bundle.digest}`, bundle, false);
  db.prepare('INSERT INTO shared_skill_current VALUES (?,?,?) ON CONFLICT(peer_id,name) DO UPDATE SET digest=excluded.digest')
    .run(peer, name, bundle.hashes[name]);
  db.prepare('DELETE FROM shared_skill_prepare WHERE peer_id=? AND op_id=?').run(peer,`sync-${bundle.digest}`);
  pruneCache(db, skills);
}

export function removeAbsentSkills(db: DatabaseSync, skills: SkillStore, peer: string, names: string[]) {
  if (!Array.isArray(names) || names.length > 1000 || names.some(name => typeof name !== 'string'))
    throw new HttpError(400, '스킬 명단 형식이 잘못되었습니다');
  names.forEach(SkillStore.validName);
  ensureSharedSkillTables(db);
  for (const row of db.prepare('SELECT name FROM shared_skill_current WHERE peer_id=?').all(peer) as {name:string}[])
    if (!names.includes(row.name)) db.prepare('DELETE FROM shared_skill_current WHERE peer_id=? AND name=?').run(peer,row.name);
  pruneCache(db,skills);
}
