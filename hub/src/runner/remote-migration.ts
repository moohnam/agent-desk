// Offline transfer of one legacy remote runner's canonical rows. Keep the source
// unchanged until the destination and its delivery journal have been verified.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { remoteLocation } from '../../../shared/remote.ts';
import { Store } from '../db.ts';
import { RemoteJournal } from './remote-journal.ts';
import { ensureRemoteTables } from './remote-hub.ts';
import { WorkspaceLinks } from '../workspace-links.ts';
import { SkillStore } from '../skills.ts';
import { config } from '../config.ts';
import { ensureSharedSkillTables, peerSkillManifest, skillDigest, syncSkillVersion } from '../shared-skill-sync.ts';

type Row = Record<string, string | number | null>;
type Table = 'project'|'task'|'session'|'event'|'approval'|'question'|'queued'|'request'|'remote_runner'|'remote_command'|'setting';
const TABLES: Table[] = ['project','task','session','event','approval','question','queued','request','remote_runner','remote_command','setting'];
const OWNED: Table[] = ['project','task','session','event','approval','question','queued','request','remote_runner','remote_command'];
export type LegacyIds = {legacy_project_ids:string[];legacy_task_ids:string[];legacy_approval_ids:string[];legacy_question_ids:string[];
  legacy_project_names:Record<string,string>;legacy_runner_ids:string[]};
type SkillFile = {name:string;path:string;content:string;executable:boolean};
type CreatedSkillFiles = {files:{name:string;path:string;digest:string}[];dirs:string[]};
type SkillMetadataBefore = {owner:Record<string,{peer_id:string;digest:string}|null>;current:Record<string,string|null>};
const skillPinOp=(runnerId:string)=>`remote-import:${runnerId}`;
export type RemoteTransfer = {version:1;runner_id:string;address:string;journal_id:string|null;rows:Record<Table,Row[]>;
  skills:SkillFile[];legacy:LegacyIds;fingerprint:string};
