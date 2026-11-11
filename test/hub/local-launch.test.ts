import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../hub/src/db.ts';
import { SharedWorkspace } from '../../hub/src/shared-workspace.ts';
import { LocalRuntime } from '../../hub/src/runner/local-runtime.ts';
import { ensureGatewayLocalAuthority, ensureLocalAuthority, readLocalLaunchSettings } from '../../hub/src/runner/local-launch.ts';
import { WorkspaceLinks } from '../../hub/src/workspace-links.ts';

const fakeRunner = () => ({
  connected: true, id: 'fixture', engines: new Set<string>(), has: () => false,
  handle: () => { throw new Error('unexpected runner command'); },
});
const listen = async (server: ReturnType<typeof createServer>, port = 0) => {
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return (server.address() as { port: number }).port;
};
const stop = async (server: ReturnType<typeof createServer>) =>
  await new Promise<void>(resolve => server.close(() => resolve()));

test('persistent local settings contain paths and reject malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-config-'));
  try {
    const path = join(dir, 'local-mode.json');
    assert.equal(readLocalLaunchSettings(path), undefined);
    writeFileSync(path, JSON.stringify({authorityUrl:'http://127.0.0.1:4321/',tokenFile:join(dir,'token'),gatewayDbPath:join(dir,'gateway.db')}));
    assert.deepEqual(readLocalLaunchSettings(path), {authorityUrl:'http://127.0.0.1:4321/',tokenFile:join(dir,'token'),gatewayDbPath:join(dir,'gateway.db')});
    writeFileSync(path, JSON.stringify({authorityUrl:'http://127.0.0.1:4321/',tokenFile:'relative',gatewayDbPath:join(dir,'gateway.db')}));
    assert.throws(() => readLocalLaunchSettings(path), /절대 경로/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('config discovers persisted mode and explicit environment wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-env-'));
  const path = join(dir,'local-mode.json');
  const dbPath = join(dir,'source.db');
  const persisted = {authorityUrl:'http://127.0.0.1:4321/',tokenFile:join(dir,'persisted.token'),gatewayDbPath:join(dir,'persisted.db')};
  const script = `import {config} from ${JSON.stringify(new URL('../../hub/src/config.ts',import.meta.url).href)};console.log(JSON.stringify({url:config.localAuthorityUrl,tokenFile:config.localAuthorityTokenFile,gatewayDbPath:config.gatewayDbPath}))`;
  const run = (extra:Record<string,string>={}) => spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,AGENT_DESK_DB:dbPath,AGENT_DESK_LOCAL_MODE_FILE:path,...extra},encoding:'utf8',timeout:3000,
  });
  try {
    writeFileSync(path,JSON.stringify(persisted));
    const found = run();
    assert.equal(found.status,0,found.stderr);
    assert.deepEqual(JSON.parse(found.stdout),{url:persisted.authorityUrl,tokenFile:persisted.tokenFile,gatewayDbPath:persisted.gatewayDbPath});
    writeFileSync(path,'not-json');
    const explicit = run({AGENT_DESK_LOCAL_AUTHORITY_URL:'https://example.test/',AGENT_DESK_LOCAL_AUTHORITY_TOKEN_FILE:join(dir,'explicit.token'),AGENT_DESK_GATEWAY_DB:join(dir,'explicit.db')});
    assert.equal(explicit.status,0,explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout),{url:'https://example.test/',tokenFile:join(dir,'explicit.token'),gatewayDbPath:join(dir,'explicit.db')});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('automatic recovery starts only an activated, absent local authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-'));
  const dbPath = join(dir, 'authority.db'), tokenFile = join(dir, 'local.token');
  const store = new Store(dbPath);
  const workspace = new SharedWorkspace(undefined, store);
  const grant = workspace.grant('gateway');
  writeFileSync(tokenFile, `${grant.token}\n`, {mode:0o600});
  store.database.close();
  const portProbe = createServer();
  const port = await listen(portProbe);
  await stop(portProbe);
  const input = {dbPath,tokenFile,port,url:`http://127.0.0.1:${port}/`,timeoutMs:1500};
  let runtime:LocalRuntime|undefined;
  let server:ReturnType<LocalRuntime['server']>|undefined;
  try {
    await assert.rejects(ensureLocalAuthority({...input,spawnAuthority:(() => {throw new Error('spawned');}) as never}),/첫 로컬 작업공간 전환/);
    runtime = new LocalRuntime(dbPath,{runner:fakeRunner});
    server = runtime.server();
    await listen(server,port);
    await ensureLocalAuthority({...input,spawnAuthority:(() => {throw new Error('spawned');}) as never});
    await stop(server); runtime.close(); server=undefined; runtime=undefined;
    let launches = 0;
    await ensureLocalAuthority({...input,spawnAuthority:(() => {
      launches++;
      runtime = new LocalRuntime(dbPath,{runner:fakeRunner});
      server = runtime.server();
      void listen(server,port);
      return {exitCode:null,signalCode:null,on:()=>{},once:()=>{},unref:()=>{}};
    }) as never});
    assert.equal(launches,1);
  } finally {
    if(server?.listening) await stop(server);
    runtime?.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('wrong service response blocks automatic authority startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-wrong-'));
  const dbPath = join(dir,'authority.db'), tokenFile = join(dir,'local.token');
  const store = new Store(dbPath);
  const workspace = new SharedWorkspace(undefined,store);
  const token = workspace.grant('gateway').token;
  writeFileSync(tokenFile,token,{mode:0o600});
  store.database.close();
  const runtime = new LocalRuntime(dbPath,{runner:fakeRunner});
  const authority = runtime.server();
  const port = await listen(authority);
  const gatewayDbPath = join(dir,'gateway.db');
  const gateway = new Store(gatewayDbPath);
  const links = new WorkspaceLinks(gateway);
  await links.configureLocal(`http://127.0.0.1:${port}/`,token);
  await stop(authority);runtime.close();
  const wrong = createServer((_req,res)=>{res.writeHead(401);res.end('{}');});
  await listen(wrong,port);
  try {
    await assert.rejects(ensureLocalAuthority({dbPath,tokenFile,port,url:`http://127.0.0.1:${port}/`,spawnAuthority:(() => {throw new Error('spawned');}) as never}),/HTTP 401/);
    await assert.rejects(ensureGatewayLocalAuthority({dbPath,gatewayDbPath,tokenFile,port,url:`http://127.0.0.1:${port}/`,spawnAuthority:(() => {throw new Error('spawned');}) as never}),/HTTP 401/);
  } finally {await stop(wrong);await links.close();gateway.database.close();rmSync(dir,{recursive:true,force:true});}
});

