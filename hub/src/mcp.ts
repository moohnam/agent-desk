import { codeContext } from './code-context.ts';
import { MAX_PROMPT_TEMPLATES_BODY, readPromptTemplates, savePromptTemplates } from './prompt-templates.ts';
import { signRequest, toolFields } from './request-proof.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { MAX_BODY, readBody } from './body.ts';
import type { AgentRequest } from './db.ts';
import type { TaskView } from '../../shared/api.ts';
import { ENGINES, HANDOFF_ENGINES } from '../../shared/compose.ts';
import { HttpError } from './errors.ts';
import { expandHome } from './paths.ts';
import type { Hub } from './hub.ts';

/**
 * MCP server (Streamable HTTP, JSON responses only) through which a terminal Claude Code or Codex
 * session attaches its work to the desk: it reports progress and asks the user questions, and the
 * app only answers. Terminal sessions may register it globally as `agent-desk`; the app starts
 * managed engine sessions with a separate `agent-desk-runtime` namespace.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** desk_ask / desk_wait_answer hold the request at most this long, then tell the agent to call again. */
const MAX_WAIT_SEC = 600;
const DEFAULT_WAIT_SEC = 300;

/** Most requests one JSON-RPC batch may carry. */
const MAX_BATCH = 32;

const INSTRUCTIONS = `Agent Desk: 사용자가 여러 에이전트 작업을 한 화면에서 보는 데스크입니다.
데스크에 붙거나 넘기는 일은 사용자가 "데스크에 붙어", "데스크에 올려", /desk 처럼 명시적으로 요청할 때만 하세요. 요청 없이 먼저 붙지 마세요.
1. desk_attach로 지금까지 한 일과 현재 하려는 일을 요약해 붙고, 받은 task_id를 기억합니다.
2. 의미 있는 진행이 있을 때 desk_post로 짧게 알리고, 큰 단계가 끝나면 desk_checkpoint로 정리합니다.
3. 사용자 판단이 필요하면 desk_ask로 묻고 답을 기다립니다. "아직 답 없음"이 오면 desk_wait_answer를 다시 호출합니다.
4. 작업을 마치면 desk_finish를 호출합니다.
사용자가 이 세션을 데스크로 "넘겨", "옮겨", "가져가"라고 하면 desk_handoff를 씁니다. 세션 ID는 Claude Code면 \`echo $CLAUDE_CODE_SESSION_ID\`, Codex면 \`echo $CODEX_THREAD_ID\`로 얻습니다(비어 있으면 생략). 넘긴 뒤에는 이 터미널 세션을 더 진행하지 말고 종료하라고 사용자에게 알립니다.
다른 프로젝트나 작업의 에이전트에게 알아볼 것이 있으면 desk_request로 물을 수 있습니다. 사용자가 그 대상을 @로 언급했으면 바로 전달되고, 아니면 사용자 승인을 거칩니다. 묻는 쪽은 데스크에 붙은 작업이면 task_id를, 데스크가 실행한 작업이면 session_id에 세션 ID(위와 같은 환경 변수)를 넘깁니다. 접수 후 자동 재개가 표시되면 턴을 끝내도 됩니다. 직접 조회는 desk_wait_answer를 씁니다. 받은 문의에는 desk_reply로 요청 ID를 지정해 답합니다.
데스크에 쓰는 글은 한국어로 씁니다.`;

const str = (description: string) => ({ type: 'string', description });

