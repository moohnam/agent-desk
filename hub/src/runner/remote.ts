// Run on the target machine from its own checkout, Node and existing CLI login account.
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RemoteExchange, RemoteReply } from '../../../shared/remote.ts';
import { config } from '../config.ts';
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
let stopping = false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
agent.pump();
while (!stopping) {
  let more = false;
  try {
    // Replacing a revoked token must not require restarting engines that are still working.
    token = readFileSync(tokenFile,'utf8').trim();
    if (!token) throw new Error('러너 토큰 파일이 비었습니다');
    const events = journal.events();
    if (!events.length && journal.lastEvent > journal.eventAck) throw new Error('첫 미전달 이벤트가 배치 크기 한도를 넘었습니다. 전달 DB 원본을 보존하고 확인해 주세요');
    const input: RemoteExchange = {version:1,journalId:journal.id,commandAck:journal.commandAck,events,
      more:journal.lastEvent > (events.at(-1)?.seq ?? journal.eventAck), sessions:agent.runner.snapshot(),engines:agent.runner.capabilities.engines};
    const res = await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(input),signal:AbortSignal.timeout(10_000)});
    if (!res.ok) {
      const detail = await res.json().catch(()=>({})) as {error?:string};
      throw new Error(`허브 교환 실패 (HTTP ${res.status}): ${detail.error?.slice(0,250) ?? ''}`);
    }
    const reply = await res.json() as RemoteReply;
    journal.acknowledge(reply.eventAck,events.at(-1)?.seq ?? journal.eventAck);
    journal.receive(reply.commands);
    agent.pump();
    more = input.more || reply.commands.length > 0;
    if (lastError) console.log('허브에 다시 연결했습니다');
    lastError = '';
  } catch(e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error !== lastError) console.error(`${error}. 실행 중 작업과 미전달 기록을 유지하며 재시도합니다.`);
    lastError = error;
  }
  if (!more) await new Promise(r=>setTimeout(r,lastError?3000:1000));
}
for (const s of agent.runner.snapshot()) agent.runner.handle({type:'close',sessionId:s.sessionId});
journal.close();
