import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorVault } from '../../hub/src/connector-vault.ts';
import { ConnectorAuthority } from '../../hub/src/connector-authority.ts';
import { ConnectorBroker } from '../../hub/src/connector-broker.ts';
import { Connectors, CONNECTOR_PROVIDERS, type ConnectorService } from '../../hub/src/connectors.ts';
import { Access } from '../../hub/src/access.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import type { HubToRunner, RunnerToHub } from '../../shared/protocol.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desk-connectors-'));
  const requests: { url: URL; body: string; headers: Headers }[] = [];
  let scope: string | undefined;
  let expires = 3600;
  let foreign = false;
  let failure = false;
  let unauthorized = 0;
  let limited = false;
  let unavailable = false;
  let repeatedCursor = false;
  let toolError = false;
  let tokenOverride: Record<string, unknown> = {};
  let tokenStatus = 200;
  let v2Issuer = false;
  let confluence = false;
  let slackSearch = false;
  let block: Promise<void> | undefined;
  let onCall: (() => void) | undefined;
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const service: ConnectorService = url.hostname.includes('slack') ? 'slack' : 'jira';
    const origin = service === 'jira' ? v2Issuer ? 'https://auth.atlassian.com/test-audience' : 'https://mcp.atlassian.com' : 'https://mcp.slack.com';
    const body = String(init?.body ?? '');
    requests.push({ url, body, headers: new Headers(init?.headers) });
    if (failure) throw new Error('provider accidentally echoed SUPER_SECRET');
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: CONNECTOR_PROVIDERS[service].endpoint.split('?')[0], authorization_servers: [foreign ? 'https://evil.invalid' : origin] });
    if (url.pathname.includes('oauth-authorization-server')) return json({ issuer: origin,
      authorization_endpoint: service === 'jira' ? v2Issuer ? 'https://auth.atlassian.com/authorize' : origin + '/v1/authorize' : 'https://slack.com/oauth/v2_user/authorize',
      token_endpoint: service === 'jira' ? v2Issuer ? 'https://auth.atlassian.com/oauth/token' : origin + '/v1/token' : 'https://slack.com/api/oauth.v2.user.access',
      ...(service === 'jira' ? { registration_endpoint: origin + (v2Issuer ? '/dcr/register' : '/v1/register') } : {}),
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: service === 'jira' ? ['none'] : ['client_secret_post'], code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/v1/register' || url.pathname === '/test-audience/dcr/register') return json({ ...JSON.parse(body), client_id: 'test-client' }, 201);
    if (url.pathname === '/v1/token' || url.pathname === '/oauth/token' || url.pathname === '/api/oauth.v2.user.access') return json({
      access_token: 'test-access-SUPER_SECRET', token_type: 'Bearer', refresh_token: 'test-refresh-SUPER_SECRET',
      expires_in: expires, scope: scope ?? CONNECTOR_PROVIDERS[service].scope, ...tokenOverride,
    }, tokenStatus);
    if (init?.method === 'GET' || init?.method === 'DELETE') return new Response(null, { status: 405 });
    if (unauthorized > 0) { unauthorized--; return json({ error: 'unauthorized' }, 401); }
    if (limited) return json({ error: 'rate limit' }, 429);
    if (unavailable) return json({ error: 'service unavailable' }, 503);
    const rpc = JSON.parse(body);
    if (rpc.id == null) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fake-official-service', version: '1' }, capabilities: { tools: {} } };
    else if (rpc.method === 'tools/list') result = { ...(repeatedCursor ? { nextCursor: 'same-cursor' } : {}), tools: [
      ...(slackSearch ? ['slack_search_public', 'slack_search_public_and_private'].map(name => ({
        name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
      })) : []),
      ...(confluence ? [
        { name: 'searchConfluence', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'getConfluenceContent', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'createConfluenceContent', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'deleteConfluenceContent', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      ] : []),
      { name: service === 'jira' ? 'getJiraIssue' : 'slack_read_thread', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: service === 'jira' ? 'createJiraIssue' : 'slack_send_message', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'executeWrite', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ] };
    else if (rpc.method === 'tools/call') {
      onCall?.(); if (block) await block;
      result = { ...(toolError ? { isError: true } : {}), content: [{ type: 'text', text: 'source: https://example.atlassian.net/browse/TEST-1' }] };
    } else throw Error('unexpected fake request');
    return json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const connectors = new Connectors({ directory: dir, slackClientId: 'slack-client', slackClientSecret: 'slack-client-SUPER_SECRET', fetch: fake });
  const connect = async (service: ConnectorService = 'jira') => {
    const result = await connectors.begin(service, 'http://127.0.0.1:4317');
    const url = new URL(result.authorization_url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), CONNECTOR_PROVIDERS[service].scope);
    await connectors.finish(service, url.searchParams.get('state')!, 'test-code');
    return url;
  };
  return { dir, connectors, connect, requests, fake,
    scope: (value: string) => { scope = value; }, expires: (value: number) => { expires = value; },
    foreign: () => { foreign = true; }, failure: () => { failure = true; },
    unauthorized: (count: number) => { unauthorized = count; }, limited: () => { limited = true; },
    unavailable: () => { unavailable = true; },
    repeatedCursor: () => { repeatedCursor = true; }, toolError: () => { toolError = true; },
    token: (value: Record<string, unknown>, status = 200) => { tokenOverride = value; tokenStatus = status; },
    v2Issuer: () => { v2Issuer = true; },
    confluence: () => { confluence = true; },
    slackSearch: () => { slackSearch = true; },
    block: (wait: Promise<void>, started: () => void) => { block = wait; onCall = started; },
    close: () => { connectors.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('OAuth uses PKCE, encrypts private credentials, survives restart and only exposes allowed read tools', async () => {
  const f = fixture();
  try {
    await f.connect(); await f.connect('slack');
    assert.equal(f.connectors.list().filter(c => c.status === 'connected').length, 2);
    assert.ok(!JSON.stringify(f.connectors.list()).includes('SUPER_SECRET'));
    assert.ok(!readFileSync(join(f.dir, 'credentials.enc')).includes(Buffer.from('SUPER_SECRET')));
    assert.equal(statSync(join(f.dir, 'credentials.enc')).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, 'key')).mode & 0o777, 0o600);
    assert.deepEqual((await f.connectors.tools('jira')).map(t => t.name), ['getJiraIssue']);
    assert.deepEqual((await f.connectors.tools('slack')).map(t => t.name), ['slack_read_thread']);
    const result = await f.connectors.read('jira', 'getJiraIssue', { issueIdOrKey: 'TEST-1' });
    assert.equal(result.service, 'jira'); assert.ok(JSON.stringify(result.result).includes('/browse/TEST-1'));
    const count = f.requests.length;
    assert.throws(() => f.connectors.read('jira', 'executeWrite', {}), /읽기 도구/);
    assert.throws(() => f.connectors.read('slack', 'slack_send_message', {}), /읽기 도구/);
    assert.equal(f.requests.length, count);
    const reopened = new Connectors({ directory: f.dir, fetch: f.fake });
    try { assert.equal(reopened.list().filter(c => c.status === 'connected').length, 2); await reopened.tools('jira'); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('OAuth state is one-shot, provider-bound, expires, and failed reconnect preserves the old account', async t => {
  const f = fixture();
  try {
    const first = await f.connect();
    await assert.rejects(f.connectors.finish('jira', first.searchParams.get('state')!, 'replay'), /일치/);
    const next = new URL((await f.connectors.begin('jira', 'http://127.0.0.1:4317')).authorization_url);
    await assert.rejects(f.connectors.finish('slack', next.searchParams.get('state')!, 'wrong-service'), /일치/);
    await assert.rejects(f.connectors.finish('jira', 'wrong-state', 'bad'), /일치/);
    await assert.rejects(f.connectors.finish('jira', next.searchParams.get('state')!, '', true), /취소/);
    assert.equal(f.connectors.list()[1].status, 'connected');
    const pending = new URL((await f.connectors.begin('jira', 'http://127.0.0.1:4317')).authorization_url);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(10 * 60_000 + 1);
    await assert.rejects(f.connectors.finish('jira', pending.searchParams.get('state')!, 'late'), /만료/);
  } finally { f.close(); }
});

test('expired tokens refresh once before reading without expanding scopes', async () => {
  const f = fixture();
  try {
    f.expires(1); await f.connect(); f.expires(3600);
    await f.connectors.tools('jira'); await f.connectors.tools('jira');
    assert.equal(f.requests.filter(r => r.body.includes('grant_type=refresh_token')).length, 1);
  } finally { f.close(); }
});

test('disconnect prevents in-flight results and persisted credentials from returning', async () => {
  const f = fixture(); let release!: () => void;
  try {
    await f.connect();
    const block = new Promise<void>(r => { release = r; });
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    f.block(block, started);
    const read = f.connectors.read('jira', 'getJiraIssue', {});
    const rejected = assert.rejects(read, /취소|해제/);
    await ready; assert.deepEqual(f.connectors.disconnect('jira'), { disconnected: true, provider_revoked: false });
    release(); await rejected;
    assert.equal(f.connectors.list()[1].status, 'disconnected');
    await assert.rejects(f.connectors.tools('jira'), /먼저/);
    assert.deepEqual(new ConnectorVault(f.dir).read(), {});
  } finally { release?.(); f.close(); }
});

test('untrusted discovery URLs and upstream secrets never escape the connector boundary', async () => {
  const f = fixture();
  try {
    f.foreign();
    await assert.rejects(f.connectors.begin('jira', 'http://127.0.0.1:4317'));
    assert.ok(f.requests.every(r => r.url.hostname !== 'evil.invalid'));
    f.failure();
    await assert.rejects(f.connectors.begin('slack', 'http://127.0.0.1:4317'), error => error instanceof Error && !error.message.includes('SUPER_SECRET'));
    await assert.rejects(f.connectors.begin('jira', 'http://attacker.invalid'), /localhost/);
    assert.ok(f.connectors.list().every(c => c.status === 'disconnected'));
  } finally { f.close(); }
});

test('unexpected OAuth grants and insecure or tampered vault files fail closed', async () => {
  const f = fixture();
  try {
    f.scope('write:jira:agent-interface'); await assert.rejects(f.connect(), /요청하지 않은 권한/);
    assert.equal(f.connectors.list()[1].status, 'disconnected');
    const vault = new ConnectorVault(f.dir); vault.write({ token: 'SECRET' });
    const path = join(f.dir, 'credentials.enc');
    chmodSync(path, 0o644); assert.throws(() => vault.read(), /권한/); chmodSync(path, 0o600);
    const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
    assert.throws(() => vault.read());
  } finally { f.close(); }
});

test('HTTP connector APIs enforce local ownership, cross-origin checks and OAuth callback state', async () => {
  const f = fixture();
  const store = new Store(':memory:');
  const hub = new Hub(store, { skills: new SkillStore(join(f.dir, 'skills')),
    runner: () => ({ connected: false, id: null, engines: new Set(), has: () => false, handle: () => { throw Error('unexpected runner'); } }) });
  const access = new Access(join(f.dir, 'access-token'), 4317, undefined, ['remote.example']);
  const server = createHttpServer(hub, access, join(f.dir, 'uploads'), { connectors: f.connectors });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (path: string, init?: RequestInit) => fetch(origin + '/api/connectors' + path, init);
    const status = await call(''); assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'no-store');
    // fetch normalizes Host; use the HTTP client to exercise an authenticated non-local host.
    const remoteStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin + '/api/connectors', { headers: { host: 'remote.example', authorization: `Bearer ${access.token}` } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    assert.equal(remoteStatus, 403);
    assert.equal((await call('/jira/connect', { method: 'POST', headers: { origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await call('/jira/callback?state=unknown&code=no')).status, 400);
    const started = await call('/jira/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 200);
    const begin = await started.json() as { authorization_url: string; redirect_uri: string };
    assert.equal(begin.redirect_uri, origin + '/api/connectors/jira/callback');
    const state = new URL(begin.authorization_url).searchParams.get('state');
    const callback = await call('/jira/callback?' + new URLSearchParams({ state: state!, code: 'code' }));
    assert.equal(callback.status, 200); assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await callback.text(), /연결했습니다/);
    const tools = await call('/jira/tools'); assert.equal(tools.status, 200);
    const write = await call('/jira/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'createJiraIssue', arguments: {} }) });
    assert.equal(write.status, 403);
    assert.equal((await call('/jira/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'getJiraIssue', arguments: [] }) })).status, 400);
    assert.equal((await call('/jira', { method: 'DELETE' })).status, 200);
    assert.equal((await call('/jira/tools')).status, 409);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    hub.remotes.close(); store.database.close(); f.close();
  }
});

test('Slack app secret files fail safely without leaking invalid JSON or broad permissions', async () => {
  const f = fixture(); const path = join(f.dir, 'slack-app.json');
  const connectors = new Connectors({ directory: join(f.dir, 'other'), slackClientFile: path });
  try {
    writeFileSync(path, '{"client_secret":"SUPER_SECRET"', { mode: 0o600 });
    assert.throws(() => connectors.list(), error => error instanceof Error && !error.message.includes('SUPER_SECRET'));
    writeFileSync(path, JSON.stringify({ client_id: 'id', client_secret: 'SUPER_SECRET' }));
    assert.equal(connectors.list()[0].configured, true);
    chmodSync(path, 0o644); assert.throws(() => connectors.list(), /권한/);
  } finally { connectors.close(); f.close(); }
});

test('401 refresh is bounded; rate limits and MCP error results are not disguised as success', async () => {
  const f = fixture();
  try {
    await f.connect(); f.unauthorized(1);
    await f.connectors.tools('jira');
    assert.equal(f.requests.filter(r => r.body.includes('grant_type=refresh_token')).length, 1);
    f.unauthorized(2); await assert.rejects(f.connectors.tools('jira'), /실패/);
    assert.equal(f.requests.filter(r => r.body.includes('grant_type=refresh_token')).length, 2);
    f.toolError(); const result = await f.connectors.read('jira', 'getJiraIssue', {});
    assert.equal(result.result.isError, true);
    f.limited(); const count = f.requests.length;
    await assert.rejects(f.connectors.tools('jira'), /요청 한도/);
    assert.equal(f.requests.length, count + 1);
  } finally { f.close(); }
});

test('non-refreshable tokens are erased after 401 but survive transient 429 and 503 responses', async () => {
  for (const status of [401, 429, 503]) {
    const f = fixture();
    try {
      f.token({ refresh_token: undefined, expires_in: undefined });
      await f.connect('slack');
      if (status === 401) f.unauthorized(1);
      else if (status === 429) f.limited();
      else f.unavailable();
      await assert.rejects(f.connectors.tools('slack'), error => typeof error === 'object' && error !== null
        && 'status' in error && error.status === (status === 401 ? 409 : status === 429 ? 429 : 502));
      const saved = new ConnectorVault<Record<string, any>>(f.dir).read()!;
      if (status === 401) {
        assert.equal(f.connectors.list()[0].status, 'disconnected');
        assert.equal(saved.slack.tokens, undefined);
        const count = f.requests.length;
        await assert.rejects(f.connectors.tools('slack'), /먼저/);
        assert.equal(f.requests.length, count);
      } else {
        assert.equal(f.connectors.list()[0].status, 'connected');
        assert.equal(saved.slack.tokens.access_token, 'test-access-SUPER_SECRET');
      }
    } finally { f.close(); }
  }
});

test('incomplete catalogs fail instead of silently omitting pages; a lost key is never regenerated over ciphertext', async () => {
  const f = fixture();
  try {
    await f.connect(); f.repeatedCursor();
    await assert.rejects(f.connectors.tools('jira'), /끝까지/);
    const original = readFileSync(join(f.dir, 'credentials.enc'));
    unlinkSync(join(f.dir, 'key'));
    assert.throws(() => new ConnectorVault(f.dir).write({}), /ENOENT/);
    assert.deepEqual(readFileSync(join(f.dir, 'credentials.enc')), original);
  } finally { f.close(); }
});

test('Slack nested comma-separated user scopes are checked before SDK parsing, including accumulated grants', async () => {
  const f = fixture();
  try {
    f.token({ ok: true, token_type: 'user', scope: undefined, authed_user: { id: 'U1', scope: 'channels:history,groups:history' } });
    await f.connect('slack');
    const saved = new ConnectorVault<Record<string, any>>(f.dir).read()!;
    assert.equal(saved.slack.tokens.scope, 'channels:history groups:history');
    f.token({ ok: true, authed_user: { id: 'U1', scope: 'im:history,chat:write' } });
    await assert.rejects(f.connect('slack'), /요청하지 않은 권한/);
    assert.equal(f.connectors.list()[0].status, 'connected');
    f.token({ ok: false, error: 'invalid_code SUPER_SECRET' });
    await assert.rejects(f.connect('slack'), error => error instanceof Error && !error.message.includes('SUPER_SECRET'));
  } finally { f.close(); }
});

test('initial grants require scopes while refresh responses may retain previously checked scopes', async () => {
  const f = fixture();
  try {
    f.token({ scope: undefined }); await assert.rejects(f.connect(), /권한을 확인하지/);
    f.token({}); f.expires(1); await f.connect();
    f.token({ scope: undefined }); f.expires(3600); await f.connectors.tools('jira');
    const saved = new ConnectorVault<Record<string, any>>(f.dir).read()!;
    assert.equal(saved.jira.tokens.scope, CONNECTOR_PROVIDERS.jira.scope);
  } finally { f.close(); }
});

test('refresh rate limits remain 429 without erasing the account; invalid grants require reconnect', async () => {
  const f = fixture();
  try {
    f.expires(1); await f.connect();
    f.token({}, 429);
    await assert.rejects(f.connectors.tools('jira'), error => typeof error === 'object' && error !== null && 'status' in error && error.status === 429);
    assert.equal(f.connectors.list()[1].status, 'connected');
    f.token({ error: 'invalid_grant', error_description: 'SUPER_SECRET' }, 400);
    await assert.rejects(f.connectors.tools('jira'), /다시 연결/);
    assert.equal(f.connectors.list()[1].status, 'disconnected');
  } finally { f.close(); }
});

test('oversized OAuth credentials never replace the readable vault or erase another service', async () => {
  const f = fixture();
  try {
    await f.connect('slack'); const original = readFileSync(join(f.dir, 'credentials.enc'));
    f.token({ access_token: 'x'.repeat(1024 * 1024) });
    await assert.rejects(f.connect('jira'), /저장에 실패/);
    assert.deepEqual(readFileSync(join(f.dir, 'credentials.enc')), original);
    const reopened = new Connectors({ directory: f.dir, fetch: f.fake });
    try { assert.equal(reopened.list()[0].status, 'connected'); assert.equal(reopened.list()[1].status, 'disconnected'); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('a failed refresh persistence blocks cached credentials until the hub is repaired and restarted', async t => {
  const f = fixture();
  try {
    f.expires(1); await f.connect(); const original = readFileSync(join(f.dir, 'credentials.enc'));
    t.mock.method(ConnectorVault.prototype, 'write', () => { throw Error('disk failure'); });
    f.token({ access_token: 'rotated-token', refresh_token: 'rotated-refresh' }); f.expires(3600);
    await assert.rejects(f.connectors.tools('jira'), /저장에 실패/);
    const count = f.requests.length;
    await assert.rejects(f.connectors.tools('jira'), /저장에 실패/);
    assert.equal(f.requests.length, count);
    assert.throws(() => f.connectors.list(), /저장에 실패/);
    assert.deepEqual(readFileSync(join(f.dir, 'credentials.enc')), original);
  } finally { f.close(); }
});

test('Slack HTTP 200 error envelopes distinguish transient failures from revoked refresh credentials', async () => {
  const f = fixture();
  try {
    f.expires(1); await f.connect('slack');
    for (const [code, expected] of [['ratelimited', 429], ['service_unavailable', 502]] as const) {
      f.token({ ok: false, error: code });
      await assert.rejects(f.connectors.tools('slack'), error => typeof error === 'object' && error !== null && 'status' in error && error.status === expected);
      assert.equal(f.connectors.list()[0].status, 'connected');
    }
    f.token({ ok: false, error: 'invalid_refresh_token' });
    await assert.rejects(f.connectors.tools('slack'), /다시 연결/);
    assert.equal(f.connectors.list()[0].status, 'disconnected');
    const count = f.requests.length;
    await assert.rejects(f.connectors.tools('slack'), /먼저/);
    assert.equal(f.requests.length, count);
    f.token({}); await f.connect('slack');
    f.token({ error: 'unauthorized_client' }, 400);
    await assert.rejects(f.connectors.tools('slack'), /다시 연결/);
    assert.equal(f.connectors.list()[0].status, 'disconnected');
  } finally { f.close(); }
});

test('Atlassian v2 resource metadata supports its separate issuer, registration and token endpoints', async () => {
  const f = fixture();
  try {
    f.v2Issuer(); f.expires(1); const url = await f.connect();
    assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
    f.expires(3600); await f.connectors.tools('jira');
    assert.equal(f.requests.filter(r => r.url.pathname === '/test-audience/dcr/register').length, 1);
    assert.equal(f.requests.filter(r => r.url.pathname === '/oauth/token').length, 2);
  } finally { f.close(); }
});

test('Atlassian includes Confluence read/search scopes and tools but refuses writes, deletes and Slack access', async () => {
  const f = fixture();
  try {
    f.confluence(); const url = await f.connect();
    const scopes = url.searchParams.get('scope')!.split(' ');
    assert.ok(scopes.includes('read:confluence:agent-interface'));
    assert.ok(scopes.includes('search:confluence:agent-interface'));
    assert.ok(scopes.includes('read:me')); assert.ok(scopes.includes('read:account'));
    const registration = JSON.parse(f.requests.find(r => r.url.pathname === '/v1/register')!.body);
    assert.equal(registration.scope, url.searchParams.get('scope'));
    assert.deepEqual(registration.grant_types, ['authorization_code', 'refresh_token']);
    assert.ok(scopes.every(scope => !/^(write|delete|manage):/.test(scope)));
    assert.deepEqual((await f.connectors.tools('jira')).map(tool => tool.name), ['searchConfluence', 'getConfluenceContent', 'getJiraIssue']);
    await f.connectors.read('jira', 'searchConfluence', { cloudId: 'test-site', cql: 'type=page' });
    await f.connectors.read('jira', 'getConfluenceContent', { cloudId: 'test-site', id: 'test-page' });
    const count = f.requests.length;
    for (const name of ['createConfluenceContent', 'deleteConfluenceContent', 'executeWrite', 'executeDestructive'])
      assert.throws(() => f.connectors.read('jira', name, {}), /읽기 도구/);
    assert.throws(() => f.connectors.read('slack', 'getConfluenceContent', {}), /읽기 도구/);
    assert.equal(f.requests.length, count);
  } finally { f.close(); }
});

test('a client registered for an older scope set is not reused for expanded consent', async () => {
  const f = fixture();
  try {
    await f.connect();
    const vault = new ConnectorVault<Record<string, any>>(f.dir), saved = vault.read()!;
    saved.jira.registeredScope = 'read:jira:agent-interface'; vault.write(saved);
    const reopened = new Connectors({ directory: f.dir, fetch: f.fake });
    try {
      const before = f.requests.filter(r => r.url.pathname === '/v1/register').length;
      await reopened.begin('jira', 'http://127.0.0.1:4317');
      assert.equal(f.requests.filter(r => r.url.pathname === '/v1/register').length, before + 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('repeated consent with unchanged scopes preserves registration metadata and reuses the client', async () => {
  const f = fixture();
  try {
    await f.connect(); await f.connect(); await f.connect();
    assert.equal(f.requests.filter(r => r.url.pathname === '/v1/register').length, 1);
    assert.equal(new ConnectorVault<Record<string, any>>(f.dir).read()!.jira.registeredScope, CONNECTOR_PROVIDERS.jira.scope);
  } finally { f.close(); }
});

test('request grants bind once and deliver real MCP reads with schemas and idempotent results', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  const authority = new ConnectorAuthority(db, f.connectors);
  try {
    await f.connect();
    const grant = authority.issue({ workspaceId: 'workspace-A', requestId: 'input-A' });
    const context = { capability: grant.capability, workspaceId: grant.workspaceId, requestId: grant.requestId, taskId: 'task-A', sessionId: 'session-A' };
    assert.throws(() => authority.list(context), /아직 결합/);
    authority.bind(context);
    assert.throws(() => authority.bind({ ...context, taskId: 'other-task' }), /문맥/);
    assert.throws(() => authority.list({ ...context, workspaceId: 'workspace-B' }), /문맥/);
    assert.throws(() => authority.list({ ...context, requestId: 'input-B' }), /문맥/);
    assert.throws(() => authority.list({ ...context, sessionId: 'session-B' }), /문맥/);
    assert.deepEqual(authority.list(context).connections.map(c => c.service), ['jira']);
    assert.deepEqual((await authority.tools({ ...context, service: 'jira' }))[0].inputSchema, { type: 'object' });
    const input = { ...context, callId: 'call-A', service: 'jira' as const, tool: 'getJiraIssue', arguments: { issue: 'TEST-1', nested: { b: 2, a: 1 } } };
    const result = await authority.call(input);
    assert.ok(JSON.stringify(result.result).includes('/browse/TEST-1'));
    assert.ok(result.retrieved_at);
    const count = f.requests.length;
    assert.deepEqual(await authority.call({ ...input, arguments: { nested: { a: 1, b: 2 }, issue: 'TEST-1' } }), result);
    const reopened = new ConnectorAuthority(db, f.connectors);
    assert.equal(reopened.hubId, authority.hubId);
    assert.deepEqual(await reopened.call(input), result);
    await assert.rejects(authority.call({ ...input, arguments: { issue: 'TEST-2' } }), /내용/);
    await assert.rejects(authority.call({ ...input, callId: 'write', tool: 'createJiraIssue' }), /읽기 도구/);
    assert.equal(f.requests.length, count);
    const stored = JSON.stringify(db.prepare('SELECT * FROM connector_grant').all());
    assert.ok(!stored.includes(grant.capability));
    assert.ok(!stored.includes('SUPER_SECRET'));
    reopened.close();
  } finally { authority.close(); db.close(); f.close(); }
});

test('connector account generations survive refresh and restart but invalidate grants after reconnect or disconnect', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  const authority = new ConnectorAuthority(db, f.connectors);
  try {
    f.expires(1); await f.connect();
    const generation = f.connectors.connections()[0].generation;
    const grant = authority.issue({ workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session' });
    const context = { capability: grant.capability, workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session' };
    f.expires(3600); await authority.tools({ ...context, service: 'jira' });
    assert.equal(f.connectors.connections()[0].generation, generation);
    const reopened = new Connectors({ directory: f.dir, fetch: f.fake });
    assert.equal(reopened.connections()[0].generation, generation); reopened.close();
    await f.connect();
    assert.notEqual(f.connectors.connections()[0].generation, generation);
    await assert.rejects(authority.tools({ ...context, service: 'jira' }), /교체·해제/);
    const next = authority.issue({ workspaceId: 'workspace', requestId: 'next', taskId: 'task', sessionId: 'session' });
    f.connectors.disconnect('jira');
    await assert.rejects(authority.tools({ ...context, capability: next.capability, requestId: 'next', service: 'jira' }), /교체·해제/);
  } finally { authority.close(); db.close(); f.close(); }
});

test('duplicate concurrent reads run once and revocation suppresses in-flight and cached results', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  const authority = new ConnectorAuthority(db, f.connectors);
  let release!: () => void;
  try {
    await f.connect();
    const grant = authority.issue({ workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session' });
    const context = { capability: grant.capability, workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session' };
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    f.block(new Promise<void>(resolve => { release = resolve; }), started);
    const input = { ...context, callId: 'call', service: 'jira' as const, tool: 'getJiraIssue', arguments: {} };
    const first = authority.call(input);
    await ready;
    const duplicate = authority.call(input);
    release();
    assert.deepEqual(await first, await duplicate);
    assert.equal(f.requests.filter(request => request.body.includes('"method":"tools/call"')).length, 1);
    authority.revoke(grant.capability);
    await assert.rejects(authority.call(input), /만료|문맥/);

    const next = authority.issue({ workspaceId: 'workspace', requestId: 'next', taskId: 'task', sessionId: 'session' });
    const nextReady = new Promise<void>(resolve => { started = resolve; });
    f.block(new Promise<void>(resolve => { release = resolve; }), started);
    const pending = authority.call({ ...input, capability: next.capability, requestId: 'next' });
    const rejected = assert.rejects(pending, /만료|문맥/);
    await nextReady;
    authority.revokeWorkspace('workspace');
    release(); await rejected;
  } finally { release?.(); authority.close(); db.close(); f.close(); }
});

test('idle authority sweeps expired grant results without another user input and stops before DB close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const db = new DatabaseSync(':memory:'); let now = 1000;
  const connectors = { connections: () => [{ service: 'jira', generation: 'fixture-account' }],
    read: async () => ({ result: 'private fixture only' }) } as unknown as Connectors;
  const authority = new ConnectorAuthority(db, connectors, { now: () => now });
  try {
    const grant = authority.issue({ workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session', ttlMs: 100 });
    await authority.call({ capability: grant.capability, workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session',
      callId: 'call', service: 'jira', tool: 'getJiraIssue', arguments: {} });
    assert.equal((db.prepare('SELECT count(*) n FROM connector_call').get() as { n: number }).n, 1);
    now = 1100; t.mock.timers.tick(60_000);
    assert.equal((db.prepare('SELECT count(*) n FROM connector_call').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM connector_grant').get() as { n: number }).n, 0);
  } finally { authority.close(); db.close(); assert.doesNotThrow(() => t.mock.timers.tick(60_000)); }
});

test('authority shutdown suppresses late provider results after its database is closed', async () => {
  const db = new DatabaseSync(':memory:'); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const connectors = { connections: () => [{ service: 'jira', generation: 'fixture-account' }],
    read: async () => { await blocked; return { result: 'must not escape' }; } } as unknown as Connectors;
  const authority = new ConnectorAuthority(db, connectors);
  const grant = authority.issue({ workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session' });
  const call = authority.call({ capability: grant.capability, workspaceId: 'workspace', requestId: 'input', taskId: 'task', sessionId: 'session',
    callId: 'call', service: 'jira', tool: 'getJiraIssue', arguments: {} });
  const rejected = assert.rejects(call, /권한 처리가 종료/);
  authority.close(); db.close(); release(); await rejected;
});

test('connector grants enforce expiry, call size limits and remain empty when issued before login', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  let now = 1000;
  const authority = new ConnectorAuthority(db, f.connectors, { now: () => now });
  try {
    const empty = authority.issue({ workspaceId: 'workspace', requestId: 'before', taskId: 'task', sessionId: 'session' });
    await f.connect();
    const context = { capability: empty.capability, workspaceId: 'workspace', requestId: 'before', taskId: 'task', sessionId: 'session' };
    assert.deepEqual(authority.list(context).connections, []);
    const grant = authority.issue({ workspaceId: 'workspace', requestId: 'after', taskId: 'task', sessionId: 'session', ttlMs: 100 });
    const input = { ...context, capability: grant.capability, requestId: 'after', callId: 'call', service: 'jira' as const, tool: 'getJiraIssue', arguments: { value: 'x'.repeat(65 * 1024) } };
    const count = f.requests.length;
    await assert.rejects(authority.call(input), /인자가 너무/);
    now += 100;
    await assert.rejects(authority.call({ ...input, arguments: {} }), /만료/);
    assert.equal(f.requests.length, count);
  } finally { authority.close(); db.close(); f.close(); }
});

test('session MCP mailbox reaches the owning gateway grant and real provider read without forwarding OAuth', async () => {
  const f = fixture(), ownerDb = new DatabaseSync(':memory:'), workspaceDb = new DatabaseSync(':memory:');
  workspaceDb.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,task_id TEXT,status TEXT);
    INSERT INTO session VALUES ('session','task','running');
    CREATE TABLE workspace_peer(id TEXT PRIMARY KEY,revoked INTEGER); INSERT INTO workspace_peer VALUES ('owner-peer',0);`);
  const authority = new ConnectorAuthority(ownerDb, f.connectors), broker = new ConnectorBroker(workspaceDb, 'workspace');
  try {
    await f.connect();
    const grant = authority.issue({ workspaceId: 'workspace', requestId: 'request' });
    const token = broker.open('session', 'task', { ...grant, sourcePeerId: 'owner-peer' });
    const pending = broker.invoke(token, 'read', { service: 'jira', tool: 'getJiraIssue', arguments: { issueIdOrKey: 'TEST-1' } });
    const [job] = broker.poll('owner-peer');
    authority.bind(job.context);
    const result = await authority.call({ ...job.context, callId: job.callId, service: 'jira', tool: 'getJiraIssue', arguments: job.args.arguments as Record<string, unknown> });
    broker.complete('owner-peer', job.callId, { result });
    broker.ack('owner-peer', [job.callId]);
    assert.deepEqual(await pending, result);
    assert.ok(JSON.stringify(result).includes('/browse/TEST-1'));
    const transferred = JSON.stringify({ grant, job, runtime: workspaceDb.prepare('SELECT * FROM connector_runtime').all(), jobs: workspaceDb.prepare('SELECT * FROM connector_job').all() });
    assert.ok(!transferred.includes('SUPER_SECRET'));
    assert.ok(!transferred.includes(token));
  } finally { broker.close(); authority.close(); workspaceDb.close(); ownerDb.close(); f.close(); }
});

test('HTTP connector bridge binds gateway input to session MCP and returns a provider read through peer polling', async () => {
  const f = fixture(), workspaceStore = new Store(':memory:'), gatewayStore = new Store(':memory:');
  const commands: HubToRunner[] = [];
  let say!: (message: RunnerToHub) => void;
  const canonical = new Hub(workspaceStore, { skills: new SkillStore(join(f.dir, 'workspace-skills')),
    runner: emit => { say=emit; return { connected: true, id: 'local-test', engines: new Set(['claude']), connectorMcpSupported: true, has: () => false, handle: command => { commands.push(command); } }; } });
  const workspace = new SharedWorkspace(canonical, undefined, { localAuthority: true });
  const remote = workspace.server();
  const gateway = new Hub(gatewayStore, { skills: new SkillStore(join(f.dir, 'gateway-skills')),
    runner: () => ({ connected: false, id: null, engines: new Set(), has: () => false, handle: () => { throw Error('unexpected gateway execution'); } }) });
  const links = new WorkspaceLinks(gatewayStore);
  const server = createHttpServer(gateway, new Access(join(f.dir, 'bridge-access'), 4317), join(f.dir, 'uploads'), { workspaces: links, connectors: f.connectors });
  const listen = (server: Server) => new Promise<string>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  try {
    await f.connect();
    const remoteUrl = await listen(remote), gatewayUrl = await listen(server);
    const owner = workspace.grant('gateway'), other = workspace.grant('other-gateway');
    const link = await links.attach({ name: 'workspace', url: remoteUrl, token: owner.token });
    const project = canonical.createProject('connector', f.dir);
    const submitted = await fetch(`${gatewayUrl}/api/workspaces/${link.id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: project.id, prompt: '#claude #jira read TEST-1' }) });
    assert.equal(submitted.status, 201, JSON.stringify(await submitted.clone().json()));
    const command = commands.find((command): command is Extract<HubToRunner, { type: 'start' }> => command.type === 'start');
    assert.ok(command?.connectorMcp);
    assert.equal(command.connectorMcp.url, remoteUrl + '/v1/connector-mcp');
    const rpc = (token: string, name: string, args: Record<string, unknown>) => fetch(command.connectorMcp!.url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal((await rpc(owner.token, 'desk_connector_list', {})).status, 403);
    const pending = rpc(command.connectorMcp.token, 'desk_connector_read', { request_id:workspace.connectorBroker!.stored(command.sessionId)!.requestId, service: 'jira', tool: 'getJiraIssue', arguments: { issueIdOrKey: 'TEST-1' } });
    const end = Date.now() + 2000;
    while (!workspace.connectorBroker!.busy(command.sessionId) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(workspace.connectorBroker!.busy(command.sessionId), true);
    const foreign = await fetch(remoteUrl + '/v1/connectors/poll', { headers: { authorization: `Bearer ${other.token}`, 'x-workspace-id': workspace.id } });
    assert.deepEqual(await foreign.json(), []);
    await links.pollConnectors(link.id);
    const result = await (await pending).json() as { result: { content: { text: string }[]; isError?: boolean } };
    assert.notEqual(result.result.isError, true, JSON.stringify(result));
    assert.match(result.result.content[0].text, /TEST-1/);
    assert.ok(!JSON.stringify(command).includes('SUPER_SECRET'));
    assert.ok(!JSON.stringify(await submitted.json()).includes('capability'));
    say({type:'approval_request',sessionId:command.sessionId,approvalId:'bridge-question',toolName:'AskUserQuestion',input:{questions:[{question:'조회 대상'}]}});
    const foreignAnswer=await fetch(remoteUrl+'/v1/operation',{method:'POST',headers:{authorization:`Bearer ${other.token}`,'x-workspace-id':workspace.id,'content-type':'application/json'},
      body:JSON.stringify({id:randomUUID(),method:'POST',path:'/approvals/bridge-question',body:{allow:true,answers:{'조회 대상':'PRIVATE-123'}}})});
    assert.equal(foreignAnswer.status,409);
    assert.equal(workspaceStore.getApproval('bridge-question')?.status,'pending');
    const answer=await fetch(`${gatewayUrl}/api/workspaces/${link.id}/approvals/bridge-question`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allow:true,answers:{'조회 대상':'TEST-1'}})});
    assert.equal(answer.status,200,JSON.stringify(await answer.json()));
    assert.equal(workspaceStore.getApproval('bridge-question')?.status,'allowed');
    say({type:'approval_request',sessionId:command.sessionId,approvalId:'bridge-old-account',toolName:'Bash',input:{command:'read'}});
    await f.connect();
    const changedAccount=await fetch(`${gatewayUrl}/api/workspaces/${link.id}/approvals/bridge-old-account`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allow:false,message:'다른 계정의 입력'})});
    assert.equal(changedAccount.status,409);
    assert.equal(workspaceStore.getApproval('bridge-old-account')?.status,'pending');
  } finally {
    await links.close(); await stop(server); await stop(remote);
    canonical.dispose(); gateway.dispose(); workspaceStore.database.close(); gatewayStore.database.close(); f.close();
  }
});

test('HTTP connector direct hub uses the same request authority and session MCP without a workspace gateway', async () => {
  const f = fixture(), store = new Store(':memory:'), commands: HubToRunner[] = [];
  let say!: (message: RunnerToHub) => void;
  const hub = new Hub(store, { skills: new SkillStore(join(f.dir, 'direct-skills')),
    runner: emit => { say=emit; return { connected: true, id: 'direct-local', engines: new Set(['claude']), connectorMcpSupported: true, has: () => false, handle: command => { commands.push(command); } }; } });
  const links = new WorkspaceLinks(store);
  const server = createHttpServer(hub, new Access(join(f.dir, 'direct-access'), 4317), join(f.dir, 'uploads'), { workspaces: links, connectors: f.connectors });
  try {
    await f.connect();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const project = hub.createProject('direct', f.dir);
    const invalid = await fetch(origin + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: 'missing', prompt: '#claude invalid' }) });
    assert.equal(invalid.status, 404);
    assert.equal((store.database.prepare('SELECT count(*) n FROM connector_grant').get() as { n: number }).n, 0);
    const submitted = await fetch(origin + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: project.id, prompt: '#claude #jira read issue' }) });
    assert.equal(submitted.status, 201, JSON.stringify(await submitted.json()));
    const command = commands.find((command): command is Extract<HubToRunner, { type: 'start' }> => command.type === 'start');
    assert.ok(command?.connectorMcp); assert.equal(command.connectorMcp.url, origin + '/v1/connector-mcp');
    const response = await fetch(command.connectorMcp.url, { method: 'POST', headers: { authorization: `Bearer ${command.connectorMcp.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_connector_read', arguments: { request_id:hub.connectorBroker!.stored(command.sessionId)!.requestId, service: 'jira', tool: 'getJiraIssue', arguments: { issueIdOrKey: 'TEST-1' } } } }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { result: { content: { text: string }[]; isError?: boolean } };
    assert.notEqual(result.result.isError, true, JSON.stringify(result));
    assert.match(result.result.content[0].text, /TEST-1/);
    assert.equal((store.database.prepare('SELECT count(*) n FROM connector_local_source').get() as { n: number }).n, 1);
    say({type:'approval_request',sessionId:command.sessionId,approvalId:'direct-question',toolName:'AskUserQuestion',input:{questions:[{question:'조회 대상'}]}});
    const answer=await fetch(origin+'/api/approvals/direct-question',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allow:true,answers:{'조회 대상':'TEST-1'}})});
    assert.equal(answer.status,200,JSON.stringify(await answer.json()));
    assert.equal(store.getApproval('direct-question')?.status,'allowed');
    say({type:'approval_request',sessionId:command.sessionId,approvalId:'direct-old-account',toolName:'Bash',input:{command:'read'}});
    await f.connect();
    const changedAccount=await fetch(origin+'/api/approvals/direct-old-account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allow:false,message:'다른 계정의 입력'})});
    assert.equal(changedAccount.status,409);
    assert.equal(store.getApproval('direct-old-account')?.status,'pending');
  } finally {
    await links.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    hub.dispose(); store.database.close(); f.close();
  }
});

test('HTTP connector grants recheck runner capability after a same-workspace downgrade', async () => {
  const f = fixture(), store = new Store(':memory:'), links = new WorkspaceLinks(store);
  const authority = new ConnectorAuthority(store.database, f.connectors); links.connectorAuthority = authority;
  let supported = true, submitted = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/identity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, workspace_id: 'stable-workspace', capabilities: { connectors: supported ? 1 : undefined, connector_tags: supported ? 1 : undefined } }));
    } else if (req.url === '/v1/operation') {
      for await (const _ of req) { /* Drain the operation without interpreting private fields. */ }
      submitted++;
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"accepted":true}');
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); }
  });
  try {
    await f.connect();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const link = await links.attach({ name: 'runner', url, token: 'a'.repeat(43) });
    links.enqueue(link.id, { id: randomUUID(), method: 'POST', path: '/tasks/example/messages', body: { text: '#jira first read' } });
    assert.equal((store.database.prepare('SELECT count(*) n FROM connector_grant').get() as {n:number}).n,0);
    await links.flush(link.id); assert.equal(submitted, 1);
    supported = false;
    const next = randomUUID();
    links.enqueue(link.id, { id: next, method: 'POST', path: '/tasks/example/messages', body: { text: '#jira second read' } });
    await links.flush(link.id);
    assert.equal(submitted, 1);
    assert.equal(links.deliveries(link.id).find(delivery => delivery.id === next)!.status, 409);
    assert.match(links.deliveries(link.id).find(delivery => delivery.id === next)!.error, /요청별 외부 연결/);
    // Untagged ordinary input needs neither a grant nor the new remote capability.
    links.enqueue(link.id,{id:randomUUID(),method:'POST',path:'/tasks/example/messages',body:{text:'일반 대화'}});
    await links.flush(link.id);assert.equal(submitted,2);
    supported=true;
    const changed=randomUUID();
    links.enqueue(link.id,{id:changed,method:'POST',path:'/tasks/example/messages',body:{text:'#jira 계정 고정'}});
    await f.connect();
    await links.flush(link.id);assert.equal(submitted,2);
    assert.equal(links.deliveries(link.id).find(delivery=>delivery.id===changed)!.status,409);
    assert.match(links.deliveries(link.id).find(delivery=>delivery.id===changed)!.error,/계정이나 권한이 바뀌/);
  } finally {
    await links.close(); authority.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.database.close(); f.close();
  }
});

test('service tags split Jira and Confluence tools and start the short TTL only when bound',async()=>{
  const f=fixture(),db=new DatabaseSync(':memory:');let now=Date.now();
  const authority=new ConnectorAuthority(db,f.connectors,{now:()=>now});
  try {
    await f.connect();await f.connect('slack');
    const selection=authority.select(['confluence']);
    assert.equal(selection[0].service,'jira');
    assert.ok(selection[0].tools.includes('getConfluenceContent'));
    assert.ok(!selection[0].tools.includes('getJiraIssue'));
    const jira=authority.select(['jira']);
    assert.ok(jira[0].tools.includes('getJiraIssue'));
    assert.ok(!jira[0].tools.includes('getConfluenceContent'));
    assert.deepEqual(authority.select(['slack']).map(c=>c.service),['slack']);
    const grant=authority.issue({workspaceId:'workspace',requestId:'waiting',scopes:['confluence'],expectedPolicy:selection});
    const context={capability:grant.capability,workspaceId:'workspace',requestId:'waiting',taskId:'task',sessionId:'session'};
    now+=20*60_000;authority.bind(context);
    await assert.rejects(authority.call({...context,callId:'wrong-service',service:'jira',tool:'getJiraIssue',arguments:{}}),/읽기 도구/);
    now+=14*60_000;authority.bind(context);assert.equal(authority.list(context).connections.length,1);
    now+=2*60_000;assert.throws(()=>authority.list(context),/만료/);
  }finally{authority.close();db.close();f.close();}
});

test('outbox retries freeze scoped grants and legacy recovery checks receipts before stripping authority',async()=>{
  const f=fixture(),store=new Store(':memory:'),links=new WorkspaceLinks(store);
  const authority=new ConnectorAuthority(store.database,f.connectors);links.connectorAuthority=authority;
  const received:string[]=[],receipts=new Map<string,unknown>();let fail=false;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/identity')return res.end(JSON.stringify({version:1,workspace_id:'stable-workspace',capabilities:{connectors:1,connector_tags:1}}));
    if(req.url?.startsWith('/v1/receipts/')) {
      const prior=receipts.get(req.url.slice('/v1/receipts/'.length));res.statusCode=prior?200:404;return res.end(JSON.stringify(prior??{}));
    }
    if(req.url==='/v1/operation') {
      let body='';for await(const chunk of req)body+=chunk;received.push(body);
      res.statusCode=fail?503:201;return res.end(JSON.stringify({accepted:true}));
    }
    res.end('[]');
  });
  try {
    await f.connect();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const link=await links.attach({name:'runner',url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:'a'.repeat(43)});
    const scoped=randomUUID();links.enqueue(link.id,{id:scoped,method:'POST',path:'/tasks/t/messages',body:{text:'#jira 조회'}});
    fail=true;await links.flush(link.id);fail=false;await links.flush(link.id);
    assert.equal(received.length,2);assert.equal(received[0],received[1]);
    const scopes=JSON.parse(received[0]).body;
    assert.equal(scopes.__desk_connector_selection,undefined);assert.equal(scopes.__desk_connector_grant.inputScoped,true);
    for(const recoveredStatus of [201,409]) {
    const expiredId=randomUUID();links.enqueue(link.id,{id:expiredId,method:'POST',path:'/tasks/t/messages',body:{text:'#jira 조회'}});
    fail=true;await links.flush(link.id);fail=false;
    const expired=JSON.parse((store.database.prepare('SELECT payload FROM workspace_delivery WHERE id=?').get(expiredId) as {payload:string}).payload);
    expired.body.__desk_connector_grant.expiresAt=Date.now()-1;
    store.database.prepare('UPDATE workspace_delivery SET payload=? WHERE id=?').run(JSON.stringify(expired),expiredId);
    receipts.set(expiredId,{status:recoveredStatus,body:{accepted:recoveredStatus===201}});
    const sentBefore:number=received.length;await links.flush(link.id);
    assert.equal(received.length,sentBefore);
    assert.equal((store.database.prepare('SELECT status FROM workspace_delivery WHERE id=?').get(expiredId) as {status:number}).status,recoveredStatus);
    if(recoveredStatus===409)assert.equal(links.deliveries(link.id).find(row=>row.id===expiredId)?.text,'#jira 조회');
    }
    for(const committed of [0,201,409]) {
      const id=randomUUID();links.enqueue(link.id,{id,method:'POST',path:'/tasks/t/messages',body:{text:'일반 대화'}});
      const row=store.database.prepare('SELECT payload FROM workspace_delivery WHERE id=?').get(id) as {payload:string};
      const old=JSON.parse(row.payload);old.body.__desk_connector_grant=authority.issue({workspaceId:'stable-workspace',requestId:id});
      store.database.prepare('UPDATE workspace_delivery SET payload=? WHERE id=?').run(JSON.stringify(old),id);
      if(committed)receipts.set(id,{status:committed,body:{accepted:committed===201}});
      const before:number=received.length;await links.flush(link.id);
      assert.equal(received.length,before+(committed?0:1));
      if(!committed)assert.equal(JSON.parse(received.at(-1)!).body.__desk_connector_grant,undefined);
      assert.equal((store.database.prepare('SELECT status FROM workspace_delivery WHERE id=?').get(id) as {status:number}).status,committed||201);
      if(committed===409)assert.equal(links.deliveries(link.id).find(row=>row.id===id)?.text,'일반 대화');
    }
  }finally{await links.close();authority.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.database.close();f.close();}
});

test('current Slack message search tools are exposed and callable while writes remain blocked', async () => {
  const f = fixture();
  try {
    f.slackSearch();
    await f.connect('slack');
    const names = (await f.connectors.tools('slack')).map(tool => tool.name);
    for (const name of ['slack_search_public', 'slack_search_public_and_private']) {
      assert.ok(names.includes(name));
      const result = await f.connectors.read('slack', name, { keywords: ['fixture'], limit: 1 });
      assert.equal(result.tool, name);
      assert.ok(f.requests.some(request => {
        try { const body = JSON.parse(request.body); return body.method === 'tools/call' && body.params.name === name; }
        catch { return false; }
      }));
    }
    assert.ok(!names.includes('slack_send_message'));
    assert.throws(() => f.connectors.read('slack', 'slack_send_message', {}), /읽기 도구/);
  } finally { f.close(); }
});
