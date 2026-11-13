import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { DocumentPreviews } from './document-previews.ts';
import { DiagramBrowser } from './diagram-browser.ts';
import { DiagramCache } from './diagram-cache.ts';
import { workspaceFile } from './shared-files.ts';
import { deviceName, ipOf, type Access } from './access.ts';
import { readBody, sameOrigin } from './body.ts';
import type { HubMessage } from '../../shared/api.ts';
import { config } from './config.ts';
import { HttpError } from './errors.ts';
import type { Hub } from './hub.ts';
import { handleMcp } from './mcp.ts';
import { linkTarget, localOrigin, openTarget } from './open.ts';
import { saveFromUrl, saveUpload } from './uploads.ts';
import { readEngineUsage, readUsage } from './usage.ts';
import { remoteLocation } from '../../shared/remote.ts';
import { workspaceApi, workspaceRoute } from './workspace-api.ts';
import { WorkspaceLinks } from './workspace-links.ts';
import { handleBrokerMcp } from './request-broker.ts';
import { ENGINES, parseCompose, type EngineName } from '../../shared/compose.ts';

const WEB_DIST = config.webDist;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

/** Serves the built web UI, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string, res: ServerResponse) {
  const file = normalize(join(WEB_DIST, pathname));
  const target = file.startsWith(WEB_DIST) && extname(file) ? file : join(WEB_DIST, 'index.html');
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'web UI not built: run `npm --workspace web run build`, or use the Vite dev server' });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const b = await readBody(req);
  if (b === undefined) return {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'JSON 객체가 필요합니다');
  return b as Record<string, any>;
}

/** The page's own path for a redirect: one leading slash, so `//host` can't send it to another site. */
const here = (url: URL) => `/${url.pathname.replace(/^\/+/, '')}${url.search}`;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * What a device without a token sees: it can ask this Mac to let it in, then waits for the answer.
 * The code shows on both screens, so the Mac's user knows which request is this one.
 */
