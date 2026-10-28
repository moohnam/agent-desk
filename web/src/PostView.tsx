import { ChevronRight, PenLine } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { ENGINE_LABEL, ENGINE_SHORT, MODE_LABEL, MODEL_LABEL, REQUEST_TOOL, engineOf, type ModelName, type PermissionMode } from '../../hub/src/compose.ts';
import { api } from './api.ts';
import { AskCard, isAsk } from './AskCard.tsx';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';
import { relTime, toolSummary } from './format.ts';
import { LongText, Markdown } from './Markdown.tsx';
import { modelShort } from './projects.ts';
import type { Approval, HubEvent, Post, Question, TaskView } from './types.ts';

interface Props {
  post: Post;
  task: TaskView | undefined;
  model: string | undefined;
  approval: Approval | undefined;
  /** The still-unanswered question a question post asks, if any. */
  question?: Question;
  colId: string;
  selected: boolean;
  /** Its task holds unsent text in a reply or answer box. */
  draft?: boolean;
  expanded: boolean;
  working: boolean;
  flash: boolean;
  inThread?: boolean;
  /** Draw the conversation line to the post above / below. */
  up?: boolean;
  down?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onAllow: () => void;
  onDeny: () => void;
  /** Clicking the post (outside its controls) opens its thread; unset inside the thread. */
  onOpenThread?: () => void;
  onError?: (msg: string) => void;
  /** Context reset (컨텍스트 재구성) is picking posts: whether this one is picked; unset when it can't be. */
  picked?: boolean;
  onPick?: () => void;
  /** Changes every clock tick, so the relative time stays fresh in a post that is otherwise unchanged. */
  tick?: number;
}

const ENGINE_NAME: Record<string, string> = ENGINE_LABEL;

/** Everything except my own posts is said by the task's engine. */
function author(post: Post, task: TaskView | undefined) {
  // A question another task's agent asked through the desk (desk_request).
  if (post.kind === 'user' && post.event.payload.request) return `@${post.event.payload.request.from}`;
  if (post.kind === 'user') return '나';
  const engine = task?.engine ?? 'claude';
  return ENGINE_NAME[engine] ?? engine;
}

/** @mentions and #tags in my own posts stand out, as in the compose box. */
/** Opens a local link from a post through the hub. A hub without the route still hands app URLs to the browser. */
const openLink = (taskId: string, onError?: (msg: string) => void) => (href: string) =>
  api.open(href, taskId).catch((e: Error) => {
    if (e.message.startsWith('no route') && /^(akb|lectern):/i.test(href)) window.location.href = href;
    else onError?.(e.message);
  });

