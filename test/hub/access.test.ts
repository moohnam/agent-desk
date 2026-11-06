import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Access, deviceName } from '../../hub/src/access.ts';

const fresh = () => new Access(join(mkdtempSync(join(tmpdir(), 'desk-access-')), 'access-token'), 4317);
const req = (ip: string, cookie = '', host = '192.168.0.2:4317') =>
  ({ socket: { remoteAddress: ip }, headers: { host, cookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' } }) as unknown as IncomingMessage;
const cookieHeader = (cookies: string[]) => cookies.map((c) => c.split(';')[0]).join('; ');

test('a device asks, the Mac allows, and the device gets a token of its own once', () => {
  const access = fresh();
  const pc = req('192.168.0.9');
  assert.equal(access.identify(pc), null);
  const made = access.request('', pc)!;
  assert.match(made.code, /^\d{4}$/);
  assert.deepEqual(access.view().requests.map((r) => [r.name, r.ip]), [['Windows Chrome', '192.168.0.9']]);
  assert.equal(access.status(made.id, 'wrong').status, 'expired');
  assert.equal(access.status(made.id, made.secret).status, 'pending');
  assert.ok(access.answer(made.id, true));
  assert.equal(access.view().requests.length, 0);
  const done = access.status(made.id, made.secret);
  assert.equal(done.status, 'allowed');
  assert.equal(access.status(made.id, made.secret).status, 'expired');
  const client = access.identify(req('192.168.0.9', cookieHeader(done.cookies!)));
  assert.equal(client?.kind, 'device');
  // The token is kept hashed on disk.
  const secret = cookieHeader(done.cookies!).match(/desk_device=[^.]+\.([^;]+)/)![1];
  assert.ok(!readFileSync(join(access['devicesFile'] as string), 'utf8').includes(secret));
});

test('a denied request lets nothing in; too many waiting requests are refused', () => {
  const access = fresh();
  const a = access.request('a', req('10.0.0.1'))!;
  access.answer(a.id, false);
  assert.deepEqual(access.status(a.id, a.secret), { status: 'denied' });
  access.request('b', req('10.0.0.2'));
  access.request('c', req('10.0.0.2'));
  assert.equal(access.request('d', req('10.0.0.2')), null);
});

test('removing a device closes its connections and refuses its token', () => {
  const access = fresh();
  const cookie = cookieHeader(access.addDevice('Phone', '10.0.0.3'));
  const device = access.identify(req('10.0.0.3', cookie));
  assert.equal(device?.kind, 'device');
  const id = device!.kind === 'device' ? device!.device.id : '';
  let closed = 0;
  const leave = access.connect(id, '10.0.0.3', () => { closed++; });
  assert.equal(access.view().devices[0].connections, 1);
  assert.ok(access.renameDevice(id, '내 폰'));
  assert.equal(access.view().devices[0].name, '내 폰');
  assert.ok(access.removeDevice(id));
  leave();
  assert.equal(closed, 1);
  assert.equal(access.identify(req('10.0.0.3', cookie)), null);
  assert.equal(access.view().devices.length, 0);
});

test('this Mac needs no token; the shared token still works as a cookie or a bearer', () => {
  const access = fresh();
  assert.deepEqual(access.identify(req('127.0.0.1', '', 'localhost:4317')), { kind: 'local' });
  assert.deepEqual(access.identify(req('10.0.0.4', `desk_token=${access.token}`)), { kind: 'shared', via: 'cookie' });
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'), 'iPhone Safari');
});

test('another device must name this Mac by its own address', () => {
  const access = new Access(join(mkdtempSync(join(tmpdir(), 'desk-access-')), 'access-token'), 4317, undefined, ['mac.tail1234.ts.net']);
  const ip = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address;
  const at = (host: string) => access.hostAllowed(req('10.0.0.5', '', host));
  if (ip) assert.ok(at(`${ip}:4317`));
  assert.ok(at(`${hostname().replace(/\.local$/, '')}.local:4317`));
  assert.ok(at('mac.tail1234.ts.net'));
  assert.equal(at('evil.example:4317'), false);
  if (ip) assert.equal(at(`${ip}:8080`), false);
});

test('a new shared token shuts the old QR link; devices stay', () => {
  const access = fresh();
  const old = access.token;
  const cookie = cookieHeader(access.addDevice('Phone', '10.0.0.6'));
  access.rotateToken();
  assert.notEqual(access.token, old);
  assert.equal(access.matches(old), false);
  assert.equal(access.identify(req('10.0.0.6', cookie))?.kind, 'device');
});

test('a device allowed but never collected goes when its request expires', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const access = fresh();
  const made = access.request('PC', req('10.0.0.7'))!;
  access.answer(made.id, true);
  assert.equal(access.view().devices.length, 1);
  t.mock.timers.tick(11 * 60_000);
  assert.equal(access.view().devices.length, 0);
  assert.equal(access.status(made.id, made.secret).status, 'expired');
});
