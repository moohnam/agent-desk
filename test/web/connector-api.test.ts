import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorApi, validAuthorizationUrl } from '../../web/src/connectorApi.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const authorization = () => ({ authorization_url: 'https://slack.com/oauth/v2_user/authorize?state=example', expires_at: Date.now() + 60_000 });

test('authorization links only accept official HTTPS login addresses for the selected service', () => {
  assert.ok(validAuthorizationUrl('slack', authorization().authorization_url));
  assert.ok(validAuthorizationUrl('jira', 'https://mcp.atlassian.com/v1/authorize?state=example'));
  assert.ok(validAuthorizationUrl('jira', 'https://auth.atlassian.com/authorize?state=example'));
  for (const url of [
    'http://slack.com/oauth/v2_user/authorize',
    'https://slack.com.evil.example/oauth/v2_user/authorize',
    'https://user:password@slack.com/oauth/v2_user/authorize',
    'https://slack.com:444/oauth/v2_user/authorize',
    'https://slack.com/oauth/v2_user/authorize#token',
    'https://slack.com/other',
    'javascript:alert(1)',
  ]) assert.equal(validAuthorizationUrl('slack', url), false);
  assert.equal(validAuthorizationUrl('jira', authorization().authorization_url), false);
  assert.equal(validAuthorizationUrl('slack', null), false);
});

test('connector calls stay on the local origin and send an empty JSON connect request', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return json(authorization());
  });
  const signal = new AbortController().signal;
  await connectorApi.connect('slack', signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/connectors/slack/connect');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{}');
  assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json');
  assert.equal(calls[0].init.mode, 'same-origin');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.signal, signal);
});

test('an empty successful tool catalog stays distinct from HTTP and malformed-catalog failures', async t => {
  let value: unknown = [], status = 200;
  t.mock.method(globalThis, 'fetch', async () => json(value, status));
  const signal = new AbortController().signal;
  assert.deepEqual(await connectorApi.tools('slack', signal), []);
  value = { error: '인증 만료' }; status = 409;
  await assert.rejects(connectorApi.tools('slack', signal), /인증 만료/);
  status = 200; value = [{ name: 42 }];
  await assert.rejects(connectorApi.tools('slack', signal), /도구 목록 응답/);
});

test('invalid status, expired authorization and unconfirmed deletion never become successful results', async t => {
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => json(value));
  const signal = new AbortController().signal;
  const slack = { service: 'slack', configured: true, status: 'connected', scopes: ['channels:read'] };
  value = [slack, { service: 'jira', configured: true, status: 'disconnected', scopes: [] }];
  assert.equal((await connectorApi.list(signal)).length, 2);
  value = [slack, slack];
  await assert.rejects(connectorApi.list(signal), /연결 상태 응답/);
  value = { ...authorization(), authorization_url: 'https://evil.example/authorize' };
  await assert.rejects(connectorApi.connect('slack', signal), /공식 승인 주소/);
  value = { ...authorization(), expires_at: Date.now() - 1 };
  await assert.rejects(connectorApi.connect('slack', signal), /공식 승인 주소/);
  value = { disconnected: false };
  await assert.rejects(connectorApi.disconnect('slack', signal), /연결 해제 결과/);
});