test('offline gateway startup requires an existing link with the canonical identity, URL, and token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-offline-'));
  const dbPath = join(dir, 'authority.db'), gatewayDbPath = join(dir, 'gateway.db'), tokenFile = join(dir, 'local.token');
  const authority = new LocalRuntime(dbPath, {runner: fakeRunner});
  const server = authority.server();
  const port = await listen(server);
  const token = authority.workspace.grant('gateway').token;
  writeFileSync(tokenFile, token, {mode: 0o600});
  const gateway = new Store(gatewayDbPath);
  const links = new WorkspaceLinks(gateway);
  const url = `http://127.0.0.1:${port}/`;
  const input = {dbPath, gatewayDbPath, tokenFile, port, url,
    spawnAuthority: (() => ({exitCode: 1, signalCode: null, on: () => {}, once: () => {}, unref: () => {}})) as never};
  try {
    await stop(server);
    await assert.rejects(ensureGatewayLocalAuthority(input), /workspace_link|기존 게이트웨이/);
    await listen(server, port);
    await links.configureLocal(url, token);
    await stop(server);
    assert.equal(await ensureGatewayLocalAuthority(input), 'offline');
    await assert.rejects(ensureGatewayLocalAuthority({...input, timeoutMs: 20,
      spawnAuthority: (() => ({pid: 99999999, exitCode: null, signalCode: null,
        on: () => {}, once: () => {}, unref: () => {}, kill: () => false})) as never,
    }), /자식 프로세스 종료를 확인하지 못했습니다/);
    const update = gateway.database.prepare('UPDATE workspace_link SET workspace_id=? WHERE id=?');
    update.run('different-workspace', 'local-authority');
    await assert.rejects(ensureGatewayLocalAuthority(input), /신원·주소·토큰/);
    update.run(authority.workspace.id, 'local-authority');
    await assert.rejects(ensureGatewayLocalAuthority({...input, url: `http://127.0.0.1:${port + 1}/`, port: port + 1}), /신원·주소·토큰/);
    writeFileSync(tokenFile, 'z'.repeat(32), {mode: 0o600});
    await assert.rejects(ensureGatewayLocalAuthority(input), /신원·주소·토큰/);
  } finally {
    await links.close();
    gateway.database.close();
    if (server.listening) await stop(server);
    authority.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('recovery launches an isolated child and waits for authenticated identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-child-'));
  const dbPath = join(dir,'authority.db'), tokenFile = join(dir,'local.token');
  const store = new Store(dbPath);
  const workspace = new SharedWorkspace(undefined,store);
  writeFileSync(tokenFile,workspace.grant('gateway').token,{mode:0o600});
  store.database.close();
  const runtime = new LocalRuntime(dbPath,{runner:fakeRunner});
  const authority = runtime.server();
  const port = await listen(authority);
  await stop(authority);runtime.close();
  const script = join(dir,'fixture.mjs');
  writeFileSync(script, `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
if(process.env.AGENT_DESK_DB!==${JSON.stringify(dbPath)})process.exit(5);
const token=readFileSync(${JSON.stringify(tokenFile)},'utf8').trim();
createServer((req,res)=>{
  const correct=req.headers.authorization==='Bearer '+token;
  res.writeHead(correct?200:401,{'content-type':'application/json'});
  res.end(JSON.stringify(correct?{version:1,workspace_id:${JSON.stringify(workspace.id)}}:{}));
}).listen(Number(process.env.AGENT_DESK_SHARED_PORT),'127.0.0.1');
`);
  let child:ChildProcess|undefined;
  try {
    await ensureLocalAuthority({dbPath:relative(process.cwd(),dbPath),tokenFile:relative(process.cwd(),tokenFile),port,
      url:`http://127.0.0.1:${port}/`,scriptPath:relative(process.cwd(),script),
      spawnAuthority: ((...args:Parameters<typeof spawn>) => {
        assert.equal(args[2]?.env?.AGENT_DESK_DB,dbPath);
        assert.equal(args[1][0],script);
        child=spawn(...args);return child;
      }) as typeof spawn});
    assert.ok(child?.pid);
    assert.equal(existsSync(join(dir,'local-runtime.log')),true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/identity`,{headers:{authorization:`Bearer ${readFileSync(tokenFile,'utf8').trim()}`}})).status,200);
  } finally {
    if(child?.pid && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit',() => resolve()));
      process.kill(child.pid,'SIGTERM');
      await exited;
    }
    rmSync(dir,{recursive:true,force:true});
  }
});

test('signalled and timed-out children are detected and only the new child is cleaned up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-local-launch-cleanup-'));
  const dbPath = join(dir,'authority.db'), tokenFile = join(dir,'local.token');
  const store = new Store(dbPath);
  const workspace = new SharedWorkspace(undefined,store);
  writeFileSync(tokenFile,workspace.grant('gateway').token,{mode:0o600});
  store.database.close();
  const runtime = new LocalRuntime(dbPath,{runner:fakeRunner});
  const authority = runtime.server();
  const port = await listen(authority);
  await stop(authority);runtime.close();
  const input = {dbPath,tokenFile,port,url:`http://127.0.0.1:${port}/`};
  const children:ChildProcess[] = [];
  const spawnAuthority = ((...args:Parameters<typeof spawn>) => {
    const child=spawn(...args);children.push(child);return child;
  }) as typeof spawn;
  try {
    const signalScript = join(dir,'signal.mjs');
    writeFileSync(signalScript,"process.kill(process.pid,'SIGTERM');\n");
    const started=Date.now();
    await assert.rejects(ensureLocalAuthority({...input,scriptPath:signalScript,spawnAuthority,timeoutMs:3000}),/SIGTERM/);
    assert.ok(Date.now()-started<3000);
    const idleScript = join(dir,'idle.mjs');
    writeFileSync(idleScript,'setInterval(()=>{},1000);\n');
    await assert.rejects(ensureLocalAuthority({...input,scriptPath:idleScript,spawnAuthority,timeoutMs:350}),/시간이 초과/);
    assert.equal(children.at(-1)?.signalCode,'SIGTERM');
  } finally {
    for(const child of children)if(child.pid && child.exitCode===null && child.signalCode===null){
      const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      process.kill(child.pid,'SIGTERM');await exited;
    }
    rmSync(dir,{recursive:true,force:true});
  }
});
