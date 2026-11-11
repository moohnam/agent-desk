import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Access } from '../../hub/src/access.ts';
import { Store } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { createHttpServer } from '../../hub/src/http.ts';
import { LocalRuntime } from '../../hub/src/runner/local-runtime.ts';
import { ensureGatewayLocalAuthority } from '../../hub/src/runner/local-launch.ts';
import { SkillStore } from '../../hub/src/skills.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';
import type { LinkTarget } from '../../hub/src/open.ts';
import type { HubToRunner, RunnerToHub } from '../../shared/protocol.ts';

const listen = (server: Server, port = 0) => new Promise<string>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  });
});
const stop = (server: Server) => new Promise<void>(resolve => {
  server.closeAllConnections();
  server.close(() => resolve());
});
const wait = async (check: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('상태 변경을 기다리다 시간 초과');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};

test('local gateway forwards compose and retains one offline message across its restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-gateway-'));
  const project = join(dir, 'project');
  mkdirSync(project);
  const commands: HubToRunner[] = [];
  let runnerMessage: ((message: RunnerToHub) => void) | undefined;
  const opened: LinkTarget[] = [];
  const authority = new LocalRuntime(join(dir, 'authority.db'), {skills: new SkillStore(join(dir, 'authority-skills')), runner: onMessage => {
    runnerMessage = onMessage;
    return {
    connected: true, id: 'existing-local-runner', engines: new Set(['claude']),
    has: () => true, handle: command => { commands.push(command); },
    };
  }});
  const authorityServer = authority.server();
  let gateway: Awaited<ReturnType<typeof makeGateway>> | undefined;
  let liveSharedPeer: Server | undefined;
  const makeGateway = async (authorityUrl: string, offline = false) => {
    const state = await ensureGatewayLocalAuthority({
      dbPath: join(dir, 'authority.db'), gatewayDbPath: join(dir, 'gateway.db'),
      tokenFile: join(dir, 'authority.token'), url: authorityUrl, port: Number(new URL(authorityUrl).port),
      ...(offline ? {spawnAuthority: (() => ({exitCode: 1, signalCode: null, on: () => {}, once: () => {}, unref: () => {}})) as never} : {}),
    });
    assert.equal(state, offline ? 'offline' : 'ready');
    const store = new Store(join(dir, 'gateway.db'));
    const links = new WorkspaceLinks(store);
    await links.configureLocal(authorityUrl, peer.token);
    const hub = new Hub(store, {skills: new SkillStore(join(dir, 'gateway-skills')), runner: () => ({
      connected: true, id: 'gateway-must-not-run', engines: new Set<string>(),
      has: () => false, handle: () => { throw new Error('gateway attempted local execution'); },
    })});
    const access = new Access(join(dir, 'gateway-token'), 4317, join(dir, 'devices.json'), ['desk.example.test']);
    const server = createHttpServer(hub, access, join(dir, 'uploads'),
      {workspaces: links, localAuthorityId: 'local-authority', openTarget: async target => { opened.push(target); }});
    const url = await listen(server);
    return {store, links, hub, access, server, url};
  };
  const closeGateway = async () => {
    if (!gateway) return;
    const old = gateway;
    gateway = undefined;
    await stop(old.server);
    await old.links.close();
    old.hub.remotes.close();
    old.store.database.close();
  };
  const api = async (path: string, method = 'GET', body?: unknown, operationId = randomUUID()) => {
    const response = await fetch(gateway!.url + '/api' + path, {
      method, headers: {'content-type': 'application/json', 'x-desk-operation-id': operationId},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json() as any};
  };
  const peer = authority.workspace.grant('gateway');
  writeFileSync(join(dir, 'authority.token'), peer.token, {mode: 0o600});
  let authorityUrl = '';
  try {
    authorityUrl = await listen(authorityServer);
    const port = Number(new URL(authorityUrl).port);
    gateway = await makeGateway(authorityUrl);
    const created = await api('/compose', 'POST', {text: `@one:${project} #claude first`});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const taskId = created.body.id as string;
    assert.ok(taskId);
    assert.equal(authority.hub.store.getTask(taskId)?.id, taskId);
    assert.equal(authority.hub.store.latestSession(taskId)?.runner_id, 'existing-local-runner');
    assert.equal(gateway.store.listTasks().length, 0);
    assert.equal(gateway.store.listProjects().length, 0);
    assert.equal(authority.hub.store.listProjects().length, 1);
    assert.equal((await api('/state')).body.tasks[0].id, taskId);
    assert.equal(commands.filter(command => command.type === 'start').length, 1);

    const approvalId = 'local-approval';
    runnerMessage!({type: 'approval_request', sessionId: authority.hub.store.latestSession(taskId)!.id,
      approvalId, toolName: 'Bash', input: {command: 'true'}});
    assert.equal(authority.hub.store.getApproval(approvalId)?.status, 'pending');
    assert.equal((gateway.store.database.prepare('SELECT count(*) AS n FROM approval').get() as {n:number}).n, 0);
    assert.ok((await api('/state')).body.approvals.some((approval: any) => approval.id === approvalId));
    assert.equal((await api(`/approvals/${approvalId}`, 'POST', {allow: true})).status, 200);
    assert.equal(authority.hub.store.getApproval(approvalId)?.status, 'allowed');
    assert.equal(commands.filter(command => command.type === 'approval_result' && command.approvalId === approvalId).length, 1);

    const original = join(project, 'report.html');
    writeFileSync(original, '<link href="style.css">');
    const openedFile = await api('/open', 'POST', {task_id: taskId, href: 'report.html:12'});
    assert.equal(openedFile.status, 200, JSON.stringify(openedFile.body));
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], {kind: 'file', path: original, reveal: false});

    const skill = await api('/skills', 'POST', {name: 'gateway-check', description: 'source skill'});
    assert.equal(skill.status, 201, JSON.stringify(skill.body));
    assert.equal(authority.hub.skills.get('gateway-check').name, 'gateway-check');
    assert.ok((await api('/skills')).body.some((item: any) => item.name === 'gateway-check'));
    assert.deepEqual(gateway.hub.skills.list(), []);
    const file = await api('/skills/gateway-check/file?path=SKILL.md');
    assert.equal(file.status, 200);
    assert.match(file.body.content, /source skill/);

    const channel = await api('/channels', 'POST', {name: 'Local Feed', source: 'push'});
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const channelId = channel.body.channel.id as string;
    const channelToken = channel.body.token as string;
    assert.equal((await api('/channels')).body[0].id, channelId);
    assert.equal(authority.hub.channels.list()[0].id, channelId);
    const ingest = await fetch(`${gateway.url}/api/channels/${channelId}/entries`, {
      method: 'POST', headers: {authorization: `Bearer ${channelToken}`, 'content-type': 'application/json'},
      body: JSON.stringify({entries: [{external_id: 'entry-1', body: 'from producer'}]}),
    });
    assert.equal(ingest.status, 200);
    assert.equal((await api(`/channels/${channelId}/entries`)).body.entries[0].body, 'from producer');
    assert.equal(gateway.hub.channels.list().length, 0);

    const mcpRequest = {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}};
    const mcpGateway = await fetch(gateway.url + '/mcp', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(mcpRequest)});
    const mcpAuthority = await fetch(authorityUrl + '/v1/mcp', {method: 'POST', headers: {
      authorization: `Bearer ${peer.token}`, 'x-workspace-id': authority.workspace.id, 'content-type': 'application/json',
    }, body: JSON.stringify(mcpRequest)});
    assert.equal(mcpGateway.status, mcpAuthority.status);
    assert.deepEqual(await mcpGateway.json(), await mcpAuthority.json());

    const sharedPeer = createServer((req, res) => {
      res.writeHead(req.url === '/v1/identity' ? 200 : 404, {'content-type': 'application/json'});
      res.end(JSON.stringify(req.url === '/v1/identity' ? {version: 1, workspace_id: 'unrelated-shared-peer'} : {error: 'not found'}));
    });
    const sharedUrl = await listen(sharedPeer);
    try {
      assert.deepEqual((await api('/workspaces')).body, []);
      const added = await api('/workspaces', 'POST', {name: 'shared', url: sharedUrl, token: 's'.repeat(32)});
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal((await api('/workspaces')).body.length, 1);
      assert.equal((await api('/workspaces/local-authority', 'DELETE')).status, 403);
      assert.equal((await api('/workspaces/local-authority', 'PUT', {name: 'x', url: sharedUrl, token: 's'.repeat(32)})).status, 403);
      assert.equal((await api(`/workspaces/${added.body.id}`, 'DELETE')).status, 200);
      assert.deepEqual((await api('/workspaces')).body, []);
    } finally { await stop(sharedPeer); }

    const localStreamAbort = new AbortController();
    let remoteStream: import('node:http').IncomingMessage | undefined;
    try {
      const localStream = await fetch(gateway.url + '/api/stream', {signal: localStreamAbort.signal});
      const remoteHeaders = {host: 'desk.example.test', authorization: `Bearer ${gateway.access.token}`, 'content-type': 'application/json'};
      const remoteRequest = (path: string, method = 'GET', body?: unknown) => new Promise<{
        status: number; body: any; headers: import('node:http').IncomingHttpHeaders;
      }>((resolve, reject) => {
        const req = httpRequest(gateway!.url + path, {method, headers: remoteHeaders}, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({status: res.statusCode!, body: JSON.parse(data), headers: res.headers}));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
      const activeRemoteStream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = httpRequest(gateway!.url + '/api/stream', {headers: remoteHeaders}, resolve);
        req.on('error', reject);
        req.end();
      });
      remoteStream = activeRemoteStream;
      assert.equal(localStream.status, 200);
      assert.equal(activeRemoteStream.statusCode, 200);
      let localEvents = '';
      let remoteEvents = '';
      const readLocal = (async () => { try { for await (const chunk of localStream.body! as any) localEvents += new TextDecoder().decode(chunk); } catch {} })();
      activeRemoteStream.on('data', chunk => { remoteEvents += chunk.toString(); });
      assert.equal((await remoteRequest('/api/access')).status, 403);
      const requested = await remoteRequest('/access/request', 'POST', {name: 'test device'});
      assert.equal(requested.status, 200);
      const request = requested.body as {id: string; secret: string};
      await wait(() => localEvents.includes('"type":"access"'));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(!remoteEvents.includes('"type":"access"'));
      const localAccess = await api('/access');
      assert.equal(localAccess.status, 200);
      assert.ok(localAccess.body.requests.some((item: any) => item.id === request.id));
      assert.equal((await remoteRequest(`/api/access-requests/${request.id}`, 'POST', {allow: true})).status, 403);
      assert.equal((await api(`/access-requests/${request.id}`, 'POST', {allow: true})).status, 200);
      const polled = await remoteRequest('/access/status', 'POST', request);
      assert.equal(polled.body.status, 'allowed');
      assert.ok(polled.headers['set-cookie']?.join(';').includes('desk_device='));
      localStreamAbort.abort();
      activeRemoteStream.destroy();
      await readLocal;
    } finally {
      localStreamAbort.abort();
      remoteStream?.destroy();
    }

    liveSharedPeer = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://shared');
      const body = path.pathname === '/v1/identity' ? {version: 1, workspace_id: 'live-shared-during-local-outage'}
        : path.pathname === '/v1/read' && path.searchParams.get('path') === '/state'
          ? {projects: [{id: 'shared-project'}], tasks: [{id: 'shared-task'}], approvals: [], questions: []}
          : path.pathname === '/v1/read' && path.searchParams.get('path') === '/feed'
            ? [{id: 1, task_id: 'shared-task', kind: 'assistant', payload: {text: 'shared remains live'}}]
            : {error: 'not found'};
      res.writeHead('error' in body ? 404 : 200, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    });
    const liveSharedUrl = await listen(liveSharedPeer);
    const attached = await api('/workspaces', 'POST', {name: 'live shared', url: liveSharedUrl, token: 't'.repeat(32)});
    assert.equal(attached.status, 201);
    const liveSharedId = attached.body.id as string;

    await stop(authorityServer);
    const unavailable = await api('/state');
    const sharedDuringOutage = await api(`/workspaces/${liveSharedId}/state`);
    assert.equal(sharedDuringOutage.status, 200);
    assert.equal(sharedDuringOutage.body.tasks[0].id, 'shared-task');
    assert.equal((await api('/workspaces')).body[0].id, liveSharedId);
    assert.equal(unavailable.status, 503);
    const operationId = randomUUID();
    const pending = await api(`/tasks/${taskId}/messages`, 'POST', {text: 'offline once'}, operationId);
    assert.equal(pending.status, 202);
    assert.equal(pending.body.shared_pending, true);
    assert.equal(gateway.store.listTasks().length, 0);
    await closeGateway();
    gateway = await makeGateway(authorityUrl, true);
    assert.equal(gateway.links.deliveries('local-authority').filter(row => row.status === null).length, 1);
    await listen(authorityServer, port);
    await wait(() => gateway!.links.deliveries('local-authority').length === 0);
    assert.equal((gateway.store.database.prepare('SELECT status FROM workspace_delivery WHERE id=?').get(operationId) as {status:number}).status, 202);
    assert.equal(authority.hub.store.queued().filter(row => row.text === 'offline once').length, 1);
    assert.equal((await api('/state')).body.tasks[0].id, taskId);
    assert.equal(commands.filter(command => command.type === 'start').length, 1);
    assert.equal((await api(`/workspaces/${liveSharedId}/state`)).body.tasks[0].id, 'shared-task');
  } finally {
    await closeGateway();
    if (liveSharedPeer?.listening) await stop(liveSharedPeer);
    if (authorityServer.listening) await stop(authorityServer);
    authority.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