export type RemoteCommitReceipt = {runner_id:string;fingerprint:string;committed_at:string};
export type RemoteImportReceipt = {runner_id:string;fingerprint:string;journal_id:string;verified_at:string};
export type RemoteAbortReceipt = {runner_id:string;fingerprint:string;journal_id:string;aborted_at:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const ids=(rows:Row[])=>rows.map(row=>String(row.id));
const skillFiles=(store:SkillStore):SkillFile[]=>store.list().flatMap(skill=>skill.files.map(file=>({name:skill.name,...store.readFile(skill.name,file.path)})));
function skillPathValid(file:SkillFile) {
  SkillStore.validName(file.name);
  if(!file.path||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..')
    ||typeof file.content!=='string'||typeof file.executable!=='boolean')throw new Error('이관 스킬 파일 경로 또는 내용이 잘못되었습니다');
}
function existingFiles(root:string):string[] {
  if(!existsSync(root))return [];
  const out:string[]=[];
  const walk=(dir:string,prefix='')=>{
    for(const ent of readdirSync(dir,{withFileTypes:true})){
      const rel=prefix?`${prefix}/${ent.name}`:ent.name,full=join(dir,ent.name);
      if(ent.isDirectory())walk(full,rel);
      else if(ent.isFile()&&lstatSync(full).isFile())out.push(rel);
      else throw new Error('대상 스킬 경로에 링크 또는 특수 파일이 있습니다');
    }
  };
  walk(root);return out;
}
function checkSkillBundle(files:SkillFile[],target:SkillStore) {
  const byName=new Map<string,Map<string,SkillFile>>();
  for(const file of files){
    skillPathValid(file);
    let group=byName.get(file.name);if(!group)byName.set(file.name,group=new Map());
    if(group.has(file.path))throw new Error('이관 스킬 파일이 중복되었습니다');
    group.set(file.path,file);
  }
  for(const [name,group] of byName){
    if(!group.has('SKILL.md'))throw new Error('이관 스킬 본문이 없습니다');
    const base=join(target.home,'skills',name);
    for(const path of existingFiles(base)){
      const expected=group.get(path);
      if(!expected)throw new Error(`대상 ${name} 스킬에 원본에 없는 파일이 있습니다`);
      const current=target.readFile(name,path);
      if(current.content!==expected.content||current.executable!==expected.executable)
        throw new Error(`대상 ${name}/${path} 스킬 파일이 원본과 다릅니다`);
    }
  }
  return byName;
}
const skillFileDigest=(content:string,executable:boolean)=>hash(JSON.stringify([content,executable]));
function cleanupCreatedSkillFiles(created:CreatedSkillFiles,target:SkillStore) {
  for(const file of created.files){
    SkillStore.validName(file.name);
    if(!file.path||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..'))continue;
    const full=join(target.home,'skills',file.name,file.path);
    if(!existsSync(full)||!lstatSync(full).isFile())continue;
    let current:ReturnType<SkillStore['readFile']>;
    try{current=target.readFile(file.name,file.path);}catch{continue;}
    if(skillFileDigest(current.content,current.executable)===file.digest)rmSync(full);
  }
  for(const dir of [...created.dirs].sort((a,b)=>b.length-a.length)){
    const full=join(target.home,'skills',dir);
    if(!existsSync(full)||!lstatSync(full).isDirectory())continue;
    try{rmdirSync(full);}catch(error){if(!['ENOTEMPTY','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
}
function installSkillBundle(files:SkillFile[],target:SkillStore,created:CreatedSkillFiles) {
  const groups=checkSkillBundle(files,target);
  for(const [name,group] of groups){
    const base=join(target.home,'skills',name);
    if(!existsSync(base)){mkdirSync(base,{recursive:true,mode:0o700});created.dirs.push(name);}
    for(const file of [group.get('SKILL.md')!,...group.values()].filter((f,i,a)=>a.indexOf(f)===i)){
      if(!existsSync(join(base,file.path))){
        const parts=file.path.split('/');
        for(let i=1;i<parts.length;i++){
          const relative=`${name}/${parts.slice(0,i).join('/')}`;
          if(!existsSync(join(target.home,'skills',relative))&&!created.dirs.includes(relative))created.dirs.push(relative);
        }
        created.files.push({name,path:file.path,digest:skillFileDigest(file.content,file.executable)});
        target.writeFile(name,file.path,file.content,file.executable);
      }
    }
  }
  checkSkillBundle(files,target);
}
function verifySkillBundle(files:SkillFile[],target:SkillStore) {
  const groups=checkSkillBundle(files,target);
  for(const [name,group] of groups)if(existingFiles(join(target.home,'skills',name)).length!==group.size)
    throw new Error(`대상 ${name} 스킬 파일 일부가 빠졌습니다`);
}
const placeholders=(values:unknown[])=>values.map(()=>'?').join(',');
const select=(db:DatabaseSync,table:Table,where='1',args:(string|number)[]=[]):Row[]=>
  db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(...args) as Row[];
const inIds=(column:string,values:string[])=>values.length?`${column} IN (${placeholders(values)})`:'0';

function collect(db:DatabaseSync,runnerId:string,skills?:SkillStore):RemoteTransfer {
    const peer=db.prepare('SELECT * FROM remote_runner WHERE id=?').get(runnerId) as Row|undefined;
    if(!peer)throw new Error('이관할 기존 원격 러너가 없습니다');
    const address=String(peer.address);
    const peers=select(db,'remote_runner');
    const projects=select(db,'project').filter(p=>{
      const location=remoteLocation(String(p.root_path));
      if(!location)return false;
      if(location.address===address)return true;
      if(location.address.includes('@')||location.address!==address.split('@').at(-1))return false;
      const candidates=peers.filter(r=>String(r.address).split('@').at(-1)===location.address);
      if(candidates.length!==1)throw new Error(`프로젝트 ${p.id}의 원격 실행 계정이 모호합니다`);
      return candidates[0].id===runnerId;
    });
    const projectIds=ids(projects);
    const tasks=select(db,'task',inIds('project_id',projectIds),projectIds);
    const taskIds=ids(tasks);
    const sessions=select(db,'session',inIds('task_id',taskIds),taskIds);
    if(sessions.some(s=>s.runner_id!==runnerId))throw new Error('프로젝트에 다른 러너가 소유한 세션이 있어 이관할 수 없습니다');
    const events=select(db,'event',inIds('task_id',taskIds),taskIds);
    const approvals=select(db,'approval',inIds('task_id',taskIds),taskIds);
    const questions=select(db,'question',inIds('task_id',taskIds),taskIds);
    const queued=select(db,'queued',inIds('task_id',taskIds),taskIds);
    const requests=select(db,'request',inIds('from_task_id',taskIds),taskIds);
    const touching=select(db,'request',`${inIds('from_task_id',taskIds)} OR ${inIds('to_task_id',taskIds)}`,[...taskIds,...taskIds]);
    if(touching.some(r=>['approval','queued','running'].includes(String(r.status))))throw new Error('열린 다른 작업 질문을 먼저 완료해야 합니다');
    if(sessions.some(s=>['running','waiting'].includes(String(s.status)))||approvals.some(a=>a.status==='pending')||questions.some(q=>q.status==='pending'))
      throw new Error('진행 중인 세션·승인·질문이 있어 이관을 중단합니다');
    const live=JSON.parse(String(peer.sessions)) as {busy?:boolean;approvals?:unknown[];background?:unknown[]}[];
    if(live.some(s=>s.busy||s.approvals?.length||s.background?.length))throw new Error('원격 엔진이 아직 작업 중입니다');
    const channel=db.prepare(`SELECT id FROM channel WHERE conversation_task_id IN (${placeholders(taskIds) || "''"}) LIMIT 1`).get(...taskIds);
    if(channel)throw new Error('채널 대화가 원격 작업을 참조하여 자동 이관할 수 없습니다');
    const rows:Record<Table,Row[]>={project:projects,task:tasks,session:sessions,event:events,approval:approvals,question:questions,
      queued,request:requests,remote_runner:[peer],remote_command:select(db,'remote_command','runner_id=?',[runnerId]),setting:select(db,'setting')};
    const legacy={legacy_project_ids:projectIds,legacy_task_ids:taskIds,legacy_approval_ids:ids(approvals),legacy_question_ids:ids(questions),
      legacy_project_names:Object.fromEntries(projects.map(p=>[String(p.id),String(p.name)])),legacy_runner_ids:[runnerId]};
    const files=skills?skillFiles(skills):[];
    const fingerprint=hash(JSON.stringify({runnerId,address,rows,legacy,skills:files}));
    return {version:1,runner_id:runnerId,address,journal_id:peer.journal_id as string|null,rows,skills:files,legacy,fingerprint};
}

/** Read one consistent legacy snapshot; no table or engine process is changed. */
export function exportRemoteTransfer(db:DatabaseSync,runnerId:string,skills?:SkillStore):RemoteTransfer {
  db.exec('BEGIN');
  try{return collect(db,runnerId,skills);}finally{db.exec('ROLLBACK');}
}

function validTransfer(bundle:RemoteTransfer) {
  if(bundle?.version!==1||!/^remote-[a-zA-Z0-9-]+$/.test(bundle.runner_id)||!bundle.address||!bundle.rows||!Array.isArray(bundle.skills)
    ||TABLES.some(t=>!Array.isArray(bundle.rows[t]))||bundle.rows.remote_runner.length!==1
    ||bundle.rows.remote_runner[0].id!==bundle.runner_id
    ||bundle.fingerprint!==hash(JSON.stringify({runnerId:bundle.runner_id,address:bundle.address,rows:bundle.rows,legacy:bundle.legacy,skills:bundle.skills})))
    throw new Error('원격 이관 묶음의 내용 또는 지문이 잘못되었습니다');
  for(const file of bundle.skills)skillPathValid(file);
}

const insert=(db:DatabaseSync,table:Table,row:Row)=>{
  const keys=Object.keys(row);
  const allowed=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));
  if(!keys.length||keys.some(k=>!allowed.has(k)))throw new Error(`이관 데이터에 ${table}의 알 수 없는 열이 있습니다`);
  db.prepare(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${placeholders(keys)})`).run(...keys.map(k=>row[k]));
};

/** Import only into an empty workspace; the existing remote journal is reused, never reset. */
export function importRemoteTransfer(bundle:RemoteTransfer,destination:Store,journal:RemoteJournal,targetSkills?:SkillStore,skillPeerId?:string) {
  validTransfer(bundle);
  if(bundle.journal_id&&journal.id!==bundle.journal_id)throw new Error('원격 전달 DB의 ID가 기존 허브 기록과 다릅니다');
  journal.assertTransferState(Number(bundle.rows.remote_runner[0].event_ack),Number(bundle.rows.remote_runner[0].sent_through));
  journal.assertRunner(bundle.runner_id);
  const db=destination.database;
  ensureRemoteTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS remote_import (
    runner_id TEXT PRIMARY KEY, address TEXT NOT NULL, fingerprint TEXT NOT NULL,
    legacy_json TEXT NOT NULL, activated_at TEXT, aborted_at TEXT, skill_peer_id TEXT,
    created_skill_files TEXT, skill_metadata_before TEXT);`);
  if(!(db.prepare('PRAGMA table_info(remote_import)').all() as {name:string}[]).some(c=>c.name==='aborted_at'))
    db.exec('ALTER TABLE remote_import ADD COLUMN aborted_at TEXT');
  if(!(db.prepare('PRAGMA table_info(remote_import)').all() as {name:string}[]).some(c=>c.name==='skill_peer_id'))
    db.exec('ALTER TABLE remote_import ADD COLUMN skill_peer_id TEXT');
  if(!(db.prepare('PRAGMA table_info(remote_import)').all() as {name:string}[]).some(c=>c.name==='created_skill_files'))
    db.exec('ALTER TABLE remote_import ADD COLUMN created_skill_files TEXT');
  if(!(db.prepare('PRAGMA table_info(remote_import)').all() as {name:string}[]).some(c=>c.name==='skill_metadata_before'))
    db.exec('ALTER TABLE remote_import ADD COLUMN skill_metadata_before TEXT');
  if(bundle.skills.length&&(!skillPeerId||!db.prepare('SELECT 1 FROM workspace_peer WHERE id=? AND revoked=0').get(skillPeerId)))
    throw new Error('스킬 이관에는 대상에 미리 발급한 원본 허브 peer ID가 필요합니다');
  const created:CreatedSkillFiles={files:[],dirs:[]};
  const metadataBefore:SkillMetadataBefore={owner:{},current:{}};
  db.exec('BEGIN IMMEDIATE');
  try {
    const old=db.prepare('SELECT fingerprint,aborted_at,skill_peer_id,created_skill_files FROM remote_import WHERE runner_id=?').get(bundle.runner_id) as
      {fingerprint:string;aborted_at:string|null;skill_peer_id:string|null;created_skill_files:string|null}|undefined;
    if(old){if(old.fingerprint!==bundle.fingerprint)throw new Error('다른 원본 기록으로 재이관할 수 없습니다');
      if(!old.aborted_at&&old.skill_peer_id!==(skillPeerId??null))throw new Error('스킬 원본 허브 peer ID가 기존 이관 준비 기록과 다릅니다');
      if(!old.aborted_at){
        if(bundle.skills.length&&targetSkills&&skillPeerId){
          ensureSharedSkillTables(db);
          for(const name of new Set(bundle.skills.map(file=>file.name))){
            const files=bundle.skills.filter(file=>file.name===name),digest=skillDigest(files);
            if(peerSkillManifest(db,targetSkills,skillPeerId)[name]!==digest)
              syncSkillVersion(db,targetSkills,skillPeerId,{version:1,selected:[name],files,hashes:{[name]:digest},digest});
          }
        }
        db.exec('COMMIT');return;}
      if(old.created_skill_files&&targetSkills)
        cleanupCreatedSkillFiles(JSON.parse(old.created_skill_files) as CreatedSkillFiles,targetSkills);
    }
    if(OWNED.some(t=>Number((db.prepare(`SELECT count(*) n FROM ${t}`).get() as {n:number}).n)))throw new Error('대상 작업공간 DB가 비어 있지 않습니다');
    if(bundle.skills.length){
      if(!targetSkills)throw new Error('이관 스킬을 설치할 대상 저장소가 없습니다');
      installSkillBundle(bundle.skills,targetSkills,created);
      ensureSharedSkillTables(db);
      for(const name of new Set(bundle.skills.map(file=>file.name))){
        const files=bundle.skills.filter(file=>file.name===name),digest=skillDigest(files);
        const old=db.prepare('SELECT peer_id,digest FROM shared_skill_owner WHERE name=?').get(name) as
          {peer_id:string;digest:string}|undefined;
        if(old&&(old.peer_id!==skillPeerId||old.digest!==digest))
          throw new Error(`대상 ${name} 스킬의 소유 기록이 충돌합니다`);
        metadataBefore.owner[name]=old??null;
        metadataBefore.current[name]=(db.prepare('SELECT digest FROM shared_skill_current WHERE peer_id=? AND name=?')
          .get(skillPeerId!,name) as {digest:string}|undefined)?.digest??null;
        if(metadataBefore.current[name])db.prepare('INSERT INTO shared_skill_cache_pin(op_id,peer_id,name,digest) VALUES (?,?,?,?)')
          .run(skillPinOp(bundle.runner_id),skillPeerId!,name,metadataBefore.current[name]);
        if(!old)db.prepare('INSERT INTO shared_skill_owner(name,peer_id,digest) VALUES (?,?,?)')
          .run(name,skillPeerId!,digest);
        syncSkillVersion(db,targetSkills,skillPeerId!,{version:1,selected:[name],files,hashes:{[name]:digest},digest});
      }
    }
    for(const table of TABLES)for(const row of bundle.rows[table])insert(db,table,row);
    if(old)db.prepare('UPDATE remote_import SET aborted_at=NULL,skill_peer_id=?,created_skill_files=?,skill_metadata_before=? WHERE runner_id=?')
      .run(skillPeerId??null,JSON.stringify(created),JSON.stringify(metadataBefore),bundle.runner_id);
    else db.prepare('INSERT INTO remote_import(runner_id,address,fingerprint,legacy_json,skill_peer_id,created_skill_files,skill_metadata_before) VALUES (?,?,?,?,?,?,?)')
      .run(bundle.runner_id,bundle.address,bundle.fingerprint,JSON.stringify(bundle.legacy),skillPeerId??null,JSON.stringify(created),JSON.stringify(metadataBefore));
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');if(targetSkills)cleanupCreatedSkillFiles(created,targetSkills);throw e;}
}

/** Re-read all imported rows and the old delivery journal before authorizing source deletion. */
export function verifyRemoteImport(bundle:RemoteTransfer,destination:DatabaseSync,journal:RemoteJournal,targetSkills?:SkillStore,skipSkillFiles=false):RemoteImportReceipt {
  validTransfer(bundle);journal.assertRunner(bundle.runner_id);
  if(bundle.journal_id&&journal.id!==bundle.journal_id)throw new Error('원격 전달 DB ID가 원본과 다릅니다');
  const imported=destination.prepare('SELECT fingerprint,activated_at,aborted_at,skill_peer_id FROM remote_import WHERE runner_id=?').get(bundle.runner_id) as
    {fingerprint:string;activated_at:string|null;aborted_at:string|null;skill_peer_id:string|null}|undefined;
  if(imported?.fingerprint!==bundle.fingerprint||imported.activated_at||imported.aborted_at)throw new Error('대상 원격 DB가 준비 상태가 아닙니다');
  for(const table of TABLES)if(JSON.stringify(select(destination,table))!==JSON.stringify(bundle.rows[table]))
    throw new Error(`대상 원격 DB의 ${table} 기록이 내보낸 원본과 다릅니다`);
  if(bundle.skills.length&&!skipSkillFiles){
    if(!targetSkills)throw new Error('이관 스킬을 확인할 대상 저장소가 없습니다');
    verifySkillBundle(bundle.skills,targetSkills);
    for(const name of new Set(bundle.skills.map(file=>file.name))){
      const owner=destination.prepare('SELECT peer_id,digest FROM shared_skill_owner WHERE name=?').get(name) as
        {peer_id:string;digest:string}|undefined;
      if(!imported.skill_peer_id||owner?.peer_id!==imported.skill_peer_id||owner.digest!==skillDigest(bundle.skills.filter(file=>file.name===name)))
        throw new Error(`대상 ${name} 스킬의 이관 소유 기록이 다릅니다`);
      if(peerSkillManifest(destination,targetSkills,imported.skill_peer_id)[name]!==owner.digest)
        throw new Error(`대상 ${name} 스킬의 출처별 캐시가 다릅니다`);
    }
  }
  journal.assertTransferState(Number(bundle.rows.remote_runner[0].event_ack),Number(bundle.rows.remote_runner[0].sent_through));
  return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:journal.id,verified_at:new Date().toISOString()};
}

const EMPTY_MERGE_TABLES:Table[]=['task','session','event','approval','question','queued','request','remote_command'];
function requireEmptyProjectMerge(bundle:RemoteTransfer,oldJournal:RemoteJournal) {
  validTransfer(bundle);
  if(EMPTY_MERGE_TABLES.some(table=>bundle.rows[table].length))throw new Error('기존 공유 러너에는 작업 없는 프로젝트만 통합할 수 있습니다');
  if(!bundle.rows.project.length)throw new Error('통합할 기존 원격 프로젝트가 없습니다');
  if(JSON.parse(String(bundle.rows.remote_runner[0].sessions)).length)throw new Error('기존 일반 원격 러너에 세션이 남아 있습니다');
  oldJournal.assertRunner(bundle.runner_id);
  if(bundle.journal_id&&oldJournal.id!==bundle.journal_id)throw new Error('기존 일반 원격 전달 DB ID가 다릅니다');
  oldJournal.assertTransferState(Number(bundle.rows.remote_runner[0].event_ack),Number(bundle.rows.remote_runner[0].sent_through));
  if(oldJournal.hasUndeliveredCommands||oldJournal.lastEvent!==oldJournal.eventAck)throw new Error('기존 일반 원격 전달 DB에 미처리 기록이 남아 있습니다');
}

/** Merge only empty legacy projects into a pre-existing shared workspace. */
export function importEmptyRemoteProjects(bundle:RemoteTransfer,target:DatabaseSync,oldJournal:RemoteJournal,sharedJournal:RemoteJournal) {
  requireEmptyProjectMerge(bundle,oldJournal);
  if(oldJournal.id===sharedJournal.id)throw new Error('기존 일반 원격과 공유 러너의 전달 DB가 같습니다');
  target.exec(`CREATE TABLE IF NOT EXISTS remote_merge (
    old_runner_id TEXT PRIMARY KEY,target_runner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,legacy_json TEXT NOT NULL,activated_at TEXT,aborted_at TEXT);`);
  if(!(target.prepare('PRAGMA table_info(remote_merge)').all() as {name:string}[]).some(c=>c.name==='aborted_at'))
    target.exec('ALTER TABLE remote_merge ADD COLUMN aborted_at TEXT');
  target.exec('BEGIN IMMEDIATE');
  try {
    const old=target.prepare('SELECT fingerprint,aborted_at FROM remote_merge WHERE old_runner_id=?').get(bundle.runner_id) as
      {fingerprint:string;aborted_at:string|null}|undefined;
    if(old){if(old.fingerprint!==bundle.fingerprint)throw new Error('다른 기존 원격 원본으로 다시 통합할 수 없습니다');
      if(!old.aborted_at){target.exec('COMMIT');return;}}
    const workspace=target.prepare('SELECT id FROM workspace_identity').all() as {id:string}[];
    const runners=select(target,'remote_runner');
    if(workspace.length!==1||runners.length!==1||runners[0].id===bundle.runner_id||runners[0].address!==bundle.address)
      throw new Error('기존 공유 작업공간의 주소·러너·ID가 통합 조건과 다릅니다');
    sharedJournal.assertRunner(String(runners[0].id));
    if(runners[0].journal_id&&runners[0].journal_id!==sharedJournal.id)throw new Error('기존 공유 전달 DB ID가 다릅니다');
    for(const project of bundle.rows.project) {
      if(target.prepare('SELECT 1 FROM project WHERE id=? OR lower(name)=lower(?) OR root_path=?').get(project.id,project.name,project.root_path))
        throw new Error(`기존 공유 프로젝트와 이관 프로젝트 ${project.id}가 충돌합니다`);
      insert(target,'project',project);
    }
    if(old)target.prepare('UPDATE remote_merge SET aborted_at=NULL WHERE old_runner_id=?').run(bundle.runner_id);
    else target.prepare('INSERT INTO remote_merge(old_runner_id,target_runner_id,workspace_id,fingerprint,legacy_json) VALUES (?,?,?,?,?)')
      .run(bundle.runner_id,runners[0].id,workspace[0].id,bundle.fingerprint,JSON.stringify(bundle.legacy));
    target.exec('COMMIT');
  }catch(e){target.exec('ROLLBACK');throw e;}
}

export function verifyEmptyRemoteMerge(bundle:RemoteTransfer,target:DatabaseSync,oldJournal:RemoteJournal,sharedJournal:RemoteJournal):RemoteImportReceipt {
  requireEmptyProjectMerge(bundle,oldJournal);
  const marker=target.prepare('SELECT * FROM remote_merge WHERE old_runner_id=?').get(bundle.runner_id) as
    {old_runner_id:string;target_runner_id:string;workspace_id:string;fingerprint:string;legacy_json:string;activated_at:string|null;aborted_at:string|null}|undefined;
  if(marker?.fingerprint!==bundle.fingerprint||marker.activated_at||marker.aborted_at||marker.legacy_json!==JSON.stringify(bundle.legacy))
    throw new Error('대상 공유 작업공간의 통합 준비 기록이 다릅니다');
  if((target.prepare('SELECT id FROM workspace_identity').get() as {id:string}|undefined)?.id!==marker.workspace_id
    ||(target.prepare('SELECT address FROM remote_runner WHERE id=?').get(marker.target_runner_id) as {address:string}|undefined)?.address!==bundle.address)
    throw new Error('기존 공유 작업공간의 신원이 바뀌었습니다');
  sharedJournal.assertRunner(marker.target_runner_id);
  for(const project of bundle.rows.project)if(JSON.stringify(target.prepare('SELECT * FROM project WHERE id=?').get(project.id))!==JSON.stringify(project))
    throw new Error('대상 공유 작업공간의 이관 프로젝트가 원본과 다릅니다');
  return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:oldJournal.id,verified_at:new Date().toISOString()};
}

export function activateEmptyRemoteMerge(target:DatabaseSync,runnerId:string,receipt:RemoteCommitReceipt) {
  const marker=target.prepare('SELECT fingerprint,aborted_at FROM remote_merge WHERE old_runner_id=?').get(runnerId) as {fingerprint:string;aborted_at:string|null}|undefined;
  if(!receipt||receipt.runner_id!==runnerId||receipt.fingerprint!==marker?.fingerprint||!receipt.committed_at)
    throw new Error('원본 DB 전환 영수증이 공유 작업공간 통합 기록과 다릅니다');
  if(marker.aborted_at)throw new Error('취소한 공유 작업공간 통합은 활성화할 수 없습니다');
  target.prepare('UPDATE remote_merge SET activated_at=? WHERE old_runner_id=? AND activated_at IS NULL').run(new Date().toISOString(),runnerId);
}

export function abortEmptyRemoteMerge(bundle:RemoteTransfer,target:DatabaseSync,oldJournal:RemoteJournal,sharedJournal:RemoteJournal):RemoteAbortReceipt {
  validTransfer(bundle);
  const prior=target.prepare('SELECT fingerprint,activated_at,aborted_at FROM remote_merge WHERE old_runner_id=?').get(bundle.runner_id) as
    {fingerprint:string;activated_at:string|null;aborted_at:string|null}|undefined;
  if(prior?.fingerprint!==bundle.fingerprint||prior.activated_at)throw new Error('대상 공유 통합을 되돌릴 수 없습니다');
  if(prior.aborted_at)return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:oldJournal.id,aborted_at:prior.aborted_at};
  verifyEmptyRemoteMerge(bundle,target,oldJournal,sharedJournal);
  target.exec('BEGIN IMMEDIATE');
  try {
    for(const project of bundle.rows.project)target.prepare('DELETE FROM project WHERE id=?').run(project.id);
    const abortedAt=new Date().toISOString();
    target.prepare('UPDATE remote_merge SET aborted_at=? WHERE old_runner_id=? AND activated_at IS NULL').run(abortedAt,bundle.runner_id);
    target.exec('COMMIT');
    return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:oldJournal.id,aborted_at:abortedAt};
  }catch(e){target.exec('ROLLBACK');throw e;}
}

