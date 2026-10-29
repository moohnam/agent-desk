import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const CONFIG = resolve(import.meta.dirname, '../../hub/src/config.ts');

/** The config as a process with exactly `env` (plus PATH) sees it. */
function configWith(env: Record<string, string>) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify(config));`],
  { env: { PATH: process.env.PATH ?? '', ...env } });
  return JSON.parse(String(out));
}

test('without settings everything lives in the repo\'s data directory', () => {
  const c = configWith({});
  const data = resolve(import.meta.dirname, '../../data');
  assert.equal(c.dbPath, `${data}/agent-desk.db`);
  assert.equal(c.runner.tokenFile, `${data}/runner-token`);
  assert.equal(c.skillsHome, `${data}/desk-plugin`);
  assert.deepEqual([c.port, c.runner.port, c.runner.idleMs], [4317, 4318, 30 * 60_000]);
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
  assert.deepEqual([c.port, c.runner.port, c.runner.idleMs], [4317, 5000, 30 * 60_000]);
});
