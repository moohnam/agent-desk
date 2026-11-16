import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { ConnectorVault } from '../../hub/src/connector-vault.ts';
import { Connectors, CONNECTOR_PROVIDERS, type ConnectorService } from '../../hub/src/connectors.ts';
import { Access } from '../../hub/src/access.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { createHttpServer } from '../../hub/src/http.ts';

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
  let repeatedCursor = false;
  let toolError = false;
  let tokenOverride: Record<string, unknown> = {};
  let tokenStatus = 200;
  let v2Issuer = false;
  let confluence = false;
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
    const rpc = JSON.parse(body);
    if (rpc.id == null) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fake-official-service', version: '1' }, capabilities: { tools: {} } };
    else if (rpc.method === 'tools/list') result = { ...(repeatedCursor ? { nextCursor: 'same-cursor' } : {}), tools: [
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
    repeatedCursor: () => { repeatedCursor = true; }, toolError: () => { toolError = true; },
    token: (value: Record<string, unknown>, status = 200) => { tokenOverride = value; tokenStatus = status; },
    v2Issuer: () => { v2Issuer = true; },
    confluence: () => { confluence = true; },
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