/** Abort only before activation; the old journal remains usable by the old remote process. */
export function abortRemoteImport(bundle:RemoteTransfer,destination:DatabaseSync,journal:RemoteJournal,targetSkills?:SkillStore):RemoteAbortReceipt {
  validTransfer(bundle);journal.assertRunner(bundle.runner_id);
  const prior=destination.prepare('SELECT fingerprint,activated_at,aborted_at,created_skill_files,skill_metadata_before FROM remote_import WHERE runner_id=?').get(bundle.runner_id) as
    {fingerprint:string;activated_at:string|null;aborted_at:string|null;created_skill_files:string|null;skill_metadata_before:string|null}|undefined;
  if(prior?.fingerprint!==bundle.fingerprint||prior.activated_at)throw new Error('대상 원격 DB를 이관 전으로 되돌릴 수 없습니다');
  const created=prior.created_skill_files?JSON.parse(prior.created_skill_files) as CreatedSkillFiles:{files:[],dirs:[]};
  const metadataBefore=prior.skill_metadata_before?JSON.parse(prior.skill_metadata_before) as SkillMetadataBefore:null;
  if(prior.aborted_at){if(targetSkills)cleanupCreatedSkillFiles(created,targetSkills);
    destination.prepare('UPDATE remote_import SET created_skill_files=? WHERE runner_id=?').run(JSON.stringify({files:[],dirs:[]}),bundle.runner_id);
    return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:journal.id,aborted_at:prior.aborted_at};}
  verifyRemoteImport(bundle,destination,journal,targetSkills,true);
  destination.exec('BEGIN IMMEDIATE');
  try {
    if(destination.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_receipt'").get()
      &&destination.prepare('SELECT 1 FROM workspace_receipt LIMIT 1').get())throw new Error('대상 작업공간에서 이미 입력을 처리했습니다');
    for(const table of ['remote_command','request','queued','question','approval','event','session','task','project','remote_runner','setting'] as Table[])
      for(const row of bundle.rows[table]){
        const key=table==='setting'?'key':table==='remote_command'?'seq':'id';
        destination.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(row[key]);
      }
    const peer=destination.prepare('SELECT skill_peer_id FROM remote_import WHERE runner_id=?').get(bundle.runner_id) as {skill_peer_id:string|null};
    for(const name of new Set(bundle.skills.map(file=>file.name))){
      const digest=skillDigest(bundle.skills.filter(file=>file.name===name));
      if(metadataBefore?.owner[name]===null)
        destination.prepare('DELETE FROM shared_skill_owner WHERE name=? AND peer_id=? AND digest=?').run(name,peer.skill_peer_id,digest);
      if(peer.skill_peer_id&&metadataBefore){
        const previous=metadataBefore.current[name];
        if(previous===null)destination.prepare('DELETE FROM shared_skill_current WHERE peer_id=? AND name=? AND digest=?')
          .run(peer.skill_peer_id,name,digest);
        else if(previous!==undefined)destination.prepare('UPDATE shared_skill_current SET digest=? WHERE peer_id=? AND name=? AND digest=?')
          .run(previous,peer.skill_peer_id,name,digest);
      }
    }
    if(bundle.skills.length)destination.prepare('DELETE FROM shared_skill_cache_pin WHERE op_id=?').run(skillPinOp(bundle.runner_id));
    const abortedAt=new Date().toISOString();
    destination.prepare('UPDATE remote_import SET aborted_at=? WHERE runner_id=? AND activated_at IS NULL').run(abortedAt,bundle.runner_id);
    destination.exec('COMMIT');
    if(targetSkills)cleanupCreatedSkillFiles(created,targetSkills);
    destination.prepare('UPDATE remote_import SET created_skill_files=? WHERE runner_id=?').run(JSON.stringify({files:[],dirs:[]}),bundle.runner_id);
    return {runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:journal.id,aborted_at:abortedAt};
  }catch(e){destination.exec('ROLLBACK');throw e;}
}