const TOOLS = [
  {
    name:'desk_settings',
    description:'코드 검토 설정을 조회·변경합니다. section=code_context는 현재 작업의 Git worktree 연결(생성·삭제 아님), section=prompt_templates는 연결한 작업공간의 별도 프롬프트 템플릿입니다. 먼저 action=read로 revision을 읽고 action=save로 저장합니다. 코드 연결은 session_id 또는 데스크에 붙은 task_id가 필요합니다. worktree=null은 연결 해제입니다. 템플릿 items는 전체 목록이며 삭제할 항목만 제외하고 기존 항목을 보존하세요. 모델·승인 모드는 변경하지 않습니다.',
    inputSchema:{type:'object',required:['section','action'],properties:{
      section:{type:'string',enum:['code_context','prompt_templates']},action:{type:'string',enum:['read','save']},
      session_id:str('현재 엔진 세션 ID'),task_id:str('데스크에 붙은 작업 ID'),revision:str('직전 조회의 revision'),
      worktree:{type:['string','null'],description:'available 목록의 절대 경로 또는 연결 해제용 null'},
      items:{type:'array',items:{type:'object',required:['id','name','text'],properties:{id:str('변하지 않는 고유 ID'),name:str('표시 이름'),text:str('프롬프트 내용')}}},
    }},
  },
  {
    name: 'desk_attach',
    description: '현재 작업을 데스크에 작업으로 등록하고 task_id를 받습니다. 사용자가 데스크에 붙으라고 요청했을 때만 호출하세요. 같은 작업에 다시 붙을 때는 task_id를 넘깁니다.',
    inputSchema: {
      type: 'object', required: ['title', 'summary', 'cwd'],
      properties: {
        title: str('작업 제목 (짧게)'),
        summary: str('지금까지 한 일과 현재 하려는 일 요약 (마크다운)'),
        cwd: str('작업 디렉터리 절대 경로'),
        engine: { type: 'string', enum: ENGINES, description: '이 세션의 에이전트 종류' },
        task_id: str('이전에 받은 task_id로 다시 붙을 때'),
      },
    },
  },
  {
    name: 'desk_post',
    description: '붙은 작업에 진행 상황을 한 글로 남깁니다.',
    inputSchema: { type: 'object', required: ['task_id', 'text'], properties: { task_id: str('desk_attach가 준 task_id'), text: str('마크다운 본문') } },
  },
  {
    name: 'desk_checkpoint',
    description: '큰 단계가 끝났을 때 상태와 다음 단계를 체크포인트로 남깁니다.',
    inputSchema: {
      type: 'object', required: ['task_id', 'summary'],
      properties: {
        task_id: str('desk_attach가 준 task_id'), summary: str('현재 상태 요약 (마크다운)'),
        next_steps: { type: 'array', items: { type: 'string' }, description: '다음 단계 목록' },
      },
    },
  },
  {
    name: 'desk_ask',
    description: '사용자에게 질문하고 데스크에서 답이 올 때까지 기다립니다. 시간 안에 답이 없으면 question_id를 돌려주니 desk_wait_answer로 계속 기다리세요.',
    inputSchema: {
      type: 'object', required: ['task_id', 'question'],
      properties: {
        task_id: str('desk_attach가 준 task_id'), question: str('질문 (마크다운, 선택지가 있으면 함께)'),
        timeout_sec: { type: 'number', description: `기다릴 최대 초 (기본 ${DEFAULT_WAIT_SEC}, 최대 ${MAX_WAIT_SEC})` },
      },
    },
  },
  {
    name: 'desk_wait_answer',
    description: 'desk_ask나 desk_request로 한 질문의 답을 계속 기다립니다.',
    inputSchema: {
      type: 'object', required: ['question_id'],
      properties: { question_id: str('desk_ask나 desk_request가 준 question_id'), timeout_sec: { type: 'number', description: `기다릴 최대 초 (기본 ${DEFAULT_WAIT_SEC})` } },
    },
  },
  {
    name: 'desk_request',
    description: '다른 작업의 에이전트에게 질문합니다. 승인된 질문은 연결된 지원 엔진의 실행 중인 턴에 즉시 전달됩니다. 기본적으로 즉시 question_id와 재개 방법을 돌려줍니다. 사용자가 대상을 @로 언급하지 않았으면 먼저 승인받습니다.',
    inputSchema: {
      type: 'object', required: ['to', 'question'],
      properties: {
        to: str('묻는 대상: @프로젝트(그 프로젝트에서 데스크가 실행하는 최근 작업), @프로젝트#번호, 또는 task_id. desk_list_tasks로 찾을 수 있습니다'),
        question: str('질문 (마크다운). 대상은 이 대화를 모르니 필요한 맥락을 함께 씁니다'),
        task_id: str('묻는 쪽이 데스크에 붙은 작업이면 desk_attach가 준 task_id'),
        session_id: str('묻는 쪽이 데스크가 실행한 작업이면 이 세션의 ID. Claude Code: $CLAUDE_CODE_SESSION_ID, Codex: $CODEX_THREAD_ID'),
        timeout_sec: { type: 'number', description: `직접 기다릴 때만 지정할 초 (최대 ${MAX_WAIT_SEC}). 생략하면 비동기로 접수합니다.` },
      },
    },
  },
  {
    name: 'desk_reply',
    description: '다른 작업에서 받은 질문에 요청 ID별로 답합니다. 현재 대상 세션의 ID를 함께 보내야 합니다. 실행 중인 원래 작업은 계속할 수 있습니다.',
    inputSchema: { type: 'object', required: ['question_id', 'answer', 'session_id'], properties: {
      question_id: str('받은 문의의 요청 ID'), answer: str('질문한 에이전트에게 보낼 답변'),
      session_id: str('현재 대상 세션 ID. Claude Code: $CLAUDE_CODE_SESSION_ID, Codex: $CODEX_THREAD_ID'),
    } },
  },
  {
    name: 'desk_finish',
    description: '붙은 작업을 끝냅니다. 남은 질문은 취소됩니다.',
    inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: str('desk_attach가 준 task_id'), summary: str('최종 결과 요약') } },
  },
  {
    name: 'desk_handoff',
    description: '이 터미널 세션을 데스크로 넘깁니다. 데스크가 같은 대화를 이어 가는 작업을 만들고, 지금까지의 대화(도구 호출은 이름만)를 스레드에 옮깁니다. 사용자가 넘기라고 요청했을 때만 호출하세요. 넘긴 뒤 이 세션은 종료해야 합니다.',
    inputSchema: {
      type: 'object', required: ['engine', 'cwd'],
      properties: {
        engine: { type: 'string', enum: [...HANDOFF_ENGINES], description: '이 세션의 에이전트 종류' },
        session_id: str('이 세션의 ID. Claude Code: $CLAUDE_CODE_SESSION_ID, Codex: $CODEX_THREAD_ID. 없으면 cwd에서 가장 최근 세션을 씁니다'),
        cwd: str('작업 디렉터리 절대 경로'),
        title: str('작업 제목 (짧게)'),
        summary: str('지금까지 한 일과 남은 일 요약 (마크다운). 데스크에서 이어 받을 사람이 읽습니다'),
        task_id: str('desk_attach로 이미 붙은 작업이면 그 task_id. 그 작업이 데스크 작업으로 바뀝니다'),
      },
    },
  },
  {
    name: 'desk_list_tasks',
    description: '데스크의 작업 목록을 봅니다. cwd를 주면 그 디렉터리를 포함하는 프로젝트의 작업만 보여 줍니다. 이전 작업에 다시 붙을 task_id를 찾을 때 씁니다.',
    inputSchema: { type: 'object', properties: { cwd: str('작업 디렉터리 절대 경로') } },
  },
];

