// Antigravity CLI sessions use ACP so native permission prompts can await a Desk decision.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgyAcp } from './agy-acp.ts';
import { join } from 'node:path';
import { MODE_LABEL, type PermissionMode, type ModelName } from '../../../shared/compose.ts';
import { config } from '../config.ts';
import { deskInstructions } from './instructions.ts';
import { steeringSkillText } from './skill-input.ts';
import { StderrTail, TurnQueue, clipResult, type StartEngine } from './engine.ts';
import { latestOfFamily, catalogModel, catalogProblem } from '../../../shared/model-catalog.ts';
import { runnerModelCatalogs } from './model-catalog.ts';
import { AgyChildren } from './agy-children.ts';
import type { BackgroundTask } from '../../../shared/protocol.ts';
import { AgySubagents } from './agy-subagents.ts';
import { AgyActivity } from './agy-activity.ts';
import type { RunnerEvent } from '../../../shared/protocol.ts';

const AGY_BIN = config.agyBin;
const APPROVAL_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_FAMILY: ModelName = 'flash';

type Json = any;

export class AgyModeError extends Error {
  readonly mode: PermissionMode;
  constructor(mode: PermissionMode, cause: unknown) {
    super(`AGY가 ${MODE_LABEL[mode]} 승인 모드를 적용하지 못했습니다. ${cause instanceof Error ? cause.message : String(cause)}. ${MODE_LABEL[mode]} 태그를 다시 보내세요. 실행이 중단됐다면 이어갈 지시도 함께 보내세요.`);
    this.mode = mode;
  }
  get detail() { return {mode:this.mode, phase:'failed', message:this.message}; }
}

/** An agy tool call as the desk shows it: commands as Bash, a file path where the call has one. */
export function toolView(name: string, args: Json): { name: string; input: Json } {
  const a = args && typeof args === 'object' ? { ...args } : {};
  const description = typeof a.toolSummary === 'string' ? a.toolSummary : undefined;
  delete a.toolSummary;
  if (name === 'run_command') {
    const {CommandLine: command, Cwd: cwd, ...extra} = a;
    return { name: 'Bash', input: { ...extra, command: command ?? '', cwd, description } };
  }
  const file = a.TargetFile ?? a.AbsolutePath ?? a.FilePath ?? a.File ?? a.Path;
  return { name, input: typeof file === 'string' ? { file_path: file, ...a } : { ...a, ...(description && { description }) } };
}

/** The model id for a family at a level, the newest version agy lists, e.g. flash + low → gemini-3.8-flash-low. */
export function agyModelId(ids: string[], family: string, lvl: string): string | undefined {
  const byFamily = ids.filter((id) => id.endsWith(`-${family}-${lvl}`)).map((id) => id.slice(0, -lvl.length - 1));
  const base = latestOfFamily(byFamily, family);
  return base && `${base}-${lvl}`;
}

/** Everything `root` started, deepest first, as ps shows it now. */
function descendants(root: number): number[] {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return []; }
  const kids = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const walk = (p: number) => { for (const c of kids.get(p) ?? []) { walk(c); found.push(c); } };
  walk(root);
  return found;
}

/**
 * Stops agy and what it started. agy runs each command in a session of its own (a terminal), which
 * outlives agy and a signal to its process group, so the commands are found first and signalled one
 * by one: SIGTERM, then SIGKILL for those still running a few seconds later.
 */
function stopTree(proc: ChildProcess, signal: NodeJS.Signals) {
  const pids = proc.pid ? descendants(proc.pid) : [];
  proc.kill(signal);
  const send = (sig: NodeJS.Signals) => { for (const pid of pids) { try { process.kill(pid, sig); } catch { /* already gone */ } } };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), 3000).unref();
}

/** A message waiting for its turn. */
interface Turn { text: string; skills?: string[]; skillSnapshotHome?: string }

interface Pending { answer(allow: boolean): void; timer: NodeJS.Timeout }

