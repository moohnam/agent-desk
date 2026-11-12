import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { claudeMcpOptions, codexMcpProcess, sharedRunnerMcp } from '../../hub/src/runner/managed-mcp.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-managed-mcp-'));
  const store = new Store(join(dir, 'workspace.db'));
  const workspace = new SharedWorkspace(undefined, store);
  const path = join(dir, 'engine-mcp-credential.json');
  return { dir, store, workspace, path, close() { store.database.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('shared runner credential is private, reused, and rejected after revocation', () => {
  const f = fixture();
  try {
    const first = sharedRunnerMcp(f.workspace, f.dir, 7432);
    assert.equal(first.url, 'http://127.0.0.1:7432/v1/mcp');
    assert.equal(first.workspaceId, f.workspace.id);
    assert.equal(statSync(f.path).mode & 0o077, 0);
    assert.equal(sharedRunnerMcp(f.workspace, f.dir, 7432).token, first.token);
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    f.workspace.revoke(saved.peerId);
    assert.throws(() => sharedRunnerMcp(f.workspace, f.dir, 7432), /취소/);
  } finally { f.close(); }
});

test('damaged, foreign and public credential files fail without disclosing their contents', () => {
  const f = fixture();
  try {
    const mcp = sharedRunnerMcp(f.workspace, f.dir, 7432);
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    writeFileSync(f.path, '{"token":"sensitive-marker",', { mode: 0o600 });
    assert.throws(() => sharedRunnerMcp(f.workspace, f.dir, 7432), error => {
      assert.equal(String(error).includes('sensitive-marker'), false);
      return true;
    });
    writeFileSync(f.path, JSON.stringify({ ...saved, workspaceId: 'foreign-workspace' }));
    assert.throws(() => sharedRunnerMcp(f.workspace, f.dir, 7432), /일치하지 않거나 취소/);
    writeFileSync(f.path, JSON.stringify(saved));
    chmodSync(f.path, 0o644);
    assert.throws(() => sharedRunnerMcp(f.workspace, f.dir, 7432), /권한/);
    assert.ok(mcp.token);
  } finally { f.close(); }
});

test('engine MCP options keep the bearer out of argv and config text', () => {
  const f = fixture();
  try {
    const mcp = sharedRunnerMcp(f.workspace, f.dir, 7432);
    const codex = codexMcpProcess(mcp);
    assert.equal(codex.args[0], 'app-server');
    assert.equal(codex.args.join(' ').includes(mcp.token!), false);
    assert.equal(codex.args.join(' ').includes('env_http_headers'), true);
    const flags = codex.args.filter(arg => arg.startsWith('mcp_servers.agent-desk-runtime.'));
    assert.ok(flags.includes('mcp_servers.agent-desk-runtime.enabled=true'));
    assert.ok(flags.includes('mcp_servers.agent-desk-runtime.disabled_tools=[]'));
    const enabled = flags.find(arg => arg.startsWith('mcp_servers.agent-desk-runtime.enabled_tools='))!;
    assert.ok(JSON.parse(enabled.split('=').slice(1).join('=')).includes('desk_reply'));
    assert.ok(JSON.parse(enabled.split('=').slice(1).join('=')).includes('desk_request'));
    const prior = new Map([
      ['mcp_servers.agent-desk-runtime.enabled', 'false'],
      ['mcp_servers.agent-desk-runtime.enabled_tools', '["desk_post"]'],
      ['mcp_servers.agent-desk-runtime.disabled_tools', '["desk_reply"]'],
      ['mcp_servers.akb.enabled', 'false'],
    ]);
    for (const flag of flags) { const at = flag.indexOf('='); prior.set(flag.slice(0, at), flag.slice(at + 1)); }
    assert.equal(prior.get('mcp_servers.agent-desk-runtime.enabled'), 'true');
    assert.equal(prior.get('mcp_servers.agent-desk-runtime.disabled_tools'), '[]');
    assert.ok(JSON.parse(prior.get('mcp_servers.agent-desk-runtime.enabled_tools')!).includes('desk_reply'));
    assert.equal(prior.get('mcp_servers.akb.enabled'), 'false');
    assert.equal(codex.env.AGENT_DESK_RUNNER_MCP_AUTH === `Bearer ${mcp.token}`, true);
    const claude = claudeMcpOptions(mcp);
    assert.equal(JSON.stringify(claude.mcpServers).includes(mcp.token!), false);
    assert.equal(claude.env?.AGENT_DESK_RUNNER_MCP_AUTH === `Bearer ${mcp.token}`, true);
    assert.equal((claude.mcpServers['agent-desk-runtime'] as any).headers.Authorization,
      '${AGENT_DESK_RUNNER_MCP_AUTH}');
  } finally { f.close(); }
});

test('managed credential reaches only its authenticated workspace MCP route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-managed-route-'));
  const store = new Store(join(dir, 'workspace.db'));
  const hub = new Hub(store, { runner: () => ({ connected: true, id: 'fixture', engines: new Set(),
    has: () => false, handle: () => {} }) });
  const workspace = new SharedWorkspace(hub);
  const server = workspace.server();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const mcp = sharedRunnerMcp(workspace, dir, port);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const post = (headers: Record<string, string>) => fetch(mcp.url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
    });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: `Bearer ${mcp.token}` })).status, 409);
    const reply = await post({ authorization: `Bearer ${mcp.token}`, 'x-workspace-id': mcp.workspaceId! });
    assert.equal(reply.status, 200);
    const result = await reply.json() as { result: { tools: { name: string }[] } };
    assert.equal(result.result.tools.some(tool => tool.name === 'desk_reply'), true);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    hub.dispose(); store.database.close(); rmSync(dir, { recursive: true, force: true });
  }
});
