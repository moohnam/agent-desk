// Run on the target machine from its own checkout, Node and existing CLI login account.
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RemoteExchange, RemoteReply } from '../../../shared/remote.ts';
import { config } from '../config.ts';
import { maintenanceActive, registerRuntimeControl, sessionBlockers } from '../runtime-control.ts';
import { RemoteAgent } from './remote-agent.ts';
import { RemoteJournal } from './remote-journal.ts';

const hub = new URL(config.remote.hubUrl ?? '');
if (!['http:','https:'].includes(hub.protocol) || hub.username || hub.password || hub.search || hub.hash || hub.pathname !== '/') throw new Error('AGENT_DESK_HUB_URL에 경로 없는 허브 주소만 지정하세요');
if (hub.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(hub.hostname)) throw new Error('원격 허브에는 HTTPS 또는 localhost SSH 터널을 사용하세요');
const id = config.remote.id;
const tokenFile = config.remote.tokenFile;
if (!id || !tokenFile) throw new Error('AGENT_DESK_RUNNER_ID와 AGENT_DESK_REMOTE_TOKEN_FILE이 필요합니다');
let token = readFileSync(tokenFile,'utf8').trim();
if (!token) throw new Error('러너 토큰 파일이 비었습니다');
chmodSync(tokenFile,0o600);
const journal = new RemoteJournal(resolve(config.remote.dbPath));
journal.bind(hub.href,id);
journal.claim();
const agent = new RemoteAgent(journal,id,config.skillsHome);
const url = new URL(`/api/runners/${encodeURIComponent(id)}/exchange`,hub);
let lastError = '';
let retryMs = 1000;
let stopping = false;
let exchanging = false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
agent.runner.startModelRefresh();
agent.pump();
await registerRuntimeControl({ role: 'remote', ready: () => !stopping,
  blockers: () => [...sessionBlockers(agent.runner.snapshot()), ...(exchanging ? ['교환 중'] : []),
    ...(journal.hasUndeliveredCommands ? ['미실행 명령'] : []), ...(journal.lastEvent > journal.eventAck ? ['미확인 이벤트'] : [])],
  stop: () => { stopping = true; } });
while (!stopping) {
  if (maintenanceActive()) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
  let more = false;
  exchanging = true;
  try {
    // Replacing a revoked token must not require restarting engines that are still working.
    token = readFileSync(tokenFile,'utf8').trim();
    if (!token) throw new Error('러너 토큰 파일이 비었습니다');
    const events = journal.events();
    if (!events.length && journal.lastEvent > journal.eventAck) throw new Error('첫 미전달 이벤트가 배치 크기 한도를 넘었습니다. 전달 DB 원본을 보존하고 확인해 주세요');
    const usageReports = agent.runner.usageReports();
    const input: RemoteExchange = {version:1,journalId:journal.id,commandAck:journal.commandAck,events,
      more:journal.lastEvent > (events.at(-1)?.seq ?? journal.eventAck), sessions:agent.runner.snapshot(),engines:agent.runner.capabilities.engines,
      modelCatalogs:agent.runner.capabilities.modelCatalogs,skillSnapshot:agent.runner.capabilities.skillSnapshot,instructions:true,
      usageReports};
    const res = await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(input),signal:AbortSignal.timeout(10_000)});
    if (!res.ok) {
      await res.body?.cancel();
      const guide = res.status === 401 || res.status === 403 ? '허브 주소와 러너 연결 토큰을 확인하세요.'
        : res.status === 409 ? '허브 등록과 전달 DB가 기존 설정과 같은지 확인하세요.' : '허브의 연결 상태와 로그를 확인하세요.';
      throw new Error(`허브 교환 실패 (HTTP ${res.status}). ${guide}`);
    }
    const reply = await res.json() as RemoteReply;
    if (reply.refreshModels) agent.runner.refreshModels(reply.forceModelRefresh);
    agent.runner.exchangeUsage(usageReports, reply.usageRequests);
    journal.acknowledge(reply.eventAck,events.at(-1)?.seq ?? journal.eventAck);
    journal.receive(reply.commands);
    agent.pump();
    more = input.more || reply.commands.length > 0;
    if (lastError) console.log('허브에 다시 연결했습니다');
    lastError = '';
    retryMs = 1000;
  } catch(e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error !== lastError) console.error(`${error}. 실행 중 작업과 미전달 기록을 유지하며 재시도합니다.`);
    lastError = error;
    retryMs = Math.min(30_000, retryMs * 2);
  }
  finally { exchanging = false; }
  if (!more) await new Promise(r=>setTimeout(r,retryMs));
}
for (const s of agent.runner.snapshot()) agent.runner.handle({type:'close',sessionId:s.sessionId});
journal.close();
if (process.env.AGENT_DESK_UPDATE_SOCKET) process.exit(0);
