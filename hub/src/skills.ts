// Desk skills: one directory both engines read.
//
//   <SKILLS_HOME>/                    a local Claude Code plugin named "desk"
//     .claude-plugin/plugin.json
//     skills/<name>/SKILL.md          frontmatter (name, description) + instructions
//     skills/<name>/scripts/…         optional helper scripts (made executable)
//     skills/<name>/…                 any other reference files
//
// Claude loads the plugin (skills appear as `desk:<name>`); Codex gets `skills/` as an extra
// skills root. The hub manages the files; the runner only needs the paths.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Skill, SkillFile } from '../../shared/api.ts';
import { RESERVED_TAGS, SKILL_NAME } from '../../shared/compose.ts';

export const SKILLS_HOME = process.env.AGENT_DESK_SKILLS_HOME ?? resolve(import.meta.dirname, '../../data/desk-plugin');
export const PLUGIN_NAME = 'desk';
export const skillsRoot = () => join(SKILLS_HOME, 'skills');
export const skillFile = (name: string) => join(skillsRoot(), name, 'SKILL.md');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 200;


export class SkillError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Reads `key: value` pairs from a leading `---` block. Values may be quoted; no nesting. */
export function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** True for a regular file that is not a symlink. */
const plainFile = (p: string) => { try { return lstatSync(p).isFile(); } catch { return false; } };

/** True when `p` is `dir` itself or lies under it. Both should already be realpaths. */
const within = (dir: string, p: string) => p === dir || p.startsWith(dir + sep);

function template(name: string, description: string) {
  const desc = description.trim().replace(/\s+/g, ' ') || `${name} 스킬`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${name}\n\n이 스킬을 쓸 때 따를 절차를 적습니다.\n\n## 절차\n\n1. \n\n## 스크립트\n\n필요하면 scripts/ 아래에 두고, 이 파일 기준 상대 경로로 안내합니다.\n`;
}

export class SkillStore {
  readonly home: string;
  constructor(home = SKILLS_HOME) { this.home = home; this.ensurePlugin(); }

  private get root() { return join(this.home, 'skills'); }

  private ensurePlugin() {
    mkdirSync(join(this.home, '.claude-plugin'), { recursive: true });
    mkdirSync(this.root, { recursive: true });
    const manifest = join(this.home, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) {
      writeFileSync(manifest, JSON.stringify({
        name: PLUGIN_NAME, version: '0.1.0', description: 'Agent Desk에서 관리하는 스킬',
      }, null, 2) + '\n');
    }
  }

  static validName(name: string) {
    if (!SKILL_NAME.test(name)) throw new SkillError(400, '스킬 이름은 영문 소문자·숫자·하이픈으로 64자 이내여야 합니다');
    if (RESERVED_TAGS.includes(name)) throw new SkillError(400, `#${name}은 기본 태그라 스킬 이름으로 쓸 수 없습니다`);
  }

  private dir(name: string) {
    SkillStore.validName(name);
    return join(this.root, name);
  }

  /** Resolves a path inside a skill directory, refusing anything that escapes it. */
  private filePath(name: string, path: string) {
    const base = this.dir(name);
    const rel = normalize(String(path ?? '').replace(/^\/+/, ''));
    if (!rel || rel === '.' || rel.startsWith('..') || rel.split(sep).includes('..')) {
      throw new SkillError(400, `잘못된 파일 경로입니다: ${path}`);
    }
    const full = join(base, rel);
    if (!full.startsWith(base + sep)) throw new SkillError(400, `잘못된 파일 경로입니다: ${path}`);
    if (existsSync(base) && !this.inside(base, full)) throw new SkillError(400, `스킬 밖을 가리키는 경로입니다: ${path}`);
    return { base, rel, full };
  }

