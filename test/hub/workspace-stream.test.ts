import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../hub/src/db.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';

const wait = async (check: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
test('upstream stream authenticates, rotates credentials, and releases requests on abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-workspace-stream-'));
  const store = new Store(join(dir, 'hub.db')), links = new WorkspaceLinks(store);
  let token = 'a'.repeat(32), invalidHeaders = 0;
  const live = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/v1/identity') { res.end(JSON.stringify({version: 1, workspace_id: 'peer'})); return; }
    if (req.headers['x-workspace-id'] !== 'peer') invalidHeaders++;
    if (req.url !== '/v1/stream') { res.writeHead(404); res.end('{}'); return; }
    live.add(res); res.on('close', () => live.delete(res));
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(': ready\n\ndata: {"type":"runner","connected":true}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const abort = new AbortController();
  try {
    const link = await links.attach({name: 'peer', url, token});
    let opened = 0, events = 0;
    const start = () => links.stream(link.id, abort.signal, () => opened++, () => events++).catch(() => {});
    const first = start();
    await wait(() => opened === 1 && events === 1);
    token = 'b'.repeat(32);
    await links.attach({name: 'peer', url, token}, link.id);
    await first;
    await wait(() => live.size === 0);
    const second = start();
    await wait(() => opened === 2 && events === 2);
    abort.abort(); await second;
    await wait(() => live.size === 0);
    assert.equal(invalidHeaders, 0);
  } finally {
    abort.abort(); await links.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.database.close(); rmSync(dir, {recursive: true, force: true});
  }
});
