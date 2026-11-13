// Every setting the hub and the runner read from the environment, in one place. The hub starts the
// runner daemon with its own environment, so both resolve the same paths and ports.
//
// Data files default to the directory of the database (the repo's data/), so pointing AGENT_DESK_DB
// elsewhere moves them all; each can still be set on its own.

import { dirname, join, resolve } from 'node:path';
import { readLocalLaunchSettings } from './runner/local-launch.ts';

const env = process.env;
const REPO = resolve(import.meta.dirname, '../..');
const positive = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : fallback;
};

export const DB_PATH = env.AGENT_DESK_DB ?? join(REPO, 'data', 'agent-desk.db');
const DATA_DIR = dirname(DB_PATH);
const localLaunch = env.AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE && env.AGENT_DESK_GATEWAY_DB && env.AGENT_DESK_LOCAL_AUTHORITY_URL
  ? undefined : readLocalLaunchSettings(env.AGENT_DESK_LOCAL_MODE_FILE ?? join(DATA_DIR, 'local-mode.json'));

export const config = {
  /** The hub's HTTP port; HOST=127.0.0.1 keeps it to this machine, else other devices connect with the access token. */
  port: positive(env.PORT, 4317),
  host: env.HOST ?? '0.0.0.0',
  dbPath: DB_PATH,
  gatewayDbPath: env.AGENT_DESK_GATEWAY_DB ?? localLaunch?.gatewayDbPath ?? join(DATA_DIR, 'gateway.db'),
  localAuthorityTokenFile: env.AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE ?? localLaunch?.tokenFile,
  localAuthorityUrl: env.AGENT_DESK_LOCAL_AUTHORITY_URL ?? localLaunch?.authorityUrl ?? `http://127.0.0.1:${positive(env.AGENT_DESK_SHARED_PORT, 4321)}/`,
  uploadsDir: env.AGENT_DESK_UPLOADS ?? join(DATA_DIR, 'uploads'),
  accessTokenFile: env.AGENT_DESK_TOKEN_FILE ?? join(DATA_DIR, 'access-token'),
  /**
   * Host names other devices may address the hub by, besides this Mac's IPv4 addresses and
   * `<name>.local` (comma-separated, e.g. a Tailscale MagicDNS name). Others are refused, so a web
   * page can't rebind its own domain to the hub and act as a device.
   */
  allowedHosts: (env.AGENT_DESK_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  /** The desk plugin directory engines load desk skills from (skills.ts). */
  skillsHome: env.AGENT_DESK_SKILLS_HOME ?? join(DATA_DIR, 'desk-plugin'),
  webDist: join(REPO, 'web', 'dist'),
  /** Optional Chrome/Chromium executable for hub-side Mermaid rendering. */
  diagramBrowser: env.AGENT_DESK_DIAGRAM_BROWSER,
  runner: {
    host: '127.0.0.1',
    port: positive(env.RUNNER_PORT, 4318),
    log: env.RUNNER_LOG ?? join(DATA_DIR, 'runner.log'),
    pidFile: env.RUNNER_PID_FILE ?? join(DATA_DIR, 'runner.pid'),
    /** The secret a hub shows the runner when it connects (wire.ts). */
    tokenFile: env.RUNNER_TOKEN_FILE ?? join(DATA_DIR, 'runner-token'),
    /** A session neither busy nor awaiting approval for this long is closed; the next message resumes it. */
    idleMs: positive(env.RUNNER_IDLE_MS, 30 * 60_000),
  },
  codexBin: env.CODEX_BIN || 'codex',
  agyBin: env.AGY_BIN || 'agy',
  shared: {
    directory: env.AGENT_DESK_SHARED_DIR ?? join(DATA_DIR, 'shared-runner'),
    address: env.AGENT_DESK_SHARED_ADDRESS,
    port: positive(env.AGENT_DESK_SHARED_PORT, 4321),
    migrationRunnerId: env.AGENT_DESK_REMOTE_MIGRATED_RUNNER_ID,
  },
  remote: {
    hubUrl: env.AGENT_DESK_HUB_URL,
    id: env.AGENT_DESK_RUNNER_ID,
    tokenFile: env.AGENT_DESK_REMOTE_TOKEN_FILE,
    dbPath: env.AGENT_DESK_REMOTE_DB ?? join(DATA_DIR, 'remote-runner.db'),
  },
};
