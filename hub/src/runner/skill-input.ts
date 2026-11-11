import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SkillSnapshot, SkillTransfer } from '../../../shared/protocol.ts';
import { skillDigest, validateSkillBundle } from '../shared-skill-sync.ts';
import { SkillStore } from '../skills.ts';

const MAX_FILES = 1000;

export function listSkillSnapshotHomes(skillsHome: string): string[] {
  const base = join(skillsHome, '.snapshots');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(ent => ent.isDirectory() && /^[a-f0-9]{64}$/.test(ent.name)).map(ent => join(base, ent.name));
}

function diskFiles(home: string): SkillTransfer[] {
  const root = join(home, 'skills'), files: SkillTransfer[] = [];
  const walk = (dir: string, name: string, prefix = '') => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = join(dir, ent.name), st = lstatSync(full);
      if (st.isDirectory()) walk(full, name, path);
      else if (st.isFile()) files.push({ name, path, content: readFileSync(full, 'utf8'), executable: !!(st.mode & 0o111) });
      else throw new Error('스킬 스냅샷에 일반 파일이 아닌 항목이 있습니다');
      if (files.length > MAX_FILES) throw new Error('스킬 스냅샷 파일이 너무 많습니다');
    }
  };
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) throw new Error('스킬 스냅샷 루트가 손상되었습니다');
    walk(join(root, ent.name), ent.name);
  }
  return files;
}

/** A version lives at a digest path; an existing version is verified before it is reused. */
export function materializeSkillSnapshot(skillsHome: string, snapshot: SkillSnapshot, protectedHomes: Iterable<string> = []): string {
  const groups = validateSkillBundle(snapshot);
  if (!/^[a-f0-9]{64}$/.test(snapshot.digest)) throw new Error('스킬 스냅샷 지문이 잘못되었습니다');
  const base = join(skillsHome, '.snapshots'), home = join(base, snapshot.digest);
  const matches = () => {
    try { return existsSync(home) && skillDigest(diskFiles(home)) === snapshot.digest; } catch { return false; }
  };
  if (matches()) return home;
  const estimated = snapshot.files.reduce((size, file) => size + Buffer.byteLength(file.content), 4096);
  pruneSkillSnapshots(skillsHome, protectedHomes, existsSync(home) ? 0 : estimated, existsSync(home) ? 0 : 1);
  mkdirSync(base, { recursive: true });
  const stage = join(base, `.stage-${randomUUID()}`), staged = new SkillStore(stage);
  try {
    for (const [name, files] of groups) {
      staged.create(name);
      for (const file of files) staged.writeFile(name, file.path, file.content, file.executable);
    }
    if (skillDigest(diskFiles(stage)) !== snapshot.digest) throw new Error('스킬 스냅샷 준비에 실패했습니다');
    if (existsSync(home)) renameSync(home, join(base, `.damaged-${randomUUID()}`));
    renameSync(stage, home);
    return home;
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
}

/** Retain active session roots, then the newest 128 versions up to 512 MiB. Queued inputs carry files. */
export function pruneSkillSnapshots(skillsHome: string, protectedHomes: Iterable<string>, reserveBytes = 0, reserveCount = 0) {
  const base = join(skillsHome, '.snapshots');
  if (!existsSync(base)) {
    if (reserveBytes > 512 * 1024 * 1024 || reserveCount > 128) throw new Error('스킬 스냅샷 캐시 용량을 초과했습니다');
    return;
  }
  const protectedSet = new Set(protectedHomes);
  const sizeOf = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, ent) => {
    const full = join(dir, ent.name);
    return sum + (ent.isDirectory() ? sizeOf(full) : statSync(full).size);
  }, 0);
  const entries = readdirSync(base, { withFileTypes: true })
    .filter(ent => ent.isDirectory() && /^[a-f0-9]{64}$/.test(ent.name))
    .map(ent => { const path = join(base, ent.name); return { path, modified: statSync(path).mtimeMs, bytes: sizeOf(path) }; })
    .sort((a, b) => b.modified - a.modified);
  const protectedEntries = entries.filter(entry => protectedSet.has(entry.path));
  let kept = reserveCount + protectedEntries.length;
  let bytes = reserveBytes + protectedEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (kept > 128 || bytes > 512 * 1024 * 1024) throw new Error('실행 중인 스킬 스냅샷 때문에 캐시 용량을 초과했습니다');
  for (const entry of entries) {
    if (protectedSet.has(entry.path)) continue;
    if (kept < 128 && bytes + entry.bytes <= 512 * 1024 * 1024) { kept++; bytes += entry.bytes; continue; }
    rmSync(entry.path, { recursive: true, force: true });
  }
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    if (ent.isDirectory() && ent.name.startsWith('.damaged-')) rmSync(join(base, ent.name), { recursive: true, force: true });
  }
}

/** Native skill items alone are not expanded by Codex's mid-turn steering path. */
export function steeringSkillText(text: string, skills: string[] | undefined, skillsHome: string | undefined): string {
  if (!skillsHome || !skills?.length) return text;
  const files = skills.map(name => `#${name}: ${JSON.stringify(join(skillsHome, 'skills', name, 'SKILL.md'))}`).join('\n');
  const header = `[데스크 스킬] 이 메시지에는 먼저 다음 스킬 파일을 읽고 그 지침을 따르세요:\n${files}\n이번 입력의 하위 스킬 참조와 부속 파일은 ${JSON.stringify(join(skillsHome, 'skills'))} 아래에서 찾으세요. 세션 시작 때 등록한 스킬 루트보다 이번 입력의 루트가 우선합니다. 하위 스킬은 상위 지침의 사용 조건에 맞을 때만 읽으세요.\n\n`;
  return text.startsWith(header) ? text : header + (text || '(추가 지시 없음)');
}
