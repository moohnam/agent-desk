import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { managedPortEnvironment, recordPortDefaults, sharedPortDefaults } from '../../hub/src/ports.ts';

const CONFIG = resolve(import.meta.dirname, '../../hub/src/config.ts');

/** The config as a process with exactly `env` (plus PATH) sees it. */
function configWith(env: Record<string, string>, activate = false) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { config, recordDeskPortDefaults } = await import(${JSON.stringify(CONFIG)}); if (${activate}) recordDeskPortDefaults(); console.log(JSON.stringify(config));`],
  { env: { PATH: process.env.PATH ?? '', ...env } });
  return JSON.parse(String(out));
}

test('without settings everything lives in the repo\'s data directory', () => {
  const c = configWith({});
  const data = resolve(import.meta.dirname, '../../data');
  assert.equal(c.dbPath, `${data}/agent-desk.db`);
  assert.equal(c.runner.tokenFile, `${data}/runner-token`);
  assert.equal(c.skillsHome, `${data}/desk-plugin`);
  assert.equal(c.runner.idleMs, 30 * 60_000);
});

test('moving the database moves the other data files with it', () => {
  const c = configWith({ AGENT_DESK_DB: '/srv/desk/desk.db' });
  assert.deepEqual([c.uploadsDir, c.accessTokenFile, c.skillsHome, c.runner.log, c.runner.pidFile, c.runner.tokenFile], [
    '/srv/desk/uploads', '/srv/desk/access-token', '/srv/desk/desk-plugin', '/srv/desk/runner.log', '/srv/desk/runner.pid', '/srv/desk/runner-token',
  ]);
});

test('each file and number can still be set on its own; nonsense numbers fall back', () => {
  const c = configWith({ AGENT_DESK_DB: '/srv/desk/desk.db', RUNNER_LOG: '/var/log/runner.log', RUNNER_PORT: '5000', PORT: 'x', RUNNER_IDLE_MS: '-1' });
  assert.equal(c.runner.log, '/var/log/runner.log');
  assert.equal(c.runner.pidFile, '/srv/desk/runner.pid');
  assert.equal(c.port, configWith({ AGENT_DESK_DB: '/srv/desk/desk.db' }).port);
  assert.deepEqual([c.runner.port, c.runner.idleMs], [5000, 30 * 60_000]);
});

test('new installations pin the new defaults before their database and tokens appear', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-port-profile-'));
  try {
    const db = join(dir, 'desk.db'), env = { AGENT_DESK_DB: db };
    const selected = configWith(env);
    assert.deepEqual([selected.port, selected.runner.port, selected.shared.port], [17641, 17642, 17643]);
    assert.equal(existsSync(join(dir, '.desk-ports-v2')), false, 'reading config does not create data');
    configWith(env, true);
    writeFileSync(db, '');
    writeFileSync(join(dir, 'runner-token'), '');
    assert.equal(configWith(env).port, 17641);
    assert.deepEqual(managedPortEnvironment(dir, env, false), { PORT: '17641', RUNNER_PORT: '17642', AGENT_DESK_SHARED_PORT: '17643' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy installations keep their implicit ports and explicit settings still override them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-legacy-ports-'));
  try {
    const db = join(dir, 'agent-desk.db');
    writeFileSync(db, '');
    const c = configWith({ AGENT_DESK_DB: db }, true);
    assert.deepEqual([c.port, c.runner.port, c.shared.port], [4317, 4318, 4321]);
    assert.equal(existsSync(join(dir, '.desk-ports-v2')), false);
    const custom = configWith({ AGENT_DESK_DB: db, PORT: '18411', RUNNER_PORT: '18412', AGENT_DESK_SHARED_PORT: '18413' });
    assert.deepEqual([custom.port, custom.runner.port, custom.shared.port], [18411, 18412, 18413]);
    const shared = join(dir, 'separate-runner');
    recordPortDefaults(shared, sharedPortDefaults(shared));
    writeFileSync(join(shared, 'workspace.db'), '');
    assert.equal(managedPortEnvironment(dir, { AGENT_DESK_SHARED_DIR: shared }, true).AGENT_DESK_SHARED_PORT, '17643');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
