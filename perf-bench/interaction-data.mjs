import { events } from './data.mjs';
// API 형식은 실제 App이 소비한다. 정의하지 않은 API는 실패시켜 계약 변경을 드러낸다.
export function interactionData(count, text = 'long', liveText = 'repeat', liveTasks = 10) {
  const project = { id: 'p', name: '측정', root_path: '/benchmark', created_at: '2026-01-01T00:00:00.000Z' };
  const data = Array.from({ length: 10 }, (_, i) => events(count, text).map((e, j) => ({ ...e, id: i * count + j + 1, task_id: `t${i}` })));
  const tasks = data.map((es, i) => ({ id: `t${i}`, project_id: 'p', project_name: project.name, title: `측정 작업 ${i}`, seq: i + 1,
    engine: 'claude', status: 'done', created_at: project.created_at, updated_at: project.created_at, last_event: es.at(-1), queued_messages: [] }));
  const respond = url => {
    const path = url.pathname;
    if (['/api/workspaces/ssh-requests', '/api/workspaces', '/api/runners', '/api/channels', '/api/skills', '/api/models', '/api/removals'].includes(path)) return [];
    if (path === '/api/settings') return { claude: { model: null, effort: null }, codex: { model: null, effort: null }, agy: { model: null, effort: null } };
    if (path === '/api/updates') return { phase: 'idle' };
    if (path === '/api/state') return { projects: [project], tasks, approvals: [], questions: [], channels: [], runner: { connected: true }, client: { local: true } };
    if (path === '/api/feed' || path === '/api/feed/count') {
      const ids = (url.searchParams.get('task') ?? '').split(',');
      const list = data.flat().filter(e => !ids[0] || ids.includes(e.task_id));
      if (path.endsWith('/count')) return { posts: list.length, tasks: ids[0] ? ids.length : 10 };
      const cursor = Number(url.searchParams.get('cursor_id') ?? Number.MAX_SAFE_INTEGER);
      return list.filter(e => e.id < cursor).slice(-Number(url.searchParams.get('limit') ?? 100));
    }
    return undefined;
  };
  // 다른 시나리오가 같은 작업의 글을 스레드로 다시 쓸 수 있게 한다(subagent-data.mjs).
  respond.data = data;
  let nextId = 10 * count, tick = 0;
  respond.next = () => {
    const index = tick++ % liveTasks;
    const event = { ...events(1, text)[0], id: ++nextId, task_id: `t${index}`, kind: 'assistant', ts: new Date(Date.UTC(2026, 0, 2) + tick * 100).toISOString() };
    if (liveText === 'unique') event.payload = { ...event.payload, text: event.payload.text + `\n\n실시간 고유 본문 ${nextId}` };
    data[index].push(event);
    tasks[index] = { ...tasks[index], status: 'running', last_event: event, updated_at: event.ts };
    return [{ type: 'event', event }, { type: 'task', task: tasks[index] }];
  };
  return respond;
}