function richText(text: string) {
  return text.split(/((?:^|\s)[@#][^\s]+)/g).map((part, i) =>
    /^\s?[@#]/.test(part) ? <span key={i} className="mention">{part}</span> : part);
}

/**
 * Whether a post would draw the same. Posts are rebuilt whenever their column gets an event, so
 * they are compared by what they show; the task only by its engine (a task changes with each of its
 * events). Handlers are not compared: the caller routes them through its latest state (renderPost).
 */
function samePost(a: Props, b: Props): boolean {
  const x = a.post, y = b.post;
  if (x !== y && (x.id !== y.id || x.kind !== y.kind || x.event !== y.event || x.resolution !== y.resolution
    || x.parent?.kind !== y.parent?.kind || x.activity.length !== y.activity.length
    || x.activity.some((e, i) => e !== y.activity[i]))) return false;
  if ((a.task?.engine ?? null) !== (b.task?.engine ?? null)) return false;
  for (const k of ['model', 'approval', 'question', 'colId', 'selected', 'expanded', 'working', 'flash', 'inThread', 'up', 'down', 'tick', 'draft'] as const) {
    if (a[k] !== b[k]) return false;
  }
  return !a.onOpenThread === !b.onOpenThread;
}

export const PostView = memo(PostViewInner, samePost);

function PostViewInner(props: Props) {
  const { post, task, model, approval, question, selected, expanded, working, flash, inThread, up, down } = props;
  const p = post.event.payload;
  const onLocalLink = useMemo(() => openLink(post.taskId, props.onError), [post.taskId, props.onError]);
  // Keep the body element stable across selection, clock and unrelated task updates.
  // Markdown parsing and clamped-height measurement then only run for changed content.
  const body = useMemo(() => post.kind === 'alert' ? (
    <>{p.detail?.message ?? '작업이 중단되었습니다.'}
      {Array.isArray(p.detail?.texts) && <ul className="dropped">{p.detail.texts.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>}</>
  ) : post.kind === 'assistant' ? <Markdown text={p.text} onLocalLink={onLocalLink} />
    : richText(String(p.text ?? '')), [post.kind, p, onLocalLink]);
  const engine = task?.engine ?? 'claude';
  const avatar = post.kind === 'user' && p.request ? ['user', '⇄'] : post.kind === 'user' ? ['user', '나'] : post.kind === 'alert' ? ['alert', '!']
    : [engine, ENGINE_SHORT[engineOf(engine)]];
  const tag = post.kind === 'approval' ? <span className="tag">{isAsk(p.toolName) ? '질문' : '승인 요청'}</span>
    : post.kind === 'question' ? <span className="tag">질문</span>
    : post.kind === 'alert' ? (p.state === 'interrupted' ? <span className="tag stop">중단됨</span>
      : p.state === 'queue_dropped' ? <span className="tag stop">대기 취소</span> : <span className="tag err">오류</span>)
    : post.kind === 'user' && p.handoff === 'request' ? <span className="tag via" title="컨텍스트 재구성: 새 세션에 넘길 정리본을 에이전트에게 요청">정리본 요청</span>
    : post.kind === 'user' && p.handoff === 'reset' ? <span className="tag via" title="이전 대화를 비우고 이 메시지 하나로 새 세션을 시작함">컨텍스트 재구성</span>
    : post.kind === 'user' && p.request ? <span className="tag via" title="다른 작업의 에이전트가 데스크를 통해 물음. 이번 턴의 마지막 응답이 답으로 전달됩니다">에이전트 질문</span>
    : post.kind === 'user' && p.delivery === 'now' ? <span className="tag via" title="실행 중인 턴에 끼워넣음">#now</span>
    : post.kind === 'user' && p.delivery === 'later' && p.queued_at ? <span className="tag via" title="턴이 끝나기를 기다렸다가 보냄">#later</span>
    // 'bg': what #fork was called before.
    : post.kind === 'user' && (p.delivery === 'fork' || p.delivery === 'bg') ? <span className="tag via" title={`포크: ${p.forked_from?.title ?? ''}`}>#fork</span>
    : post.kind === 'user' && p.delivery === 'new' ? <span className="tag via" title="같은 프로젝트의 새 작업">#new</span>
    : null;
  // Like Twitter, say whom a post answers unless that post is drawn right above it.
  const replyTo = !up && post.parent ? author(post.parent, task) : null;
  const cls = ['post', post.kind, up && 'chain-up', down && 'chain-down', selected && 'selected', flash && 'flash'];

  return (
    <article className={cls.filter(Boolean).join(' ')} data-post={post.id} data-col={props.colId}
      onClick={(e) => {
        // In the thread a click is for reading and copying text: it neither selects the post nor
        // scrolls. j/k still move the selection there.
        if (props.inThread) return;
        props.onSelect();
        // A click opens the thread, unless it hit a control in the post or ended a text selection.
        if ((e.target as HTMLElement).closest('a, button, input, textarea, select, summary, label')) return;
        if (window.getSelection()?.toString()) return;
        props.onOpenThread?.();
      }}>
      <div className="av-wrap"><div className={`av ${avatar[0]}`}>{avatar[1]}</div></div>
      <div className="main">
        <div className="ph">
          <span className="name">{author(post, task)}</span>
          {post.kind !== 'user' && model && <span className="handle">{modelShort(model)}</span>}
          {tag}
          {props.draft && <span className="draft-badge" title="이 작업에 보내지 않은 답글이 있습니다 (이 기기에 저장됨)"><PenLine /> 작성 중</span>}
          <span className="spacer" />
          <time className="time" dateTime={post.event.ts} title={new Date(post.event.ts).toLocaleString('ko-KR')}>
            {relTime(post.event.ts)}
          </time>
        </div>
        {replyTo && <div className="replying">↳ <b>@{replyTo}</b>에게 답글</div>}
        {post.kind === 'user' && p.request && <div className="replying">⇄ “{p.request.title}”의 에이전트가 물음</div>}
        {post.kind === 'user' && p.handoff === 'reset' && <div className="replying">↻ 새 세션: 이전 대화 없이 이 정리본으로 이어 갑니다</div>}
        {post.kind === 'user' && p.forked_from && <div className="replying">⑂ {p.forked_from.seq ? `#${p.forked_from.seq} ` : ''}“{p.forked_from.title}”에서 포크</div>}

        {post.kind === 'approval' && isAsk(p.toolName) ? (
          <AskCard post={post} approval={approval} onError={props.onError} />
        ) : post.kind === 'approval' ? (
          <ApprovalCard post={post} approval={approval} expanded={expanded} onAllow={props.onAllow} onDeny={props.onDeny} />
        ) : post.kind === 'question' ? (
          <QuestionCard post={post} question={question} full={!!inThread || expanded}
            onToggle={inThread ? undefined : props.onToggle} onError={props.onError} />
        ) : (
          <LongText full={!!inThread || expanded} className={`body${post.kind === 'assistant' ? ' md' : ''}`}
            onToggle={inThread ? undefined : props.onToggle}>
            {body}
          </LongText>
        )}

        {post.kind === 'assistant' && p.questions?.length > 0 && (
          <AsyncChoices post={post} running={task?.status === 'running'} onError={props.onError} />
        )}

        <Activity events={post.activity} expanded={expanded} onToggle={props.onToggle} />
        {working && <div className="working"><span className="dots"><span /><span /><span /></span>작업 중…</div>}
      </div>
    </article>
  );
}

function ApprovalCard({ post, approval, expanded, onAllow, onDeny }: {
  post: Post; approval: Approval | undefined; expanded: boolean; onAllow: () => void; onDeny: () => void;
}) {
  const p = post.event.payload;
  const r = post.resolution?.payload;
  const outcome = r ? (r.decision === 'allowed' ? '✓ 승인함' : r.decision === 'cancelled' ? '취소됨' : '✕ 거절함')
    : approval ? null : '만료됨';
  return (
    <div className={`approve-card${outcome ? ' resolved' : ''}`}>
      {p.toolName === REQUEST_TOOL ? (<>
        <div className="what" title={p.input?.title}>{p.input?.to}에게 {outcome ? '보낼 질문' : '질문을 보내려 합니다'}</div>
        <div className="desc">{richText(String(p.input?.description ?? ''))}</div>
      </>) : (<>
        <div className="what">{p.toolName} {outcome ? '실행 요청' : '실행을 요청합니다'}</div>
        <pre className="mono">{expanded ? JSON.stringify(p.input, null, 2) : toolSummary(p.toolName, p.input)}</pre>
        {!expanded && typeof p.input?.description === 'string' && p.input.command && <div className="desc">{p.input.description}</div>}
      </>)}
      <div className="approve-actions">
        {outcome ? (
          <span className={`resolution ${r?.decision === 'allowed' ? 'ok' : 'no'}`}>
            {outcome}{r?.message ? ` — ${r.message}` : ''}
          </span>
        ) : (
          <>
            <button className="yes" title="승인 (y)" onClick={(e) => { e.stopPropagation(); onAllow(); }}>승인 <kbd>y</kbd></button>
            <button className="no" title="거절 (n)" onClick={(e) => { e.stopPropagation(); onDeny(); }}>거절 <kbd>n</kbd></button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A Codex async question (request_user_input_async): its turn goes on, and the answer is just the
 * next message. An option click sends that message, into the running turn when there is one.
 */
function AsyncChoices({ post, running, onError }: { post: Post; running: boolean; onError?: (msg: string) => void }) {
  const questions = post.event.payload.questions as { title: string; options: string[] }[];
  const [sent, setSent] = useState<string>();
  const answer = post.resolution?.payload.text as string | undefined;
  const done = sent ?? answer;
  const send = (option: string) => {
    if (done) return;
    setSent(option);
    api.send(post.taskId, running ? `${option} #now` : option)
      .catch((err) => { setSent(undefined); onError?.(`답을 보내지 못했습니다: ${err instanceof Error ? err.message : err}`); });
  };
  return (
    <div className={`ask-card async${done ? ' resolved' : ''}`}>
      {questions.filter((q) => q.options.length).map((q, i) => (
        <div className="ask-opts" key={i}>
          {questions.length > 1 && <div className="ask-q">{q.title}</div>}
          {q.options.map((o) => (
            <button key={o} className={`ask-opt${done === o ? ' on' : ''}`} disabled={!!done}
              onClick={(e) => { e.stopPropagation(); send(o); }}>
              <span className="mark">{done === o ? '●' : '○'}</span><span>{o}</span>
            </button>
          ))}
        </div>
      ))}
      {done && <div className="resolution muted">{sent ? `“${sent}” 보냄` : '답함'}</div>}
    </div>
  );
}

/** A question from an attached agent: answered here, in a box under the question. */
function QuestionCard({ post, question, full, onToggle, onError }: {
  post: Post; question: Question | undefined; full: boolean; onToggle?: () => void; onError?: (msg: string) => void;
}) {
  const p = post.event.payload;
  const onLocalLink = useMemo(() => openLink(post.taskId, onError), [post.taskId, onError]);
  const body = useMemo(() => <Markdown text={String(p.text ?? '')} onLocalLink={onLocalLink} />, [p.text, onLocalLink]);
  const r = post.resolution;
  // An unsent answer is kept as a draft (drafts.ts) while the question waits.
  const draftKey = `question:${p.questionId}`;
  const [text, setText] = useState(() => getDraft<string>(draftKey) ?? '');
  const [busy, setBusy] = useState(false);
  // Shown between a successful answer and its `user` event arriving.
  const [sent, setSent] = useState<string | null>(null);
  const answer = r?.kind === 'user' ? String(r.payload.text ?? '') : sent;
  const outcome = answer != null ? 'answered' : r ? 'cancelled' : question ? null : 'closed';
  useEffect(() => { setDraft(draftKey, text, { taskId: post.taskId, empty: !!outcome || !text.trim() }); }, [draftKey, text, outcome, post.taskId]);
  useDraftSync<string>(draftKey, (v) => setText(v ?? ''));

  const submit = async () => {
    const body = text.trim();
    if (!body || busy || !question) return;
    setBusy(true);
    try { await api.answer(question.id, body); setSent(body); setText(''); }
    catch (e) { onError?.(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={`approve-card question-card${outcome ? ' resolved' : ''}`}>
      <div className="what">{outcome ? '에이전트의 질문' : '에이전트가 답을 기다립니다'}</div>
      <LongText full={full} className="body md" onToggle={onToggle}>{body}</LongText>
      {outcome ? (
        <div className="approve-actions">
          <span className={`resolution ${outcome === 'answered' ? 'ok' : 'no'}`}>
            {outcome === 'answered' ? `✓ 답함: ${answer}` : outcome === 'cancelled' ? '취소됨' : '닫힘'}
          </span>
        </div>
      ) : (
        <div className="answer" onClick={(e) => e.stopPropagation()}>
          <textarea className="input" rows={2} value={text} data-question={question!.id} disabled={busy}
            placeholder="답 입력…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
            }} />
          <div className="approve-actions">
            <span className="spacer" />
            <span className="muted"><kbd>⌘</kbd><kbd>↵</kbd></span>
            <button className="yes" disabled={!text.trim() || busy} onClick={() => void submit()}>답하기</button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = { started: '세션 시작', model_changed: '모델 적용', turn_done: '턴 완료', finished: '작업 종료', handoff: '터미널 세션 넘겨받음' };

/** A model/effort switch (status 'model'): "모델 → Opus · effort high". */
const modelSwitch = (d: { model?: ModelName | null; effort?: string | null }) =>
  `모델 → ${[d.model ? MODEL_LABEL[d.model] ?? d.model : null, d.effort ? `effort ${d.effort}` : null].filter(Boolean).join(' · ') || '엔진 기본'}`;

function Activity({ events, expanded, onToggle }: { events: HubEvent[]; expanded: boolean; onToggle: () => void }) {
  const tools = events.filter((e) => e.kind === 'tool');
  const results = new Map(events.filter((e) => e.kind === 'tool_result').map((e) => [e.payload.toolUseId, e]));
  const done = events.find((e) => e.kind === 'status' && e.payload.state === 'turn_done');
  const modes = events.filter((e) => e.kind === 'status' && (e.payload.state === 'mode' || e.payload.state === 'model'));
  const finished = events.some((e) => e.kind === 'status' && e.payload.state === 'finished');
  const forks = events.filter((e) => e.kind === 'status' && e.payload.state === 'forked').length;
  if (!tools.length && !done && !modes.length && !finished && !forks) return null;

  const errors = tools.filter((t) => results.get(t.payload.toolUseId)?.payload.isError).length;
  const names = [...new Set(tools.map((t) => t.payload.name))];
  const cost = done?.payload.detail?.cost_usd;
  const line = [
    tools.length ? `도구 ${tools.length}회 · ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}` : '세부',
    ...modes.map((m) => m.payload.state === 'model' ? modelSwitch(m.payload.detail) : `모드 → ${MODE_LABEL[m.payload.detail.mode as PermissionMode]}`),
    done ? `턴 완료${cost != null ? ` · 누적 $${Number(cost).toFixed(2)}` : ''}` : null,
    finished ? '작업 종료' : null,
    forks ? `포크 ${forks}개` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`activity${expanded ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
      <button className="summary" onClick={onToggle} title="펼치기 (o)">
        <ChevronRight className="tri" />{line}{errors > 0 && <span className="err-mark"> · 실패 {errors}</span>}
      </button>
      {expanded && (
        <ul>
          {events.map((e) => {
            if (e.kind === 'tool') {
              const res = results.get(e.payload.toolUseId);
              return (
                <li key={e.id} className={res?.payload.isError ? 'err' : ''}>
                  <details>
                    <summary><span className="tool mono">{e.payload.name}</span>
                      <span className="sum mono">{toolSummary(e.payload.name, e.payload.input)}{res?.payload.isError ? ' ✕' : ''}</span></summary>
                    <pre>{JSON.stringify(e.payload.input, null, 2)}</pre>
                    {res && <pre className="result">{res.payload.text}</pre>}
                    {(e.payload.clipped || res?.payload.clipped) && <p className="clip-note">피드에는 일부만 옵니다. 스레드에서 전체를 볼 수 있습니다.</p>}
                  </details>
                </li>
              );
            }
            if (e.kind === 'status') {
              const d = e.payload.detail ?? {};
              return (
                <li key={e.id} className="note">
                  {e.payload.state === 'mode' ? `모드 → ${MODE_LABEL[d.mode as PermissionMode]}`
                    : e.payload.state === 'model' ? modelSwitch(d)
                    : e.payload.state === 'closed' ? (d.busy ? '진행 중이던 턴을 끊고 세션을 닫았습니다' : '세션을 닫았습니다')
                    : e.payload.state === 'mkdir' ? `디렉터리를 새로 만들었습니다 · ${d.path}`
                    : e.payload.state === 'forked' ? `포크 → ${d.seq ? `#${d.seq} ` : ''}“${d.title}” (새 작업)` : STATE_LABEL[e.payload.state] ?? e.payload.state}
                  {d.model && e.payload.state !== 'model' ? ` · ${modelShort(d.model)}` : ''}
                  {d.duration_ms != null ? ` · ${(d.duration_ms / 1000).toFixed(1)}초` : ''}
                  {e.payload.state === 'finished' && d.summary ? ` · ${d.summary}` : ''}
                  {e.payload.state === 'started' && d.writer_busy ? ' · 다른 Codex 앱이 이 대화를 열고 있어 복제본으로 이어 갑니다' : ''}
                </li>
              );
            }
            if (e.kind === 'approval') {
              return <li key={e.id} className="note">{e.payload.toolName} {e.payload.decision === 'allowed' ? '승인함' : '거절함'}</li>;
            }
            return null;
          })}
        </ul>
      )}
    </div>
  );
}