/** Source cutover is idempotent, and refuses changes since the exported snapshot. */
export function commitRemoteTransfer(db:DatabaseSync,bundle:RemoteTransfer,verified:RemoteImportReceipt,sourceSkills?:SkillStore):RemoteCommitReceipt {
  validTransfer(bundle);
  if(!verified||verified.runner_id!==bundle.runner_id||verified.fingerprint!==bundle.fingerprint
    ||verified.journal_id!==bundle.journal_id||!verified.verified_at)
    throw new Error('대상 원격 DB 검증 영수증이 원본과 일치하지 않습니다');
  db.exec(`CREATE TABLE IF NOT EXISTS remote_migration (
    runner_id TEXT PRIMARY KEY, address TEXT NOT NULL, fingerprint TEXT NOT NULL,
    legacy_json TEXT NOT NULL, committed_at TEXT NOT NULL);`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const old=db.prepare('SELECT fingerprint FROM remote_migration WHERE runner_id=?').get(bundle.runner_id) as {fingerprint:string}|undefined;
    if(old){if(old.fingerprint!==bundle.fingerprint)throw new Error('기존 이관 기록과 다른 묶음입니다');db.exec('COMMIT');
      return db.prepare('SELECT runner_id,fingerprint,committed_at FROM remote_migration WHERE runner_id=?').get(bundle.runner_id) as RemoteCommitReceipt;}
    if(collect(db,bundle.runner_id,sourceSkills).fingerprint!==bundle.fingerprint)throw new Error('내보낸 뒤 원본 기록이 변경되었습니다');
    for(const table of ['event','approval','question','queued','session'] as Table[])for(const row of bundle.rows[table])
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    for(const row of bundle.rows.request)db.prepare('DELETE FROM request WHERE id=?').run(row.id);
    for(const row of bundle.rows.task)db.prepare('DELETE FROM task WHERE id=?').run(row.id);
    for(const row of bundle.rows.project)db.prepare('DELETE FROM project WHERE id=?').run(row.id);
    db.prepare('DELETE FROM remote_command WHERE runner_id=?').run(bundle.runner_id);
    db.prepare('DELETE FROM remote_runner WHERE id=?').run(bundle.runner_id);
    db.prepare('INSERT INTO remote_migration VALUES (?,?,?,?,?)').run(bundle.runner_id,bundle.address,bundle.fingerprint,JSON.stringify(bundle.legacy),new Date().toISOString());
    db.exec('COMMIT');
    return db.prepare('SELECT runner_id,fingerprint,committed_at FROM remote_migration WHERE runner_id=?').get(bundle.runner_id) as RemoteCommitReceipt;
  }catch(e){db.exec('ROLLBACK');throw e;}
}