  /**
   * The string checks above miss symlinks: follows them and requires the real path to stay inside
   * the real skill directory, which itself must be a real directory under the real skills root.
   * A path that doesn't exist yet (a write) is judged by its nearest existing ancestor; a dangling
   * link counts as existing and is refused, since writing through it would land wherever it points.
   */
  private inside(base: string, full: string) {
    try {
      const realBase = realpathSync(base);
      if (realBase !== join(realpathSync(this.root), relative(this.root, base))) return false;
      let p = full;
      for (;;) {
        try { lstatSync(p); break; } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || p === base) return false;
          p = dirname(p);
        }
      }
      return within(realBase, realpathSync(p));
    } catch { return false; }
  }

  private walk(base: string, sub = ''): SkillFile[] {
    const out: SkillFile[] = [];
    for (const ent of readdirSync(join(base, sub), { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${ent.name}` : ent.name;
      if (ent.isDirectory()) out.push(...this.walk(base, rel));
      else if (ent.isFile()) {
        const st = statSync(join(base, rel));
        out.push({ path: rel, size: st.size, executable: (st.mode & 0o111) !== 0 });
      }
      if (out.length >= MAX_FILES) break;
    }
    return out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  }

  /** Names of the skills a #tag can call: directories holding a SKILL.md. */
  names(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SKILL_NAME.test(d.name) && plainFile(join(this.root, d.name, 'SKILL.md')))
        .map((d) => d.name).sort();
    } catch { return []; }
  }

  get(name: string): Skill {
    const base = this.dir(name);
    const md = join(base, 'SKILL.md');
    // Symlinked SKILL.md or skill directory: not listed by names(), and not read through here either.
    if (!plainFile(md) || !this.inside(base, md)) throw new SkillError(404, `스킬이 없습니다: ${name}`);
    const fm = frontmatter(readFileSync(md, 'utf8'));
    const files = this.walk(base);
    const updated = Math.max(...files.map((f) => statSync(join(base, f.path)).mtimeMs), statSync(base).mtimeMs);
    const error = fm.name && fm.name !== name ? `SKILL.md의 name(${fm.name})이 디렉터리 이름과 다릅니다` : undefined;
    return { name, description: fm.description ?? '', files, updated_at: new Date(updated).toISOString(), error };
  }

  list(): Skill[] { return this.names().map((n) => this.get(n)); }

  create(name: string, description = ''): Skill {
    const base = this.dir(name);
    if (existsSync(base)) throw new SkillError(409, `이미 있는 스킬입니다: ${name}`);
    mkdirSync(join(base, 'scripts'), { recursive: true });
    writeFileSync(join(base, 'SKILL.md'), template(name, description));
    return this.get(name);
  }

  remove(name: string) {
    const base = this.dir(name);
    if (!existsSync(base)) throw new SkillError(404, `스킬이 없습니다: ${name}`);
    rmSync(base, { recursive: true, force: true });
  }

  readFile(name: string, path: string): { path: string; content: string; executable: boolean } {
    const { full, rel } = this.filePath(name, path);
    if (!existsSync(full) || !statSync(full).isFile()) throw new SkillError(404, `파일이 없습니다: ${rel}`);
    const st = statSync(full);
    if (st.size > MAX_FILE_BYTES) throw new SkillError(413, `파일이 너무 커서 열 수 없습니다: ${rel}`);
    return { path: rel, content: readFileSync(full, 'utf8'), executable: (st.mode & 0o111) !== 0 };
  }

  /** Scripts (under scripts/ or starting with #!) are made executable. */
  writeFile(name: string, path: string, content: string, executable?: boolean): Skill {
    const { base, full, rel } = this.filePath(name, path);
    if (!existsSync(base)) throw new SkillError(404, `스킬이 없습니다: ${name}`);
    if (typeof content !== 'string') throw new SkillError(400, 'content는 문자열이어야 합니다');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new SkillError(413, '파일은 1MB 이하여야 합니다');
    if (rel === 'SKILL.md') {
      const fm = frontmatter(content);
      if (!fm.name || !fm.description) throw new SkillError(400, 'SKILL.md 맨 앞 --- 블록에 name과 description이 있어야 합니다');
      if (fm.name !== name) throw new SkillError(400, `SKILL.md의 name은 디렉터리 이름(${name})과 같아야 합니다`);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    const exec = executable ?? (rel.startsWith('scripts/') || content.startsWith('#!'));
    chmodSync(full, exec ? 0o755 : 0o644);
    return this.get(name);
  }

  deleteFile(name: string, path: string): Skill {
    const { full, rel } = this.filePath(name, path);
    if (rel === 'SKILL.md') throw new SkillError(400, 'SKILL.md는 지울 수 없습니다. 스킬 전체를 지우세요');
    if (!existsSync(full)) throw new SkillError(404, `파일이 없습니다: ${rel}`);
    rmSync(full);
    return this.get(name);
  }

  /** For display: where a skill's files live, relative to the desk plugin. */
  where(name: string) { return relative(this.home, this.dir(name)); }
}
