import { Access } from './access.ts';
import { config } from './config.ts';
import { Store } from './db.ts';
import { Hub } from './hub.ts';
import { createHttpServer } from './http.ts';
import { assertLegacyHubAllowed } from './runner/local-ownership.ts';
import { WorkspaceLinks } from './workspace-links.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { importLegacyWorkspaceLinks } from './runner/local-migration.ts';
import { importRemoteManifests } from './runner/remote-migration.ts';
import { ensureGatewayLocalAuthority } from './runner/local-launch.ts';

const { port: PORT, host: HOST, dbPath: DB_PATH, uploadsDir: UPLOADS_DIR, accessTokenFile: TOKEN_FILE } = config;

const authorityTokenFile = config.localAuthorityTokenFile;
if (!authorityTokenFile) assertLegacyHubAllowed(DB_PATH);
if (authorityTokenFile && (resolve(config.gatewayDbPath) === resolve(DB_PATH)
  || (existsSync(config.gatewayDbPath) && existsSync(DB_PATH) && (()=>{
    const a=statSync(config.gatewayDbPath),b=statSync(DB_PATH);
    return a.dev===b.dev&&a.ino===b.ino;
  })()))) throw new Error('게이트웨이 DB와 로컬 작업공간 DB를 분리하세요');
if (authorityTokenFile) await ensureGatewayLocalAuthority({
  dbPath: DB_PATH,
  gatewayDbPath: config.gatewayDbPath,
  url: config.localAuthorityUrl,
  tokenFile: authorityTokenFile,
  port: Number(new URL(config.localAuthorityUrl).port || config.shared.port),
});
const store = new Store(authorityTokenFile ? config.gatewayDbPath : DB_PATH);
const hub = new Hub(store, authorityTokenFile ? {runner:()=>({connected:false,id:null,engines:new Set(),has:()=>false,handle:()=>{throw new Error('작업 명령은 로컬 작업공간으로 전달해야 합니다');}})} : {});
const workspaces = authorityTokenFile ? new WorkspaceLinks(store,hub.skills) : undefined;
if (workspaces) importLegacyWorkspaceLinks(DB_PATH,store);
if (workspaces) importRemoteManifests(DB_PATH,store,true);
const localAuthorityId = authorityTokenFile ? await workspaces!.configureLocal(config.localAuthorityUrl,readFileSync(authorityTokenFile,'utf8').trim()) : undefined;
const access = new Access(TOKEN_FILE, PORT, undefined, config.allowedHosts);
createHttpServer(hub, access, UPLOADS_DIR, {workspaces,localAuthorityId}).listen(PORT, HOST, async () => {
  console.log(`agent-desk hub listening on http://${HOST}:${PORT} (db: ${authorityTokenFile?config.gatewayDbPath:DB_PATH}${authorityTokenFile?`, canonical: ${DB_PATH}`:''})`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') return;
  const [first, ...rest] = access.urls();
  console.log(`다른 기기에서 열기 (토큰: ${TOKEN_FILE}):\n${await access.qrTerminal(first)}${[first, ...rest].join('\n')}`);
});
