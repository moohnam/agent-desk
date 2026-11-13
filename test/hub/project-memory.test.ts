import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProjectMemoryFile, workspaceFile } from '../../hub/src/shared-files.ts';
import type { Hub } from '../../hub/src/hub.ts';

test('workspace file opens project memory outside both checkout and configured temporary root', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'desk-memory-open-')));
  const project = join(dir, 'project'), config = join(dir, 'claude'), temp = join(dir, 'artifacts');
  const memory = join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  const oldTemp = process.env.TMPDIR, oldConfig = process.env.CLAUDE_CONFIG_DIR;
  t.after(async () => {
    if (oldTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemp;
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(project); await mkdir(temp); await mkdir(memory, { recursive: true });
  process.env.TMPDIR = temp; process.env.CLAUDE_CONFIG_DIR = config;
  const hub = { cwdOf: () => project } as unknown as Hub;
  for (const name of ['MEMORY.md', 'v110-discussions-yhnam.md']) {
    const path = join(memory, name); await writeFile(path, 'fixture');
    const result = await workspaceFile(hub, 'task', path);
    try { assert.equal(await result.file.readFile('utf8'), 'fixture'); }
    finally { await result.file.close(); }
  }
  const outside = join(dir, 'outside.md'); await writeFile(outside, 'outside');
  await assert.rejects(workspaceFile(hub, 'task', outside), { status: 403 });
});

test('project memory access permits only matching Markdown notes and rejects redirected roots/files', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'desk-memory-test-')));
  const project = '/home/test/project', config = join(dir, 'claude');
  const own = join(config, 'projects', '-home-test-project', 'memory');
  const other = join(config, 'projects', '-home-test-other', 'memory');
  try {
    await mkdir(own, { recursive: true }); await mkdir(other, { recursive: true });
    for (const path of [join(own, 'MEMORY.md'), join(own, 'note.md'), join(own, 'secret.json'), join(other, 'other.md')]) await writeFile(path, 'fixture');
    const allows = async (path: string) => isProjectMemoryFile(project, await realpath(path), config);
    assert.equal(await allows(join(own, 'MEMORY.md')), true);
    assert.equal(await allows(join(own, 'note.md')), true);
    assert.equal(await allows(join(own, 'secret.json')), false);
    assert.equal(await allows(join(other, 'other.md')), false);
    await symlink(join(other, 'other.md'), join(own, 'escape.md'));
    assert.equal(await allows(join(own, 'escape.md')), false);
    await rm(own, { recursive: true }); await symlink(other, own);
    assert.equal(await allows(join(own, 'other.md')), false);
    // Also reject an unresolved pathname under a redirected root.
    assert.equal(await isProjectMemoryFile(project, join(own, 'other.md'), config), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
