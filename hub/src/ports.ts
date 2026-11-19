import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const profile = '.desk-ports-v2';
export const CURRENT_PORTS = { hub: 17641, daemon: 17642, workspace: 17643 };
const LEGACY_PORTS = { hub: 4317, daemon: 4318, workspace: 4321 };

export function configuredPort(value: string | undefined, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

/** Existing installations keep implicit legacy ports. A fresh one records its defaults before creating data. */
export function deskPortDefaults(dbPath: string, env: NodeJS.ProcessEnv = {}, cwd = process.cwd()) {
  dbPath = resolve(cwd, dbPath);
  const dataDir = dirname(dbPath);
  if (existsSync(join(dataDir, profile))) return CURRENT_PORTS;
  return [dbPath, join(dataDir, 'gateway.db'), join(dataDir, 'local-mode.json'),
    join(dataDir, 'runner-token'), join(dataDir, 'access-token'), env.AGENT_DESK_GATEWAY_DB ?? '',
    env.AGENT_DESK_LOCAL_MODE_FILE ?? '', env.RUNNER_TOKEN_FILE ?? '', env.AGENT_DESK_TOKEN_FILE ?? '']
    .some(path => path && existsSync(resolve(cwd, path)))
    ? LEGACY_PORTS : CURRENT_PORTS;
}

export function sharedPortDefaults(directory: string) {
  return deskPortDefaults(join(directory, 'workspace.db'), { AGENT_DESK_GATEWAY_DB: join(directory, 'delivery.db') });
}

export function managedPortEnvironment(dataDir: string, environment: NodeJS.ProcessEnv, shared: boolean) {
  const ports = deskPortDefaults(environment.AGENT_DESK_DB ?? join(dataDir, 'agent-desk.db'), environment);
  const workspace = shared ? sharedPortDefaults(environment.AGENT_DESK_SHARED_DIR ?? join(dataDir, 'shared-runner')).workspace : ports.workspace;
  return { PORT: String(ports.hub), RUNNER_PORT: String(ports.daemon), AGENT_DESK_SHARED_PORT: String(workspace) };
}

export function recordPortDefaults(directory: string, defaults: typeof CURRENT_PORTS) {
  if (defaults !== CURRENT_PORTS) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { writeFileSync(join(directory, profile), 'v2\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
