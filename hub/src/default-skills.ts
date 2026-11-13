import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SKILLS = ['docufy', 'adre', 'eli5', 'remote-runner'] as const;

/** Seed only a new hub. Existing, edited, or deliberately removed skills belong to the user. */
export function installDefaultSkills(home: string) {
  const root = join(home, 'skills');
  if (existsSync(root) || existsSync(join(home, '.claude-plugin', 'plugin.json'))) return false;
  mkdirSync(home, { recursive: true });
  const stage = mkdtempSync(join(home, '.default-skills-'));
  try {
    for (const name of DEFAULT_SKILLS) {
      const source = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
      mkdirSync(join(stage, name));
      writeFileSync(join(stage, name, 'SKILL.md'), readFileSync(source));
    }
    if (existsSync(root)) return false;
    try { renameSync(stage, root); }
    catch (error) {
      // A concurrent first start may have already installed or created user skills.
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
    return true;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