export const startAgy: StartEngine = (opts) => {
  const { sessionId, emit } = opts;
  const event = (e: RunnerEvent) => emit({ type: 'event', sessionId, event: e });
  let activeTools:BackgroundTask[] = [], activeChildren:BackgroundTask[] = [];
  const reportWork = () => emit({type:'background',sessionId,tasks:[...activeTools,...activeChildren]});
  const activity = new AgyActivity(tasks=>{activeTools=tasks;reportWork();});
  const subagents = opts.subagents ? new AgySubagents(sessionId,emit) : undefined;
  const children = new AgyChildren(tasks=>{activeChildren=tasks;reportWork();},undefined,subagents);
  let mode = opts.permissionMode;
  let modeVersion = 0;
  let family: ModelName = opts.model ?? DEFAULT_FAMILY;
  let effort = opts.effort;
  let selectedId: string | undefined;
  let selectionVersion = 0;
  let switching: Promise<void> = Promise.resolve();
  let selectionError: Error | undefined;
  let deliveryVersion = 0;
  const deferredSends = new Set<symbol>();
  /** The model id the running process uses; a different wanted one restarts it between turns. */
  let running: string | null = null;
  /** The model the feed last heard of. */
  let reported: string | undefined;
  let conversationId: string | null = opts.fork ? null : opts.resume ?? null;
  let child: ChildProcess | null = null;
  let closing = false;
  /** agy can't add to a running turn, so every message waits for the turn before it. */
  const turns = new TurnQueue<Turn>((turn) => void startTurn(turn), (busy) => emit({ type: 'busy', sessionId, busy }));
  const pending = new Map<string, Pending>();
  const stderrTail = new StderrTail();
  /** The last stderr lines, to add to a message about the process ending. */
  const tail = () => stderrTail.last(3).map((l) => `\n${l}`).join('');
  let acp: AgyAcp | undefined;
  let readySession: string | undefined;
  let appliedMode: typeof mode | undefined;
  let modeChange = Promise.resolve();
  let first = true;
  let prompting = false;
  let assistantText = '';
  const tools = new Map<string, string>();
  const flushText = () => {
    if (assistantText.trim()) event({ kind: 'assistant', text: assistantText });
    assistantText = '';
  };
  const cancelApprovals = () => {
    for (const [approvalId, request] of pending) {
      clearTimeout(request.timer);
      request.answer(false);
      emit({ type:'approval_cancelled', sessionId, approvalId });
    }
    pending.clear();
  };
  const turnEnded = (state: 'turn_done' | 'error' | 'interrupted', detail: Record<string, unknown>) => {
    if (!turns.active) return;
    prompting = false;
    flushText();
    if(state !== 'turn_done') {
      for (const id of tools.values()) event({kind:'tool_result',toolUseId:id,isError:true,text:'끝나지 않음'});
      tools.clear();
    }
    // Background requests can outlive the prompt that started them.
    activity.parentResult();
    event({ kind:'status', state, detail });
    turns.ended();
  };

  const permission = (rpc: AgyAcp, id: string | number, params: Json) => {
    const options: Json[] = Array.isArray(params.options) ? params.options : [];
    const once = (kind: string) => {
      const option = options.find(o => o?.kind === kind && typeof o.optionId === 'string' && o.optionId);
      return option && options.filter(o=>o?.optionId===option.optionId).length===1 ? option.optionId : undefined;
    };
    const allow = once('allow_once'), deny = once('reject_once');
    const answer = (approved: boolean) => {
      const choice = approved ? allow : deny;
      rpc.reply(id, {outcome: choice ? {outcome:'selected',optionId:choice} : {outcome:'cancelled'}});
    };
    const call = params.toolCall;
    if (!readySession || (params.sessionId !== readySession && !children.owns(params.sessionId)) || !call || !allow) { answer(false); return; }
    const approvalId = randomUUID();
    const timer = setTimeout(() => {
      if (!pending.delete(approvalId)) return;
      answer(false);
      emit({type:'approval_cancelled',sessionId,approvalId,reason:'expired'});
    }, APPROVAL_TIMEOUT_MS);
    timer.unref();
    pending.set(approvalId,{timer,answer});
    const view = toolView(call.name ?? call.kind ?? 'tool', call.rawInput ?? call.args);
    emit({type:'approval_request',sessionId,approvalId,toolName:view.name,input:{...view.input,title:call.title}});
  };

  const update = (u: Json) => {
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      assistantText += u.content.text;
      return;
    }
    if (!['tool_call','tool_call_update'].includes(u?.sessionUpdate) || typeof u.toolCallId !== 'string') return;
    flushText();
    const key = u.toolCallId;
    let useId = tools.get(key);
    if (!useId) {
      useId = randomUUID();
      tools.set(key,useId);
      const view = toolView(u.name ?? u.title ?? 'tool',u.rawInput ?? u.args);
      event({kind:'tool',toolUseId:useId,name:view.name,input:view.input});
    }
    children.observe(u);
    activity.acpTool(u);
    if (u.status !== 'completed' && u.status !== 'failed') return;
    const output = u.rawOutput ?? u.content?.map((c: Json) => c.content?.text ?? '').join('\n') ?? '';
    event({kind:'tool_result',toolUseId:useId,isError:u.status==='failed',text:clipResult(typeof output==='string'?output:JSON.stringify(output))});
    tools.delete(key);
  };

  const applyMode = async (rpc: AgyAcp, sessionId: string, requested: PermissionMode, version: number) => {
    try {
      await rpc.call('session/set_mode',{sessionId,modeId:requested});
    } catch (error) {
      if (rpc !== acp || closing) return;
      appliedMode = undefined;
      throw new AgyModeError(requested,error);
    }
    if (rpc !== acp || closing) return;
    appliedMode = requested;
    if (version === modeVersion) event({kind:'status',state:'mode',detail:{mode:requested,phase:'applied'}});
  };

  const processFor = async (model: string) => {
    if (acp && running === model && readySession) return acp;
    if (child) {
      if (activity.hasWork() || activeChildren.length || pending.size)
        throw new Error('백그라운드 작업과 승인 요청이 끝난 뒤 모델을 변경하세요');
      const old=child; child=null; acp?.close(); old.stdin?.end(); stopTree(old,'SIGTERM');
    }
    readySession=undefined;
    appliedMode=undefined;
    const env = {...process.env};
    delete env.AGENT_DESK_AGY_URL;
    delete env.AGENT_DESK_AGY_TOKEN;
    const proc = spawn(AGY_BIN,['acp'],{cwd:opts.cwd,stdio:'pipe',env});
    child=proc;
    running=model;
    stderrTail.clear();
    proc.stderr.on('data',(chunk:Buffer)=>stderrTail.push(chunk));
    const rpc = new AgyAcp(proc,(method,params,id)=>{
      if (child !== proc) return;
      if (id != null) {
        if (method==='session/request_permission') permission(rpc,id,params);
        else rpc.unsupported(id);
      } else if (method==='session/update' && readySession) {
        if(params.sessionId===readySession)update(params.update);
        else if(subagents && children.belongs(params.sessionId)){
          children.observeUpdate(params.sessionId,params.update);
          subagents.update(params.sessionId,params.update);
        }
      }
    });
    acp=rpc;
    const gone = (message:string) => {
      if (child!==proc) return;
      child=null; acp=undefined; readySession=undefined; running=null;
      if (!closing) { cancelApprovals(); turnEnded('error',{message}); }
    };
    proc.once('error',e=>gone(e.message));
    proc.once('exit',(code,signal)=>gone(`agy 종료 (code ${code ?? signal})${tail()}`));
    try {
      const init = await rpc.call('initialize',{protocolVersion:1,clientCapabilities:{}});
      if (init?.protocolVersion!==1) throw new Error('호환되는 agy ACP v1이 필요합니다');
      const params={cwd:opts.cwd,mcpServers:[]};
      const resumed=!!conversationId;
      if (conversationId) {
        if (!init.agentCapabilities?.sessionCapabilities?.resume && !init.agentCapabilities?.loadSession)
          throw new Error('이 agy 버전에서는 기존 세션을 재개할 수 없습니다');
        const method=init.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : 'session/load';
        await rpc.call(method,{...params,sessionId:conversationId});
      } else {
        const created=await rpc.call('session/new',params);
        if (typeof created?.sessionId!=='string' || !created.sessionId) throw new Error('agy 세션 ID가 없습니다');
        conversationId=created.sessionId;
        emit({type:'engine_session',sessionId,engineSessionId:created.sessionId});
      }
      await rpc.call('session/set_model',{sessionId:conversationId,modelId:model});
      let version: number;
      do {
        version=modeVersion;
        try {
          await applyMode(rpc,conversationId!,mode,version);
        } catch (error) {
          // A new request arrived while the initial RPC was pending. Apply that choice before prompting.
          if (version === modeVersion) throw error;
        }
        if (rpc !== acp || closing) throw new Error('agy 연결이 종료되었습니다');
      } while(version!==modeVersion);
      readySession=conversationId!;
      event({kind:'status',state:reported?'model_changed':'started',detail:{model,cwd:opts.cwd,resumed}});
      reported=model;
      return rpc;
    } catch(error) {
      if (error instanceof AgyModeError) event({kind:'status',state:'warning',detail:error.detail});
      if (child===proc) {child=null;acp=undefined;readySession=undefined;stopTree(proc,'SIGTERM');}
      rpc.close();
      throw error;
    }
  };

  const turnText = (turn: Turn) => {
    let text = turn.text || '(추가 지시 없음)';
    if (turn.skillSnapshotHome) text = steeringSkillText(text, turn.skills, turn.skillSnapshotHome);
    else if (turn.skills?.length && opts.skillsHome) {
      const files = turn.skills.map((s) => join(opts.skillsHome!, 'skills', s, 'SKILL.md')).join(', ');
      text = `[데스크 스킬] 이 메시지에는 먼저 다음 스킬 파일을 읽고 그 지침을 따르세요: ${files}\n\n${text}`;
    }
    if (first) { first = false; text = `[데스크 지침]\n${deskInstructions(opts.skillsHome, opts.instructions)}\n\n${text}`; }
    return text;
  };

  // Bumped per turn, so a turn interrupted while still looking up its model doesn't go on to run.
  let turnSeq = 0;
  /** Runs a turn; the queue calls it when the one before has ended. */
  const startTurn = async (turn: Turn) => {
    const seq = ++turnSeq;
    const current = () => !closing && turns.active && seq === turnSeq;
    try {
      const choice = family, wantedEffort = effort, version = selectionVersion;
      let model = selectedId;
      if (!model) {
        const catalog = await runnerModelCatalogs.read('agy');
        if (!catalog.updatedAt) throw new Error(catalog.error ?? 'agy 모델 목록을 확인하지 못했습니다');
        const problem = catalogProblem('agy',choice,wantedEffort,catalog);
        if (problem) throw new Error(problem);
        model = catalogModel(catalog,choice,wantedEffort)?.id;
        if (!model) throw new Error(`agy 모델 목록에 ${choice}이 없습니다`);
        if (version === selectionVersion) selectedId = model;
      }
      if (!current()) return;
      const proc = await processFor(model);
      if (!current()) return;
      let changing;
      do {
        changing = modeChange;
        await changing.catch(() => {});
      } while (changing !== modeChange && current());
      if (!current()) return;
      if (appliedMode !== mode) throw new Error(`승인 모드를 확인할 수 없어 입력을 실행하지 않았습니다. ${MODE_LABEL[mode]} 태그와 입력을 다시 보내세요.`);
      children.beforePrompt(readySession!);
      prompting = true;
      const result = await proc.call('session/prompt',{sessionId:readySession,prompt:[{type:'text',text:turnText(turn)}]});
      if (current()) turnEnded(result?.stopReason==='cancelled'?'interrupted':'turn_done',{subtype:result?.stopReason});
    } catch (err) {
      if (!current()) return;
      turnEnded('error', { message: `agy 요청 실패: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  if (opts.fork) {
    event({ kind: 'status', state: 'warning', detail: { message: 'agy는 대화 복제(#fork)를 지원하지 않아 새 대화로 시작합니다' } });
  }

  const send = (text: string, skills?: string[], _steer?: boolean, skillSnapshotHome?: string) => {
    if (closing) return;
    const version = deliveryVersion, token = Symbol();
    deferredSends.add(token);
    emit({ type: 'busy', sessionId, busy: true });
    // #now waits like #later (see turns).
    void switching.then(() => {
      deferredSends.delete(token);
      if (closing || version !== deliveryVersion) return;
      if (selectionError) {
        event({kind:'status',state:'error',detail:{message:`모델 변경을 적용하지 못해 입력을 실행하지 않았습니다: ${selectionError.message}`}});
        if (!turns.active) emit({type:'busy',sessionId,busy:false});
        return;
      }
      turns.push({ text, skills, skillSnapshotHome });
    });
  };
  send(opts.prompt, opts.skills, false, opts.skillSnapshotHome);

  const interrupt = async () => {
      deliveryVersion++;
      const deferred = deferredSends.size > 0;
      deferredSends.clear();
      turns.clear();
      const hadApprovals = pending.size > 0;
      cancelApprovals();
      // The process goes (its later output is dropped); the next message resumes the conversation.
      if (!turns.active && !activity.hasWork() && !activeChildren.length && !hadApprovals) {
        if (deferred) {
          event({kind:'status',state:'interrupted',detail:{subtype:'interrupted'}});
          emit({type:'busy',sessionId,busy:false});
        }
        return;
      }
      if (child) {
        const proc = child;
        child = null;
        running = null; acp?.close(); acp=undefined; readySession=undefined;
        stopTree(proc, 'SIGINT');
      }
      subagents?.close(); activity.reset(); children.reset();
      // Without a process the turn was still starting; startTurn sees it ended and stops there.
      turnEnded('interrupted', { subtype: 'interrupted' });
  };

  return {
    send,
    interrupt,
    setMode: (m) => {
      mode = m;
      const version = ++modeVersion;
      const rpc = acp, session = readySession;
      modeChange = modeChange.catch(()=>{}).then(async () => {
        if (version !== modeVersion || !rpc || !session || rpc !== acp || session !== readySession) return;
        try {
          await applyMode(rpc,session,m,version);
        } catch (error) {
          if (version !== modeVersion) return;
          if (m === 'default' && rpc === acp && (prompting || activity.hasWork() || activeChildren.length))
            await interrupt();
          throw error;
        }
      });
      return modeChange;
    },
    // Takes effect from the next turn, which restarts the process on the new model.
    setModel: (m, e) => {
      const pending = switching.then(async () => {
        const choice = m ?? family, wantedEffort = e ?? effort;
        const fresh = await runnerModelCatalogs.read('agy');
        const base = !m && selectedId ? selectedId.replace(/-(low|medium|high|xhigh|max|ultra)$/,'') : undefined;
        const catalog = base ? {...fresh,models:fresh.models.filter(model=>model.id.startsWith(`${base}-`))} : fresh;
        const problem = catalogProblem('agy',choice,wantedEffort,catalog);
        if (problem) throw new Error(problem);
        const model = catalogModel(catalog,choice,wantedEffort);
        if (!model) throw new Error(catalog.error ?? 'agy 모델 목록을 확인하지 못했습니다');
        family = choice; effort = wantedEffort; selectedId = model.id; selectionVersion++; selectionError = undefined;
      });
      switching = pending.catch(error => { selectionError = error instanceof Error ? error : new Error(String(error)); });
      return pending;
    },
    resolveApproval: (approvalId, allow) => {
      const p = pending.get(approvalId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(approvalId);
      p.answer(allow);
    },
    close: () => {
      if (closing) return;
      closing = true; deliveryVersion++; deferredSends.clear();
      cancelApprovals();
      acp?.close(); children.reset();
      if (child) { child.stdin?.end(); stopTree(child, 'SIGTERM'); }
      child = null;
    },
  };
};
