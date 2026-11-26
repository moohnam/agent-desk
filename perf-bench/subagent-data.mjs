import { interactionData } from './interaction-data.mjs';
// 서브 에이전트 창의 고정 데이터. 작업 t0의 스레드에 Agent 호출을 넣고, 허브와 같은 before/more 페이지로 기록을 제공한다.
// 짝수 번째 서브 에이전트는 실행 중(자기 컬럼), 홀수 번째는 끝나 공통 history에 들어간다. 명령은 실행 중인 백그라운드 명령이다.
// fault는 누락 검출을 시험한다. drop-live: 단계 하나를 보낸 것으로 기록만 하고 보내지 않는다.
// hole: history의 표시 대상 글 하나를 모의 허브의 기록에서 뺀다. 그 글이 들 페이지는 그 글 없이 이어지고(빈 페이지로 커서를 멈추지 않는다),
// 측정은 고정 데이터 전체와 대조해 그 ID가 없음을 잡아야 한다.
export function subagentData(count, text = 'long', { agents = 8, steps = 80, commands = 30, page = 30, live = 50, fault = 'none' } = {}) {
  const base = interactionData(count, text);
  const at = i => new Date(Date.UTC(2026, 0, 1, 1) + i * 1000).toISOString();
  const row = (id, info, i) => ({ ...info, id, session_id: 's0', task_id: 't0', detailed: true, created_at: at(i), updated_at: at(i) });
  const list = [
    ...Array.from({ length: agents }, (_, i) => row(`a${i}`, { type: 'local_agent', agent: 'general-purpose', description: `측정 서브 에이전트 ${i + 1}`,
      status: i % 2 ? 'completed' : 'running', background: true, toolUseId: `call-${i}`, usage: { tokens: 12000, toolUses: steps / 4, durationMs: 60000 },
      ...(i % 2 && { summary: `측정 서브 에이전트 ${i + 1}의 결과입니다.` }) }, i)),
    ...Array.from({ length: commands }, (_, i) => row(`b${i}`, { type: 'local_bash', description: `측정 명령 ${i + 1}`, status: 'running', background: true,
      backgroundEvidence: 'native', command: `npm run bench -- --case=${i + 1}`, output: `측정 출력 줄 ${i + 1}\n`.repeat(200) }, agents + i)),
  ];
  let nextId = 1_000_000;
  const step = (agent, i) => {
    const kind = i === 0 ? 'user' : ['assistant', 'tool', 'tool_result'][(i - 1) % 3];
    const payload = kind === 'user' ? { kind, text: `측정 지시문 ${agent}` } : kind === 'assistant' ? { kind, text: `측정 서브 에이전트 글 ${agent} ${i}\n\n` + '분석 중인 내용을 정리합니다. '.repeat(6) }
      : kind === 'tool' ? { kind, toolUseId: `${agent}-t${i}`, name: 'Bash', input: { command: `grep -rn pattern src/${i}` } }
      : { kind, toolUseId: `${agent}-t${i - 1}`, isError: false, text: `src/${i}: match\n`.repeat(10) };
    return { id: ++nextId, session_id: 's0', task_id: 't0', subagent_id: agent, ts: at(agents + commands + i), kind, payload };
  };
  // 서브 에이전트들의 기록이 번갈아 쌓이게 걸음 순서로 ID를 매긴다. history는 여러 서브 에이전트가 섞인 ID 순서가 된다.
  const agentRows = list.filter(s => s.type === 'local_agent');
  const history = new Map(agentRows.map(s => [s.id, []]));
  for (let i = 0; i < steps; i++) for (const s of agentRows) history.get(s.id).push(step(s.id, i));
  const finished = new Set(agentRows.filter(s => s.status !== 'running').map(s => s.id));
  const shared = [...history].filter(([id]) => finished.has(id)).flatMap(([, events]) => events).sort((a, b) => a.id - b.id);
  const posts = events => events.filter(e => e.kind === 'user' || e.kind === 'assistant').map(e => e.id);
  // hole: history 가운데의 표시 대상 글. 어느 페이지 크기에서도 그 글이 들 페이지에서 빠진다.
  const holeId = fault === 'hole' ? posts(shared)[Math.floor(posts(shared).length / 2)] : undefined;
  const servedShared = shared.filter(e => e.id !== holeId);
  /** 허브 Subagents.events/history와 같은 형식: before 아래의 최신 page개, 오래된 것부터, more는 더 오래된 기록이 있는지. */
  const paged = (events, url) => {
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    const below = events.filter(e => e.id < before);
    return { events: below.slice(-page), more: below.length > page };
  };
  const thread = [...base.data[0]];
  for (let i = 0; i < agents; i++) thread.push({ id: 900_000 + i, session_id: 's0', task_id: 't0', ts: thread[0].ts, kind: 'tool',
    payload: { kind: 'tool', toolUseId: `call-${i}`, name: 'Agent', input: { description: `측정 서브 에이전트 ${i + 1}` } } });
  thread.sort((a, b) => a.id - b.id);
  const requests = { list: 0, history: 0, detail: 0 };
  const respond = url => {
    const path = url.pathname;
    if (path === '/api/tasks/t0/events') {
      const after = Number(url.searchParams.get('after') ?? 0), ids = url.searchParams.get('ids')?.split(',').map(Number);
      if (ids) return { events: thread.filter(e => ids.includes(e.id)), more: false };
      return after ? { events: thread.filter(e => e.id > after), more: false, incremental: true } : { events: thread, more: false };
    }
    if (path === '/api/tasks/t0/subagents') { requests.list++; return list; }
    if (path === '/api/tasks/t0/subagents/history') {
      requests.history++;
      return paged(servedShared, url);
    }
    const match = /^\/api\/tasks\/t0\/subagents\/([^/]+)\/events$/.exec(path);
    if (match && url.searchParams.get('session') === 's0' && history.has(decodeURIComponent(match[1]))) { requests.detail++; return paged(history.get(decodeURIComponent(match[1])), url); }
    // 데스크가 실행한 작업(source: app)에만 서브 에이전트 창이 열린다.
    if (path === '/api/state') { const state = base(url); return { ...state, tasks: state.tasks.map(t => t.id === 't0' ? { ...t, source: 'app' } : t) }; }
    return base(url);
  };
  respond.requests = requests;
  respond.holeId = holeId;
  /** 컬럼의 이전 페이지 수 상한: 고정 기록 수와 페이지 크기로 계산한다(첫 페이지 제외). */
  respond.pageLimit = column => Math.ceil((column === 'history' ? shared.length : history.get(column.replace(/^s0\//, ''))?.length ?? 0) / page);
  /** 컬럼별 전체 글 ID: 이전 페이지를 끝까지 읽은 뒤 화면과 대조한다. */
  respond.allPosts = column => column === 'history' ? posts(shared) : posts(history.get(column.replace(/^s0\//, '')) ?? []);
  respond.firstRunning = `s0/${agentRows.find(s => s.status === 'running')?.id}`;
  respond.streaming = false;
  /** 보낸 실시간 단계: 컬럼과 보낸 시각(벽시계 ms). 화면에 처음 나타난 시각과 대조한다. */
  respond.sent = [];
  let tick = 0;
  const running = agentRows.filter(s => s.status === 'running');
  // 정해진 live개만 보낸다. 실행 중인 서브 에이전트에 단계를 번갈아 보내고, 다섯 번에 한 번 진행 보고를 함께 보낸다.
  respond.next = () => {
    if (!respond.streaming || !running.length || respond.sent.length >= live) return [];
    const agent = running[tick % running.length];
    const event = { ...step(agent.id, steps + tick), kind: 'assistant', payload: { kind: 'assistant', text: `실시간 서브 에이전트 단계 ${++tick}` } };
    respond.sent.push({ id: event.id, column: `s0/${agent.id}`, sentAt: Date.now() });
    // 허브처럼 보낸 단계도 기록에 남는다. 나중에 처음 조회하는 컬럼은 이 단계를 첫 페이지로 받는다.
    history.get(agent.id).push(event);
    if (fault === 'drop-live' && tick === 1) return [];
    const messages = [{ type: 'subagent_event', event }];
    if (tick % 5 === 0) messages.push({ type: 'subagent', subagent: { ...agent, usage: { ...agent.usage, toolUses: agent.usage.toolUses + tick }, updated_at: event.ts } });
    return messages;
  };
  return respond;
}