/** Keep the runner-managed Codex namespace usable despite stale per-server filters. */
export const DESK_TOOL_NAMES = TOOLS.map(tool => tool.name);

const PROMPTS = [{
  name: 'desk',
  description: '현재 작업을 Agent Desk에 붙입니다',
  arguments: [{ name: 'note', description: '데스크에 함께 남길 메모', required: false }],
}];

interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }
export const readMcpBody = (req: IncomingMessage) => readBody(req,MAX_PROMPT_TEMPLATES_BODY,body => {
  const rpc = body as RpcRequest | null;
  return rpc?.method === 'tools/call' && rpc.params?.name === 'desk_settings'
    && rpc.params.arguments?.section === 'prompt_templates' && rpc.params.arguments?.action === 'save'
    ? MAX_PROMPT_TEMPLATES_BODY : MAX_BODY;
});

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const waitSec = (v: unknown, fallback = DEFAULT_WAIT_SEC) => Math.min(Math.max(Number(v) || fallback, 1), MAX_WAIT_SEC);

function taskLine(t: TaskView) {
  return `- ${t.id} [${t.status}${t.source === 'external' ? ', 터미널' : ''}] @${t.project_name} › ${t.title} (갱신 ${t.updated_at})`;
}

async function callTool(hub: Hub, name: string, a: Record<string, any>, signal: AbortSignal, resumeToken?: unknown, authorize?:()=>void, shared=false) {
  switch (name) {
    case 'desk_settings': {
      if(a.action!=='read'&&a.action!=='save')throw new HttpError(400,'action은 read 또는 save입니다');
      if(a.section==='prompt_templates'){
        authorize?.();return text(JSON.stringify(a.action==='read'?readPromptTemplates(hub.store):savePromptTemplates(hub.store,{revision:a.revision,items:a.items})));
      }
      if(a.section!=='code_context')throw new HttpError(400,'지원하지 않는 설정입니다');
      const session = typeof a.session_id === 'string' ? hub.store.sessionByEngineId(a.session_id) : undefined;
      const taskId = session?.task_id ?? (typeof a.task_id === 'string' ? a.task_id : undefined);
      if (!taskId) throw new HttpError(404,'현재 작업의 session_id 또는 task_id가 필요합니다');
      if ((a.session_id !== undefined && !session) || (session && a.task_id !== undefined && session.task_id !== a.task_id)) {
        throw new HttpError(403,'작업과 엔진 세션이 일치하지 않습니다');
      }
      const fields = toolFields(name,a);
      const authorizeContext = () => {
        authorize?.();
        const current = hub.store.latestSession(taskId);
        if (session) {
          if (current?.id !== session.id || !hub.requests.proven(session,fields,resumeToken)) {
            throw new HttpError(403,'현재 엔진 세션을 확인할 수 없습니다');
          }
        } else if (current?.source !== 'external') {
          throw new HttpError(403,'데스크가 실행한 작업은 session_id를 사용하세요');
        }
      };
      authorizeContext();
      return text(JSON.stringify(await codeContext(hub,taskId,a.action==='save'?{revision:a.revision,worktree:a.worktree}:undefined,authorizeContext,shared)));
    }
    case 'desk_attach': {
      const t = hub.external.attachExternal({ title: a.title, summary: a.summary, cwd: a.cwd, engine: a.engine, taskId: a.task_id });
      return text(`데스크에 붙었습니다. task_id: ${t.id} (프로젝트 @${t.project_name}). 이후 호출에 이 task_id를 쓰세요.`);
    }
    case 'desk_post':
      hub.external.postExternal(a.task_id, a.text);
      return text('게시했습니다.');
    case 'desk_checkpoint':
      hub.external.checkpoint(a.task_id, a.summary, Array.isArray(a.next_steps) ? a.next_steps.map(String) : []);
      return text('체크포인트를 남겼습니다.');
    case 'desk_ask': {
      const q = hub.external.ask(a.task_id, a.question);
      return answerResult(await hub.external.waitAnswer(q.id, waitSec(a.timeout_sec) * 1000, signal));
    }
    case 'desk_wait_answer': {
      const ms = waitSec(a.timeout_sec) * 1000;
      if (hub.store.getRequest(a.question_id)) return requestResult(hub, await hub.requests.waitRequest(a.question_id, ms, signal));
      return answerResult(await hub.external.waitAnswer(a.question_id, ms, signal));
    }
    case 'desk_request': {
      const r = hub.atomic(() => hub.requests.request({ to: a.to, text: a.question, fromTaskId: a.task_id, sessionId: a.session_id, resumeProof: a.timeout_sec === undefined ? resumeToken : undefined }));
      if (a.timeout_sec === undefined) return requestResult(hub,r);
      return requestResult(hub, await hub.requests.waitRequest(r.id, waitSec(a.timeout_sec) * 1000, signal));
    }
    case 'desk_reply': {
      hub.requests.replyRequest(a.question_id, a.answer, a.session_id,resumeToken);
      return text('답변을 저장했습니다.');
    }
    case 'desk_finish':
      hub.external.finishExternal(a.task_id, a.summary);
      return text('작업을 종료했습니다.');
    case 'desk_handoff': {
      const r = hub.external.handoff({ engine: a.engine, sessionId: a.session_id, cwd: a.cwd, title: a.title, summary: a.summary, taskId: a.task_id });
      if (r.already) return text(`이미 데스크가 이어 가는 세션입니다. task_id: ${r.task.id} (@${r.task.project_name} › ${r.task.title})`);
      return text(`데스크로 넘겼습니다. task_id: ${r.task.id} (@${r.task.project_name} › ${r.task.title}), 세션 ${r.sessionId}, 기록 ${r.imported}건. 이제 데스크에서 이 대화를 이어 갑니다. 사용자에게 이 터미널 세션을 종료하라고 알리고, 더 진행하지 마세요.`);
    }
    case 'desk_list_tasks': {
      const projects = a.cwd ? new Set(hub.store.projectsContaining(resolve(expandHome(String(a.cwd)))).map((p) => p.id)) : null;
      const tasks = hub.state().tasks.filter((t) => !projects || projects.has(t.project_id)).slice(0, 50);
      return text(tasks.length ? tasks.map(taskLine).join('\n') : '작업이 없습니다.');
    }
    default:
      throw new RpcError(-32602, `알 수 없는 도구: ${name}`);
  }
}