const REQUEST_PAGE = (name: string) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Desk</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:30em;margin:18vh auto;padding:0 20px}
h1{font-size:20px}input,button{font:inherit;padding:6px 10px}input{width:100%;box-sizing:border-box;margin:4px 0 10px}
.code{font-size:32px;letter-spacing:6px;font-weight:600}.muted{color:#666;font-size:14px}</style>
<body><h1>이 기기는 아직 데스크에 연결되지 않았습니다</h1>
<div id="ask"><p>Mac에 접속 요청을 보내고, Mac의 Agent Desk 화면에서 <b>허용</b>을 누르면 연결됩니다.</p>
<label>이 기기 이름<input id="name" maxlength="60" value="${name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}"></label>
<button id="send">접속 요청 보내기</button></div>
<div id="wait" hidden><p>Mac에서 아래 코드가 적힌 요청을 허용해 주세요.</p><p class="code" id="code"></p>
<p class="muted">이 창을 열어 두세요. 10분 안에 답이 없으면 다시 요청해야 합니다.</p></div>
<p id="msg"></p>
<p class="muted">또는 Mac에서 Agent Desk 상단의 <b>다른 기기 연결</b> 창에 있는 QR 코드를 스캔해도 됩니다.</p>
<script>
const $ = (id) => document.getElementById(id);
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
$('send').onclick = async () => {
  $('msg').textContent = '';
  const r = await post('/access/request', { name: $('name').value });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('msg').textContent = j.error || '요청하지 못했습니다'; return; }
  $('ask').hidden = true; $('wait').hidden = false; $('code').textContent = j.code;
  const poll = async () => {
    const s = await post('/access/status', { id: j.id, secret: j.secret }).then((x) => x.json()).catch(() => ({ status: 'pending' }));
    if (s.status === 'allowed') { location.reload(); return; }
    if (s.status === 'pending') { setTimeout(poll, 2000); return; }
    $('wait').hidden = true; $('ask').hidden = false;
    $('msg').textContent = s.status === 'denied' ? 'Mac에서 거절했습니다.' : '요청이 만료되었습니다. 다시 보내 주세요.';
  };
  setTimeout(poll, 2000);
};
</script></body></html>`;

/** `uploadsDir`: where files sent from other devices (a phone) are saved. */
export function createHttpServer(hub: Hub, access: Access, uploadsDir: string, options: { openTarget?: typeof openTarget; workspaces?: WorkspaceLinks; localAuthorityId?: string } = {}) {
  const workspaces = options.workspaces ?? new WorkspaceLinks(hub.store,hub.skills);
  const localAuthorityId = options.localAuthorityId;
  const diagramBrowser=new DiagramBrowser(WEB_DIST,config.diagramBrowser);
  const diagrams=new DiagramCache((source,signal)=>diagramBrowser.render(source,signal));
  const previews = new DocumentPreviews(async(source,task,href,base,receive)=>{
    if(source || localAuthorityId)return workspaces.previewFile(source||localAuthorityId!,task,href,base,receive);
    const {file,stat,target}=await workspaceFile(hub,task,href,base);
    try {return await receive(new Response(await file.readFile(),{headers:{'content-length':String(stat.size),'x-desk-filename':encodeURIComponent(target.path.split('/').at(-1)!)}}));}
    finally {await file.close();}
  });
  access.onChange = () => hub.bus.emit('message', { type: 'access', ...access.view() } satisfies HubMessage);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const route = `${req.method} /${parts.slice(1).map((p, i) => (i % 2 === 1 ? ':id' : p)).join('/')}`;
    const id = parts[2];

    // Runner credentials authorize this exchange only, never the desk UI, MCP or management API.
    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'runners' && parts[3] === 'exchange') {
      try {
        if (!sameOrigin(req)) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
        const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const input = await readJson(req);
        if (localAuthorityId) {
          const reply=await workspaces.trustedCall(localAuthorityId,`/v1/runner-exchange/${encodeURIComponent(id)}`,input,{'x-runner-token':token??''});
          return send(res,reply.status,reply.body);
        }
        if (!hub.remotes.accepts(id, token)) throw new HttpError(401, '이 러너의 연결 토큰이 필요합니다');
        return send(res, 200, hub.atomic(() => hub.remotes.exchange(id, input as any)));
      } catch (error) {
        return send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Another device must name this Mac by an address it has (no rebound foreign domain).
    if (!access.isLocal(req) && !access.hostAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('이 주소로는 데스크에 접속할 수 없습니다. Mac의 IP 주소나 이름.local로 여세요 (다른 이름은 AGENT_DESK_HOSTS에 추가).');
    }

    // Only an authenticated prepare call grants this narrow read capability. Sandboxed frames
    // have an opaque origin and cannot rely on device cookies. Revocation is checked per file.
    if (parts[0] === '_preview') {
      try {
        if(req.method!=='GET'||parts.length<3)throw new HttpError(404,'문서가 없습니다');
        if(!/^[a-zA-Z0-9.:[\]-]+$/.test(req.headers.host??''))throw new HttpError(400,'잘못된 호스트입니다');
        await previews.serve(parts[1],parts.slice(2).join('/'),res,`http://${req.headers.host}`);
      } catch(error) {
        if(!res.headersSent)send(res,error instanceof HttpError?error.status:500,{error:error instanceof Error?error.message:'문서를 읽지 못했습니다'});
        else res.destroy();
      }
      return;
    }

    // Producers can only write their own push channel. Even loopback/admin callers need its token;
    // this exception never grants a producer access to any other hub route.
    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'channels' && parts[3] === 'entries') {
      try {
        if (!sameOrigin(req)) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
        const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const b = await readJson(req);
        if (localAuthorityId) {
          const reply=await workspaces.trustedCall(localAuthorityId,`/v1/channel-ingest/${encodeURIComponent(id)}`,b,{'x-channel-token':token??''});
          return send(res,reply.status,reply.body);
        }
        if (!hub.channels.acceptsToken(id, token)) throw new HttpError(401, '이 채널의 입력 토큰이 필요합니다');
        return send(res, 200, hub.channels.ingest(id, b.entries === undefined ? b : b.entries));
      } catch (error) {
        return send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }


    if (access.matches(url.searchParams.get('token'))) {
      url.searchParams.delete('token');
      const cookies = access.isLocal(req) ? [] : access.addDevice(deviceName(req.headers['user-agent']), ipOf(req));
      res.writeHead(302, { 'set-cookie': cookies, location: here(url) });
      return res.end();
    }
    // A device without a token asks this Mac to let it in, and comes back for the answer.
    if (req.method === 'POST' && (url.pathname === '/access/request' || url.pathname === '/access/status')) {
      try {
        if (!sameOrigin(req)) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
        const b = await readJson(req);
        if (url.pathname === '/access/status') {
          const { status, cookies } = access.status(b.id, b.secret);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...(cookies && { 'set-cookie': cookies }) });
          return res.end(JSON.stringify({ status }));
        }
        const made = access.request(b.name, req);
        if (!made) throw new HttpError(429, '기다리는 접속 요청이 너무 많습니다. 잠시 뒤 다시 보내 주세요.');
        return send(res, 200, made);
      } catch (error) {
        return send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const client = access.identify(req);
    if (!client) {
      if (parts[0] === 'api' || url.pathname === '/mcp') return send(res, 401, { error: '접속 토큰이 필요합니다' });
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(REQUEST_PAGE(deviceName(req.headers['user-agent'])));
    }
    // A browser still on the shared token: a token of its own on its next page load.
    // Only a real navigation: a prefetch or a link preview would leave a device nobody uses.
    if (client.kind === 'shared' && client.via === 'cookie' && req.method === 'GET' && parts[0] !== 'api'
      && req.headers['sec-fetch-mode'] === 'navigate' && !req.headers['sec-purpose'] && !req.headers.purpose) {
      res.writeHead(302, { 'set-cookie': access.addDevice(deviceName(req.headers['user-agent']), ipOf(req)), location: here(url) });
      return res.end();
    }
    const local = client.kind === 'local';

    try {
      if ((parts[0] === 'api' || url.pathname === '/mcp') && !sameOrigin(req)) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
      if (url.pathname === '/mcp') {
        if(!localAuthorityId)return await handleMcp(hub,req,res);
        const body=await readBody(req);
        if(await handleBrokerMcp(workspaces,localAuthorityId,body,req,res))return;
        return await workspaces.proxyMcp(localAuthorityId,req,res,body);
      }
      if (parts[0] !== 'api') return await serveStatic(url.pathname, res);
      if(req.method==='POST'&&url.pathname==='/api/diagram') {
        const body=await readJson(req);
        if(typeof body.source!=='string')throw new HttpError(400,'도표 원문이 필요합니다');
        const controller=new AbortController();const abort=()=>controller.abort();res.once('close',abort);
        try {
          const result=await diagrams.render(body.source,await diagramBrowser.version(),controller.signal);
          if(!res.destroyed){res.setHeader('cache-control','no-store');return send(res,200,result);}
          return;
        }finally{res.off('close',abort);}
      }
      if((req.method==='DELETE'||req.method==='PUT')&&url.pathname==='/api/preview') {
        const b=await readJson(req);
        if(typeof b.id!=='string')throw new HttpError(400,'문서 ID가 필요합니다');
        if(req.method==='PUT'){
          try{previews.renew(b.id);}
          catch(error){if(error instanceof HttpError&&error.status===404)return send(res,409,{error:error.message});throw error;}
        }else await previews.release(b.id);
        return send(res,200,{ok:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const b=await readJson(req);
        if(typeof b.task_id!=='string'||!b.task_id||typeof b.href!=='string'||b.href.length>4096||typeof b.source!=='string')throw new HttpError(400,'작업과 파일 링크가 필요합니다');
        const source=b.source||workspaces.legacyOwner('task',b.task_id)||'';
        if(!source&&!localAuthorityId&&remoteLocation(hub.cwdOf(b.task_id)??''))throw new HttpError(409,'원격 작업공간 연결이 필요합니다');
        const token=access.token;
        const allowed=()=> (client.kind==='local'||client.kind==='device'&&access.view().devices.some(d=>d.id===client.device.id)||client.kind==='shared'&&access.matches(token))
          && (!source||workspaces.list().some(w=>w.id===source));
        const document=await previews.prepare(source,b.task_id,b.href,b.refresh===true,allowed);
        if(res.destroyed){await previews.release(document.url.split('/')[2]);return;}
        return send(res,200,document);
      }
      if (parts[1] === 'workspaces') {
        if (parts.length === 2 && req.method === 'GET') return send(res,200,workspaces.list().filter(link=>link.id!==localAuthorityId));
        if (parts.length === 2 && req.method === 'POST') {
          if (!local) throw new HttpError(403,'공유 러너 연결은 허브 머신에서만 등록할 수 있습니다');
          return send(res,201,await workspaces.attach(await readJson(req)));
        }
        if (parts.length === 3 && req.method === 'PUT') {
          if (!local) throw new HttpError(403,'공유 러너 연결은 허브 머신에서만 변경할 수 있습니다');
          if (id === localAuthorityId) throw new HttpError(403,'로컬 작업공간 연결은 서버 설정에서 관리합니다');
          return send(res,200,await workspaces.attach(await readJson(req),id));
        }
        if (parts.length === 3 && req.method === 'DELETE') {
          if (!local) throw new HttpError(403,'공유 러너 연결은 허브 머신에서만 제거할 수 있습니다');
          if (id === localAuthorityId) throw new HttpError(403,'로컬 작업공간 연결은 서버 설정에서 관리합니다');
          workspaces.remove(id);return send(res,200,{ok:true});
        }
        if (parts.length >= 4) {
          if (id === localAuthorityId) throw new HttpError(404,'이 연결은 기본 작업공간입니다');
          const path='/'+parts.slice(3).join('/')+url.search;
          if (req.method === 'POST' && path === '/open') {
            if (!local || !localOrigin(req.headers.origin)) throw new HttpError(403, '이 기기에서는 열 수 없습니다. 허브 머신에서 열어 주세요.');
            const b = await readJson(req);
            if (typeof b.href !== 'string' || !b.href || typeof b.task_id !== 'string' || !b.task_id) throw new HttpError(400, '파일 링크와 작업 ID가 필요합니다');
            const controller = new AbortController();
            res.once('close', () => controller.abort());
            const target = /^(akb|lectern):/i.test(b.href) ? linkTarget(b.href, undefined) : await workspaces.fetchFile(id, b.task_id, b.href, controller.signal);
            if (controller.signal.aborted) { await workspaces.discardFile(target); return; }
            try { await (options.openTarget ?? openTarget)(target); }
            catch(error) { await workspaces.discardFile(target); throw error; }
            return send(res, 200, { ok: true, ...target });
          }
          const leave = client.kind === 'device' ? access.connect(client.device.id,ipOf(req),()=>res.destroy()) : ()=>{};
          res.on('close',leave);
          return await workspaces.proxy(id,path,req,res);
        }
        throw new HttpError(404,'공유 작업공간 요청을 찾을 수 없습니다');
      }
      const workspaceUrl = new URL(url); workspaceUrl.pathname = url.pathname.slice(4);
      if (workspaceRoute(req.method ?? '', workspaceUrl.pathname)) {
        if (!local && (route === 'POST /runners' || route === 'POST /runners/:id/token'))
          throw new HttpError(403, '러너 관리는 허브 머신에서만 할 수 있습니다');
        if (localAuthorityId) {
          let owner:string|undefined;
          const kind=parts[1]==='projects'?'project':parts[1]==='tasks'?'task':parts[1]==='approvals'?'approval':parts[1]==='questions'?'question':undefined;
          if(kind&&id)owner=workspaces.legacyOwner(kind,id);
          let body:Record<string,any>|undefined;
          if(req.method!=='GET'&&req.method!=='HEAD'&&['/projects','/tasks','/compose'].includes(workspaceUrl.pathname)){
            body=await readJson(req);
            if(workspaceUrl.pathname==='/tasks'&&typeof body.project_id==='string')owner=workspaces.legacyOwner('project',body.project_id)??owner;
            if(workspaceUrl.pathname==='/projects'&&typeof body.root_path==='string'){
              const location=remoteLocation(body.root_path);
              if(location)owner=workspaces.remoteOwner(location.address)??owner;
            }
            if(workspaceUrl.pathname==='/compose'&&typeof body.text==='string'){
              const mention=parseCompose(body.text).mention;
              const path=mention?.path;
              const location=path&&remoteLocation(path);
              if(location)owner=workspaces.remoteOwner(location.address)??owner;
              else if(mention)owner=workspaces.projectOwner(mention.name)??owner;
            }
          }
          return await workspaces.proxy(owner??localAuthorityId,workspaceUrl.pathname+url.search,req,res,undefined,body);
        }
        const result = workspaceApi(hub, req.method!, workspaceUrl, req.method === 'GET' ? {} : await readJson(req));
        return send(res, result.status, result.body);
      }
      if (localAuthorityId && req.method === 'GET' && url.pathname === '/api/state') {
        const remote=await workspaces.read(localAuthorityId,'/state').catch(()=>{throw new HttpError(503,'로컬 작업공간 연결이 끊겼습니다');});
        return send(res,remote.status,remote.status===200?{...remote.body,client:{local},...(local&&{access:access.view()})}:remote.body);
      }
      if (localAuthorityId && req.method === 'POST' && route === 'POST /channels/:id/refresh') {
        const reply=await workspaces.trustedCall(localAuthorityId,`/v1/channel-refresh/${encodeURIComponent(id)}`,{});
        return send(res,reply.status,reply.body);
      }
      if (localAuthorityId && req.method === 'GET' && url.pathname === '/api/stream') {
        let opened=false;
        const pending:HubMessage[]=[];
        const onAccess=(message:HubMessage)=>{
          if(!local || message.type!=='access' || res.destroyed)return;
          if(!opened){pending.push(message);return;}
          res.write(`data: ${JSON.stringify(message)}\n\n`);
        };
        const leave=client.kind==='device'?access.connect(client.device.id,ipOf(req),()=>res.end()):()=>{};
        hub.bus.on('message',onAccess);
        res.on('close',()=>{hub.bus.off('message',onAccess);leave();});
        return await workspaces.proxy(localAuthorityId,'/stream',req,res,()=>{
          opened=true;
          for(const message of pending)onAccess(message);
          pending.length=0;
        });
      }
      switch (route) {
        case 'POST /channels/:id/refresh':
          return send(res, 200, await hub.channels.refresh(id));
        case 'GET /state':
          return send(res, 200, { ...hub.state(), client: { local }, ...(local && { access: access.view() }) });
        case 'GET /access': {
          if (!local) throw new HttpError(403, '이 Mac에서만 볼 수 있습니다');
          const urls = access.urls();
          return send(res, 200, { urls: await Promise.all(urls.map(async (u) => ({ url: u, qr: await access.qrSvg(u) }))), ...access.view() });
        }
        case 'POST /access-requests/:id': {
          if (!local) throw new HttpError(403, '이 Mac에서만 허용할 수 있습니다');
          if (!access.answer(id, (await readJson(req)).allow === true)) {
            // Its card goes from every screen of this Mac.
            access.onChange();
            throw new HttpError(404, '이미 처리했거나 만료된 요청입니다. 그 기기에서 다시 요청해 주세요.');
          }
          return send(res, 200, access.view());
        }
        case 'POST /access-token': {
          if (!local) throw new HttpError(403, '이 Mac에서만 바꿀 수 있습니다');
          access.rotateToken();
          return send(res, 200, { ok: true });
        }
        case 'PATCH /devices/:id': {
          if (!local) throw new HttpError(403, '이 Mac에서만 바꿀 수 있습니다');
          if (!access.renameDevice(id, (await readJson(req)).name)) throw new HttpError(404, '없는 기기입니다');
          return send(res, 200, access.view());
        }
        case 'DELETE /devices/:id': {
          if (!local) throw new HttpError(403, '이 Mac에서만 끊을 수 있습니다');
          if (!access.removeDevice(id)) throw new HttpError(404, '없는 기기입니다');
          return send(res, 200, access.view());
        }
        case 'GET /stream': {
          res.writeHead(200, {
            'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
          });
          res.write(': connected\n\n');
          // Who asks to connect and from where is for this Mac's pages only.
          const onMessage = (m: HubMessage) => { if (local || m.type !== 'access') res.write(`data: ${JSON.stringify(m)}\n\n`); };
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          hub.bus.on('message', onMessage);
          // A device's open pages, counted for the Mac's device list and closed when it is cut off.
          const leave = client.kind === 'device' ? access.connect(client.device.id, ipOf(req), () => res.end()) : () => {};
          req.on('close', () => { clearInterval(ping); hub.bus.off('message', onMessage); leave(); });
          return;
        }
        case 'GET /usage':
          // `refresh=1`: read again now instead of reusing the last minute's reading.
          // `engine`: that engine only, so a client can show each as it arrives.
          {
            const refresh = url.searchParams.get('refresh') === '1';
            const engine = url.searchParams.get('engine');
            if (!engine) return send(res, 200, await readUsage(refresh));
            if (!(ENGINES as string[]).includes(engine)) throw new HttpError(400, `알 수 없는 엔진입니다: ${engine}`);
            return send(res, 200, await readEngineUsage(engine as EngineName, refresh));
          }
        case 'POST /uploads': {
          // `{url}`: a file on the web (an image dragged in from a web page), downloaded here.
          if (/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
            return send(res, 201, { path: await saveFromUrl((await readJson(req)).url, uploadsDir) });
          }
          // Else the raw file, not a form: its content type needs a CORS preflight, which a page on
          // another site never gets past.
          if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'application/octet-stream 본문만 받습니다');
          const name = url.searchParams.get('name') ?? '';
          return send(res, 201, { path: await saveUpload(req, uploadsDir, name) });
        }
        case 'POST /open': {
          if (!local) throw new HttpError(403, '이 기기에서는 열 수 없습니다. Mac에서 열어 주세요.');
          if (!localOrigin(req.headers.origin)) throw new HttpError(403, 'forbidden');
          const b = await readJson(req);
          if (typeof b.href !== 'string' || !b.href) throw new HttpError(400, 'href is required');
          if (!localAuthorityId && typeof b.task_id === 'string' && remoteLocation(hub.cwdOf(b.task_id) ?? '') && !/^(akb|lectern):/i.test(b.href)) throw new HttpError(409, '원격 머신의 파일입니다. 해당 머신에서 이 경로를 열어 주세요');
          const target = localAuthorityId
            ? await (async()=>{
              const path='/open-target?'+new URLSearchParams({href:b.href,...(typeof b.task_id==='string'?{task_id:b.task_id}:{})});
              const response=await workspaces.read(localAuthorityId,path);
              if(response.status!==200)throw new HttpError(response.status,response.body?.error??'링크를 열지 못했습니다');
              return response.body as ReturnType<typeof linkTarget>;
            })()
            : linkTarget(b.href, typeof b.task_id === 'string' ? hub.cwdOf(b.task_id) : undefined);
          await (options.openTarget ?? openTarget)(target);
          return send(res, 200, { ok: true, ...target });
        }
        default:
          throw new HttpError(404, `no route for ${route}`);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.on('listening', () => { if(!localAuthorityId)hub.channels.start(); });
  server.on('close', () => { hub.channels.stop(); diagrams.close(); void diagramBrowser.close(); void previews.close(); void workspaces.close(); });
  return server;
}
