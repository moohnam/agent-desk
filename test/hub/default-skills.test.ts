import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SKILLS, installDefaultSkills } from '../../hub/src/default-skills.ts';
import { SkillStore } from '../../hub/src/skills.ts';

test('new hub gets four usable defaults once; edits and deletions survive later starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-default-skills-')), home = join(dir, 'plugin');
  try {
    assert.equal(installDefaultSkills(home), true);
    const store = new SkillStore(home);
    assert.deepEqual(store.names(), [...DEFAULT_SKILLS].sort());
    for (const skill of store.list()) { assert.ok(skill.description); assert.equal(skill.error, undefined); }
    const doc = join(home, 'skills', 'docufy', 'SKILL.md');
    writeFileSync(doc, readFileSync(doc, 'utf8') + '\n사용자 수정\n');
    store.remove('eli5');
    assert.equal(installDefaultSkills(home), false);
    assert.match(readFileSync(doc, 'utf8'), /사용자 수정/);
    assert.ok(!store.names().includes('eli5'));
    assert.ok(!readdirSync(home).some(name => name.startsWith('.default-skills-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('existing skill stores, even empty ones, are not seeded or overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-existing-skills-'));
  try {
    const store = new SkillStore(join(dir, 'plugin'));
    assert.equal(installDefaultSkills(store.home), false);
    assert.deepEqual(store.names(), []);
    store.create('personal', '사용자 스킬');
    assert.equal(installDefaultSkills(store.home), false);
    assert.deepEqual(store.names(), ['personal']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