function answerResult(q: { id: string; status: string; answer: string | null }) {
  if (q.status === 'answered') return text(`사용자 답변:\n${q.answer}`);
  if (q.status === 'cancelled') return text('질문이 취소되었습니다.');
  return text(`아직 답이 없습니다. desk_wait_answer(question_id: "${q.id}")로 계속 기다리세요.`);
}

const REQUEST_WAITING: Record<string, string> = { approval: '사용자 승인 대기', queued: '대상 작업이 하던 턴을 마치기를 대기', running: '대상 에이전트가 답하는 중' };

function requestResult(hub: Hub, r: AgentRequest) {
  const to = hub.store.getTask(r.to_task_id);
  const who = to ? `@${hub.store.getProject(to.project_id)?.name ?? '?'}#${to.seq}` : '대상';
  const state = hub.requests.resumeState(r.id);
  const resume: Record<string,string> = {pending:'후속 작업 전달 대기',sent:'러너 수신 확인 대기',received:'러너 수신 · 실행 확인 대기',
    uncertain:'실행 여부 미확인',held:'러너 수신 · 실행 여부 미확인',started:'후속 턴 시작',cancelled:'자동 재개 해제'};
  const suffix = state && resume[state] ? '\n\n' + resume[state] : '';
  if (r.status === 'answered') return text(`${who} 에이전트의 답:\n${r.answer}${suffix}`);
  if (r.status === 'denied' || r.status === 'failed') return text(r.answer ?? '답을 받지 못했습니다.');
  return text(`아직 답이 없습니다 (${REQUEST_WAITING[r.status] ?? r.status}). question_id: "${r.id}". ${hub.requests.resumeState(r.id) === 'waiting' ? '턴을 끝내도 결과가 오면 이 작업이 이어집니다.' : 'desk_wait_answer로 결과를 조회하세요.'}`);
}