/** Restore the source only after the staged target has been aborted, before link publication. */
export function rollbackRemoteTransfer(db:DatabaseSync,bundle:RemoteTransfer,committed:RemoteCommitReceipt,aborted:RemoteAbortReceipt) {
  validTransfer(bundle);
  if(committed?.runner_id!==bundle.runner_id||committed.fingerprint!==bundle.fingerprint||!committed.committed_at
    ||aborted?.runner_id!==bundle.runner_id||aborted.fingerprint!==bundle.fingerprint||aborted.journal_id!==bundle.journal_id||!aborted.aborted_at)
    throw new Error('이관 취소 영수증이 원본과 일치하지 않습니다');
  db.exec('BEGIN IMMEDIATE');
  try {
    const marker=db.prepare('SELECT fingerprint,committed_at FROM remote_migration WHERE runner_id=?').get(bundle.runner_id) as
      {fingerprint:string;committed_at:string}|undefined;
    if(marker?.fingerprint!==bundle.fingerprint||marker.committed_at!==committed.committed_at)
      throw new Error('원본 DB 이관 기록이 영수증과 다릅니다');
    for(const table of OWNED)for(const row of bundle.rows[table])insert(db,table,row);
    db.prepare('DELETE FROM remote_migration WHERE runner_id=?').run(bundle.runner_id);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

export function activateRemoteImport(db:DatabaseSync,runnerId:string,receipt:RemoteCommitReceipt) {
  const imported=db.prepare('SELECT fingerprint,aborted_at FROM remote_import WHERE runner_id=?').get(runnerId) as {fingerprint:string;aborted_at:string|null}|undefined;
  if(!receipt||receipt.runner_id!==runnerId||!receipt.committed_at||receipt.fingerprint!==imported?.fingerprint)
    throw new Error('원본 DB 전환 영수증이 대상 이관 기록과 일치하지 않습니다');
  if(imported.aborted_at)throw new Error('취소한 대상 이관은 활성화할 수 없습니다');
  db.exec('BEGIN IMMEDIATE');
  try{
    const changed=db.prepare('UPDATE remote_import SET activated_at=? WHERE runner_id=? AND activated_at IS NULL')
      .run(new Date().toISOString(),runnerId).changes;
    if(!changed&&!db.prepare('SELECT 1 FROM remote_import WHERE runner_id=? AND activated_at IS NOT NULL').get(runnerId))
      throw new Error('이 원격 작업공간에 이관된 러너가 없습니다');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shared_skill_cache_pin'").get())
      db.prepare('DELETE FROM shared_skill_cache_pin WHERE op_id=?').run(skillPinOp(runnerId));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

/** Publish only committed source ownership changes to the gateway's source list. */
export function importRemoteManifests(sourcePath:string,gateway:Store,requireLinks=false) {
  const source=new DatabaseSync(resolve(sourcePath),{readOnly:true});
  try {
    if(!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_migration'").get())return;
    const records=source.prepare('SELECT runner_id,address,fingerprint,legacy_json FROM remote_migration').all() as
      {runner_id:string;address:string;fingerprint:string;legacy_json:string}[];
    const db=gateway.database;
    db.exec(`CREATE TABLE IF NOT EXISTS remote_legacy (
      runner_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, address TEXT NOT NULL, fingerprint TEXT NOT NULL, legacy_json TEXT NOT NULL);`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const r of records){
        const prior=db.prepare('SELECT * FROM remote_legacy WHERE runner_id=?').get(r.runner_id) as
          {runner_id:string;link_id:string;address:string;fingerprint:string;legacy_json:string}|undefined;
        const linkId=prior?.link_id??r.runner_id;
        if(requireLinks&&!db.prepare('SELECT 1 FROM workspace_link WHERE id=?').get(linkId))
          throw new Error(`이관한 원격 러너 ${r.runner_id}의 연결이 없습니다. 게이트웨이 시작 전에 연결을 설치하세요`);
        const old=prior;
        if(old){if(old.address!==r.address||old.fingerprint!==r.fingerprint||old.legacy_json!==r.legacy_json)
          throw new Error('게이트웨이의 원격 이관 기록이 기존 원본과 다릅니다');}
        else db.prepare('INSERT INTO remote_legacy VALUES (?,?,?,?,?)').run(r.runner_id,r.runner_id,r.address,r.fingerprint,r.legacy_json);
      }
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }finally{source.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,source,runnerId,file,receiptPath,verifyPath]=process.argv.slice(2);
  if(!['export','import','verify','commit','activate','link','abort','rollback',
    'merge-import','merge-verify','merge-abort','merge-activate','merge-link'].includes(command??''))
    throw new Error('export|import|verify|commit|activate|link|abort|rollback|merge-* 명령을 지정하세요');
  if(command==='merge-link'){
    if(!file||!receiptPath)throw new Error('merge-link 원본DB 게이트웨이DB 기존러너ID 기존공유linkID 형식입니다');
    const store=new Store(resolve(runnerId));const links=new WorkspaceLinks(store);
    try{const view=await links.installMerged(resolve(source),file,receiptPath);
      console.log(JSON.stringify({legacy_runner_id:file,workspace_id:view.workspace_id,source_id:view.id,view_index:view.view_index}));}
    finally{await links.close();store.database.close();}
  }else if(command==='merge-import'||command==='merge-verify'||command==='merge-abort'){
    if(!file||!receiptPath||!existsSync(resolve(source))||!existsSync(resolve(runnerId))||!existsSync(resolve(receiptPath)))
      throw new Error('merge 명령에는 기존 공유 DB·공유 전달 DB·bundle·기존 일반 전달 DB가 필요합니다');
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    const target=new DatabaseSync(resolve(source),{readOnly:command==='merge-verify'});
    const shared=new RemoteJournal(resolve(runnerId)),old=new RemoteJournal(resolve(receiptPath));
    try{
      shared.claim();old.claim();
      if(command==='merge-import'){importEmptyRemoteProjects(bundle,target,old,shared);console.log(JSON.stringify({runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,merged:true}));}
      else if(command==='merge-verify'){
        if(!verifyPath)throw new Error('merge-verify에는 검증 영수증 출력 경로가 필요합니다');
        const receipt=verifyEmptyRemoteMerge(bundle,target,old,shared);
        writeFileSync(resolve(verifyPath),JSON.stringify(receipt),{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));
      }else{
        if(!verifyPath)throw new Error('merge-abort에는 취소 영수증 출력 경로가 필요합니다');
        const receipt=abortEmptyRemoteMerge(bundle,target,old,shared);
        writeFileSync(resolve(verifyPath),JSON.stringify(receipt),{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));
      }
    }finally{old.close();shared.close();target.close();}
  }else if(command==='merge-activate'){
    if(!file)throw new Error('merge-activate에는 원본 commit 영수증 파일이 필요합니다');
    const receipt=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteCommitReceipt;
    const db=new DatabaseSync(resolve(source));try{activateEmptyRemoteMerge(db,runnerId,receipt);
      console.log(JSON.stringify({runner_id:runnerId,activated:true}));}finally{db.close();}
  }else if(command==='link'){
    if(!file||!receiptPath||!verifyPath)throw new Error('link 원본DB 게이트웨이DB 러너ID 원격URL 토큰파일 형식입니다');
    const store=new Store(resolve(runnerId));const links=new WorkspaceLinks(store);
    try{const view=await links.installMigrated(resolve(source),file,{url:receiptPath,token:readFileSync(resolve(verifyPath),'utf8').trim()});
      console.log(JSON.stringify({runner_id:view.id,workspace_id:view.workspace_id,view_index:view.view_index}));}
    finally{await links.close();store.database.close();}
  }else if(command==='export'){
    const db=new DatabaseSync(resolve(source),{readOnly:true});
    try{const bundle=exportRemoteTransfer(db,runnerId,new SkillStore(config.skillsHome));writeFileSync(resolve(file),JSON.stringify(bundle),{mode:0o600,flag:'wx'});
      console.log(JSON.stringify({runner_id:bundle.runner_id,address:bundle.address,fingerprint:bundle.fingerprint,counts:Object.fromEntries(OWNED.map(t=>[t,bundle.rows[t].length]))}));}
    finally{db.close();}
  }else if(command==='import'){
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    if(!existsSync(resolve(runnerId)))throw new Error('기존 원격 전달 DB 파일이 없습니다');
    const store=new Store(resolve(source));const journal=new RemoteJournal(resolve(runnerId));
    try{journal.claim();importRemoteTransfer(bundle,store,journal,new SkillStore(join(dirname(resolve(source)),'desk-plugin')),receiptPath);
      console.log(JSON.stringify({runner_id:bundle.runner_id,fingerprint:bundle.fingerprint,journal_id:journal.id}));}
    finally{journal.close();store.database.close();}
  }else if(command==='verify'){
    if(!receiptPath||!existsSync(resolve(runnerId)))throw new Error('verify에는 기존 전달 DB와 영수증 출력 경로가 필요합니다');
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    const db=new DatabaseSync(resolve(source),{readOnly:true});const journal=new RemoteJournal(resolve(runnerId));
    try{journal.claim();const receipt=verifyRemoteImport(bundle,db,journal,new SkillStore(join(dirname(resolve(source)),'desk-plugin')));
      writeFileSync(resolve(receiptPath),JSON.stringify(receipt),{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));}
    finally{journal.close();db.close();}
  }else if(command==='abort'){
    if(!receiptPath||!existsSync(resolve(runnerId)))throw new Error('abort에는 기존 전달 DB와 취소 영수증 출력 경로가 필요합니다');
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    const db=new DatabaseSync(resolve(source));const journal=new RemoteJournal(resolve(runnerId));
    try{journal.claim();const receipt=abortRemoteImport(bundle,db,journal,new SkillStore(join(dirname(resolve(source)),'desk-plugin')));
      writeFileSync(resolve(receiptPath),JSON.stringify(receipt),{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));}
    finally{journal.close();db.close();}
  }else if(command==='commit'){
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    if(!receiptPath)throw new Error('commit에는 영수증을 저장할 임시 경로가 필요합니다');
    if(!verifyPath)throw new Error('commit에는 대상 DB 검증 영수증 파일이 필요합니다');
    const verified=JSON.parse(readFileSync(resolve(verifyPath),'utf8')) as RemoteImportReceipt;
    const db=new DatabaseSync(resolve(source));try{const receipt=commitRemoteTransfer(db,bundle,verified,new SkillStore(config.skillsHome));
      writeFileSync(resolve(receiptPath),JSON.stringify(receipt),{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));}finally{db.close();}
  }else if(command==='rollback'){
    if(!receiptPath||!verifyPath)throw new Error('rollback에는 원본 commit 영수증과 대상 abort 영수증이 필요합니다');
    const bundle=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteTransfer;
    const committed=JSON.parse(readFileSync(resolve(receiptPath),'utf8')) as RemoteCommitReceipt;
    const aborted=JSON.parse(readFileSync(resolve(verifyPath),'utf8')) as RemoteAbortReceipt;
    const db=new DatabaseSync(resolve(source));try{rollbackRemoteTransfer(db,bundle,committed,aborted);
      console.log(JSON.stringify({runner_id:bundle.runner_id,rolled_back:true}));}finally{db.close();}
  }else{
    if(!file)throw new Error('activate에는 원본 DB 전환 영수증 파일이 필요합니다');
    const receipt=JSON.parse(readFileSync(resolve(file),'utf8')) as RemoteCommitReceipt;
    const db=new DatabaseSync(resolve(source));try{activateRemoteImport(db,runnerId,receipt);console.log(JSON.stringify({runner_id:runnerId,activated:true}));}finally{db.close();}
  }
}
