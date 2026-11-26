import { interactionData } from './interaction-data.mjs';
// 서브 에이전트 창의 고정 데이터. 작업 t0의 스레드에 Agent 호출을 넣고, 서브 에이전트와 백그라운드 명령 기록을 제공한다.
export function subagentData(count, text = 'long', { agents = 8, steps = 80, commands = 30 } = {}) {
  const base = interactionData(count, text);
  const at = i => new Date(Date.UTC(2026, 0, 1, 1) + i * 1000).toISOString();
  const row = (id, info, i) => ({ ...info, id, session_id: 's0', task_id: 't0', detailed: true, created_at: at(i), updated_at: at(i) });
  const list = [
    ...Array.from({ length: agents }, (_, i) => row(`a${i}`, { type: 'local_agent', agent: 'general-purpose', description: `측정 서브 에이전트 ${i + 1}`,
      status: i % 2 ? 'completed' : 'running', background: true, toolUseId: `call-${i}`, usage: { tokens: 12000, toolUses: steps / 4, durationMs: 60000 },
      ...(i % 2 && { summary: `측정 서브 에이전트 ${i + 1}의 결과입니다.` }) }, i)),
    // 창은 엔진이 확인한 실행 중 백그라운드 명령만 보여 준다(isCurrentCommand).
    ...Array.from({ length: commands }, (_, i) => row(`b${i}`, { type: 'local_bash', description: `측정 명령 ${i + 1}`, status: 'running', background: true,
      backgroundEvidence: 'native', command: `npm run bench -- --case=${i + 1}`, output: `측정 출력 줄 ${i + 1}\n`.repeat(200) }, agents + i)),
  ];
  let nextId = 1_000_000;
  const step = (agent, i) => {
    const id = ++nextId, ts = at(agents + commands + i);
    const kinds = ['user', 'assistant', 'tool', 'tool_result'];
    const kind = i === 0 ? 'user' : kinds[1 + (i - 1) % 3];
    const payload = kind === 'user' ? { kind, text: `측정 지시문 ${agent}` } : kind === 'assistant' ? { kind, text: `측정 서브 에이전트 글 ${agent} ${i}\n\n` + '분석 중인 내용을 정리합니다. '.repeat(6) }
      : kind === 'tool' ? { kind, toolUseId: `${agent}-t${i}`, name: 'Bash', input: { command: `grep -rn pattern src/${i}` } }
      : { kind, toolUseId: `${agent}-t${i - 1}`, isError: false, text: `src/${i}: match\n`.repeat(10) };
    return { id, session_id: 's0', task_id: 't0', subagent_id: agent, ts, kind, payload };
  };
  const history = new Map(list.filter(s => s.type === 'local_agent').map(s => [s.id, Array.from({ length: steps }, (_, i) => step(s.id, i))]));
  // 스레드에는 Agent 호출을 넣어 글 아래 칩을 그린다.
  const thread = [...base.data[0]];
  for (let i = 0; i < agents; i++) thread.splice(Math.min(thread.length, 3 + i * 2), 0,
    { id: 900_000 + i, session_id: 's0', task_id: 't0', ts: thread[0].ts, kind: 'tool', payload: { kind: 'tool', toolUseId: `call-${i}`, name: 'Agent', input: { description: `측정 서브 에이전트 ${i + 1}` } } });
  thread.sort((a, b) => a.id - b.id);
  const requests = { events: 0 };
  const respond = url => {
    const path = url.pathname;
    if (path === '/api/tasks/t0/events') {
      const after = Number(url.searchParams.get('after') ?? 0), ids = url.searchParams.get('ids')?.split(',').map(Number);
      if (ids) return { events: thread.filter(e => ids.includes(e.id)), more: false };
      return after ? { events: thread.filter(e => e.id > after), more: false, incremental: true } : { events: thread, more: false };
    }
    if (path === '/api/tasks/t0/subagents') return list;
    const match = /^\/api\/tasks\/t0\/subagents\/([^/]+)\/events$/.exec(path);
    if (match) { requests.events++; return { events: history.get(decodeURIComponent(match[1])) ?? [], more: false }; }
    // 데스크가 실행한 작업(source: app)에만 서브 에이전트 창이 열린다.
    if (path === '/api/state') { const state = base(url); return { ...state, tasks: state.tasks.map(t => t.id === 't0' ? { ...t, source: 'app' } : t) }; }
    return base(url);
  };
  respond.requests = requests;
  // 창이 다 그려졌다고 볼 조건: 컬럼 수, 서브 에이전트 컬럼마다의 글 수(지시문과 글), 명령 줄 수.
  respond.expected = { columns: agents + (commands ? 1 : 0), agentPosts: history.get('a0')?.filter(e => e.kind === 'user' || e.kind === 'assistant').length ?? 0, commandRows: commands, chips: agents };
  respond.streaming = false;
  let tick = 0;
  const running = list.filter(s => s.type === 'local_agent' && s.status === 'running');
  // 실행 중인 서브 에이전트에 단계를 하나씩 보내고, 다섯 번에 한 번 진행 보고를 함께 보낸다.
  respond.next = () => {
    if (!respond.streaming || !running.length) return [];
    const agent = running[tick % running.length];
    const event = step(agent.id, steps + tick);
    event.payload = { kind: 'assistant', text: `실시간 서브 에이전트 단계 ${++tick}` };
    event.kind = 'assistant';
    respond.last = { agent: agent.id, text: event.payload.text };
    const messages = [{ type: 'subagent_event', event }];
    if (tick % 5 === 0) messages.push({ type: 'subagent', subagent: { ...agent, usage: { ...agent.usage, toolUses: agent.usage.toolUses + tick }, updated_at: event.ts } });
    return messages;
  };
  return respond;
}
