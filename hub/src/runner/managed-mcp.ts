import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SharedWorkspace } from '../shared-workspace.ts';
import { DESK_TOOL_NAMES } from '../mcp.ts';

/** Only the engine child receives this workspace-scoped MCP connection. */
export interface RunnerMcp {
  url: string;
  workspaceId?: string;
  token?: string;
}

const SERVER = 'agent-desk-runtime';
const AUTH_ENV = 'AGENT_DESK_RUNNER_MCP_AUTH';
const CREDENTIAL_FILE = 'engine-mcp-credential.json';

/** A dedicated peer survives restarts; a revoked or altered credential fails closed. */
export function sharedRunnerMcp(workspace: SharedWorkspace, dir: string, port: number): RunnerMcp {
  const path = join(dir, CREDENTIAL_FILE);
  let credential: { workspaceId: string; peerId: string; token: string };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('엔진 MCP 인증 파일 권한이 올바르지 않습니다');
    try { credential = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('엔진 MCP 인증 파일 형식이 잘못되었습니다'); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const peer = workspace.grant('agent-desk-runtime');
    credential = { workspaceId: peer.workspace_id, peerId: peer.id, token: peer.token };
    try { writeFileSync(path, JSON.stringify(credential), { mode: 0o600, flag: 'wx' }); }
    catch (writeError) { workspace.revoke(peer.id); throw writeError; }
  }
  if (!credential || typeof credential.workspaceId !== 'string' || typeof credential.peerId !== 'string'
    || typeof credential.token !== 'string' || credential.workspaceId !== workspace.id
    || !/^[A-Za-z0-9_-]{32,256}$/.test(credential.token)
    || workspace.authenticate(credential.token) !== credential.peerId)
    throw new Error('엔진 MCP 인증이 현재 작업공간과 일치하지 않거나 취소되었습니다');
  return { url: `http://127.0.0.1:${port}/v1/mcp`, workspaceId: workspace.id, token: credential.token };
}

const CONNECTOR_SERVER = 'agent-desk-connections';
const CONNECTOR_AUTH_ENV = 'AGENT_DESK_CONNECTOR_MCP_AUTH';
const CONNECTOR_TOOLS = ['desk_connector_list', 'desk_connector_tools', 'desk_connector_read'];
type ConnectorMcp = {url:string;token:string};

/** Config flags contain endpoint and environment variable names, never bearer values. */
export function codexMcpProcess(mcp?: RunnerMcp, connector?: ConnectorMcp): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = ['app-server'];
  const env = { ...process.env };
  delete env[AUTH_ENV]; delete env[CONNECTOR_AUTH_ENV];
  const add = (name:string, url:string, tools:readonly string[], auth?:{name:string;token:string;workspaceId?:string}) => {
    const key = `mcp_servers.${name}`;
    args.push('-c', `${key}.url=${JSON.stringify(url)}`, '-c', `${key}.enabled=true`,
      '-c', `${key}.enabled_tools=${JSON.stringify(tools)}`, '-c', `${key}.disabled_tools=[]`);
    if (auth) {
      env[auth.name] = `Bearer ${auth.token}`;
      args.push('-c', `${key}.env_http_headers={Authorization=${JSON.stringify(auth.name)}}`);
      if (auth.workspaceId) args.push('-c', `${key}.http_headers={"x-workspace-id"=${JSON.stringify(auth.workspaceId)}}`);
    }
  };
  if (mcp) {
    if (mcp.token && !mcp.workspaceId) throw new Error('인증된 엔진 MCP에는 작업공간 ID가 필요합니다');
    add(SERVER,mcp.url,DESK_TOOL_NAMES,mcp.token ? {name:AUTH_ENV,token:mcp.token,workspaceId:mcp.workspaceId} : undefined);
  }
  if (connector) add(CONNECTOR_SERVER,connector.url,CONNECTOR_TOOLS,{name:CONNECTOR_AUTH_ENV,token:connector.token});
  return { args, env };
}

/** Claude expands placeholders using only this engine child's environment. */
export function claudeMcpOptions(mcp?: RunnerMcp, connector?: ConnectorMcp) {
  if (mcp?.token && !mcp.workspaceId) throw new Error('인증된 엔진 MCP에는 작업공간 ID가 필요합니다');
  const mcpServers:Record<string,{type:'http';url:string;headers?:Record<string,string>}> = {};
  const env = {...process.env};
  delete env[AUTH_ENV]; delete env[CONNECTOR_AUTH_ENV];
  if (mcp) {
    mcpServers[SERVER] = {type:'http',url:mcp.url,...(mcp.token ? {headers:{
      Authorization:'${' + AUTH_ENV + '}', 'x-workspace-id':mcp.workspaceId!,
    }} : {})};
    if (mcp.token) env[AUTH_ENV] = `Bearer ${mcp.token}`;
  }
  if (connector) {
    mcpServers[CONNECTOR_SERVER] = {type:'http',url:connector.url,headers:{Authorization:'${' + CONNECTOR_AUTH_ENV + '}'}};
    env[CONNECTOR_AUTH_ENV] = `Bearer ${connector.token}`;
  }
  return {mcpServers,env};
}