async function dispatch(hub: Hub, req: RpcRequest, signal: AbortSignal, resumeToken?: unknown, authorize?:()=>void, shared=false): Promise<unknown> {
  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'agent-desk', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = req.params ?? {};
      try {
        return await callTool(hub, name, args, signal,resumeToken,authorize,shared);
      } catch (err) {
        if (err instanceof RpcError) throw err;
        // Tool failures go back to the model as results it can act on.
        return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
      }
    }
    case 'prompts/list':
      return { prompts: PROMPTS };
    case 'prompts/get': {
      if (req.params?.name !== 'desk') throw new RpcError(-32602, `알 수 없는 프롬프트: ${req.params?.name}`);
      const note = req.params?.arguments?.note;
      return {
        description: PROMPTS[0].description,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `agent-desk MCP의 desk_attach로 지금 작업을 데스크에 붙여 주세요. 지금까지 한 일과 현재 하려는 일을 요약하고, 이후 진행은 desk_post, 판단이 필요하면 desk_ask, 끝나면 desk_finish를 써 주세요.${note ? `\n메모: ${note}` : ''}`,
          },
        }],
      };
    }
    default:
      throw new RpcError(-32601, `method not found: ${req.method}`);
  }
}

async function handleOne(hub: Hub, req: RpcRequest, signal: AbortSignal, resumeToken?: unknown, authorize?:()=>void, shared=false) {
  // Notifications (no id) get no response.
  const isNotification = req.id === undefined;
  try {
    if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string') throw new RpcError(-32600, 'invalid request');
    const result = await dispatch(hub, req, signal,resumeToken,authorize,shared);
    return isNotification ? null : { jsonrpc: '2.0', id: req.id, result };
  } catch (err) {
    if (isNotification) return null;
    const code = err instanceof RpcError ? err.code : err instanceof HttpError ? -32602 : -32603;
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code, message: err instanceof Error ? err.message : String(err) } };
  }
}

export async function handleMcp(hub: Hub, req: IncomingMessage, res: ServerResponse, authorize?: () => void, shared=false) {
  if (req.method !== 'POST') {
    // No server-initiated stream: every response comes back on its POST.
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  let body: RpcRequest | RpcRequest[];
  const fail = (status: number, code: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
  };
  try { body = await readMcpBody(req) as RpcRequest | RpcRequest[]; }
  catch (err) {
    if (err instanceof HttpError && err.status !== 400) return fail(err.status, -32600, err.message);
    return fail(400, -32700, 'parse error');
  }
  try { authorize?.(); }
  catch (err) { return fail(err instanceof HttpError ? err.status : 500, -32600, err instanceof Error ? err.message : String(err)); }
  if (body === undefined) return fail(400, -32600, 'invalid request');
  if (Array.isArray(body) && (!body.length || body.length > MAX_BATCH)) return fail(400, -32600, `배치는 1~${MAX_BATCH}개만 받습니다`);
  // A client giving up on a long desk_ask releases its waiter.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((r) => {
    const params = r?.params as {name?:string;arguments?:Record<string,unknown>} | undefined;
    const proof = signRequest(req.headers?.['x-desk-session'],toolFields(params?.name??'',params?.arguments??{})) ?? req.headers?.['x-desk-request-proof'];
    return handleOne(hub,r,abort.signal,proof,authorize,shared);
  })))
    .filter((r) => r !== null);
  if (!replies.length) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
}
