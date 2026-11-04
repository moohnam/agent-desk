import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api } from './api.ts';
import { ComposeField } from './Compose.tsx';
import { getDraft, setDraft, useDraftSync } from './drafts.ts';
import { observeThreadSize, firstPostBelow } from './layout.ts';
import { buildPosts, placeThread } from './posts.ts';
import { PostView } from './PostView.tsx';
import { QueuedShortcut } from './queuedShortcut.ts';
import { useTaskEvents } from './useHub.ts';
import type { Approval, Channel, HubEvent, Project, Question, TaskView } from './types.ts';

export interface ChannelConversationProps {
  channel?: Channel; channelId: string; projects: Project[]; tasks: Map<string, TaskView>;
  approvals: Map<string, Approval>; questions: Map<string, Question>; synced: number;
  onEvent: (fn: (event: HubEvent) => void) => () => void;
  onError: (message: string) => void; onOpenTask: (taskId: string) => void;
  onApproval: (approval: Approval, allow: boolean) => void;
}

/** Same task/runner/history as ordinary conversations, shown inside the source column. */
export function ChannelConversation({ channel, channelId, projects, tasks, approvals, questions, synced, onEvent, onError, onOpenTask, onApproval,
  sources, sourceRevision, onSourcesSent, onRemoveSource, onBrowse, inputRef }: ChannelConversationProps & {
  sources: Map<number, string>; sourceRevision: number; onSourcesSent: (ids: number[]) => void;
  onRemoveSource: (id: number) => void; onBrowse: () => void; inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const draftKey = `channel-chat:${channelId}`;
  const draft = getDraft<{ text: string; project: string }>(draftKey);
  const [text, setText] = useState(draft?.text ?? '');
  const [project, setProject] = useState(draft?.project ?? '');
  const [taskId, setTaskId] = useState(channel?.conversation_task_id ?? null);
  const [received, setReceived] = useState<TaskView>();
  const task = taskId ? tasks.get(taskId) ?? (received?.id === taskId ? received : undefined) : undefined;
  const projectId = task?.project_id ?? (project || (projects.length === 1 ? projects[0].id : ''));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [note, setNote] = useState('');
  const revision = useRef(0);
  const mounted = useRef(true);
  const shortcut = useRef(new QueuedShortcut());
  const edited = () => { revision.current++; shortcut.current.reset(); setNote(''); };
  useEffect(() => { inputRef.current?.focus(); }, [inputRef]);
  useEffect(() => { setTaskId(channel?.conversation_task_id ?? null); }, [channel?.conversation_task_id]);
  useLayoutEffect(() => { edited(); }, [sourceRevision]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; shortcut.current.reset(); }; }, []);
  useEffect(() => { setDraft(draftKey, { text, project }, { empty: !text.trim() }); }, [draftKey, text, project]);
  useDraftSync<{ text: string; project: string }>(draftKey, (value) => { edited(); setText(value?.text ?? ''); setProject(value?.project ?? ''); });

  const history = useTaskEvents(taskId, onEvent, undefined, synced);
  const placed = useMemo(() => placeThread(buildPosts(history.events.filter((event) => event.task_id === taskId))), [history.events, taskId]);
  const [expanded, setExpanded] = useState(new Set<number>());
  const feed = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const stick = () => { if (feed.current && atBottom.current) feed.current.scrollTop = feed.current.scrollHeight; };
  useLayoutEffect(() => { atBottom.current = true; anchor.current = null; }, [taskId]);
  useLayoutEffect(() => {
    const el = feed.current, a = anchor.current;
    const post = a && el?.querySelector<HTMLElement>(`[data-post="${a.id}"]`);
    if (el && post && a) { el.scrollTop += post.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top; anchor.current = null; }
    else stick();
  }, [placed]);
  useEffect(() => feed.current ? observeThreadSize(feed.current, stick) : undefined, []);
  useEffect(() => { if (!history.loadingEarlier) anchor.current = null; }, [history.loadingEarlier]);
  const earlier = () => {
    const el = feed.current;
    if (el) {
      const top = el.getBoundingClientRect().top, post = firstPostBelow(el, top);
      if (post) anchor.current = { id: post.dataset.post!, top: post.getBoundingClientRect().top - top };
    }
    history.loadEarlier();
  };
  const toggle = (id: number) => setExpanded((prev) => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; });
  const promote = async (target: { taskId: string; queuedId: string } | null) => {
    if (!target) return;
    try { await api.sendQueuedNow(target.taskId, target.queuedId); if (mounted.current) setNote('방금 대기열에 넣은 질문을 바로 보냈습니다.'); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  const submit = async (fromShortcut = false) => {
    if (fromShortcut && shortcut.current.active) { await promote(shortcut.current.repeat()); return; }
    if (pending.current || !channel || !text.trim() || (!task && !projects.some((p) => p.id === projectId))) return;
    shortcut.current.reset();
    const request = fromShortcut && task ? shortcut.current.begin(task.id) : null;
    const version = revision.current, submitted = getDraft(draftKey), ids = [...sources.keys()];
    pending.current = true; setBusy(true); setNote(''); atBottom.current = true; stick();
    try {
      const result = await api.sendChannel(channelId, { text, entry_ids: ids, ...(!task && { project_id: projectId }) });
      if (revision.current === version && (mounted.current || getDraft(draftKey) === submitted)) {
        setDraft(draftKey, null, { empty: true });
        if (mounted.current) { setText(''); onSourcesSent(ids); }
      }
      if (mounted.current) { setReceived(result.task); setTaskId(result.task.id); setNote(result.queued_id ? '대기열에 넣었습니다. 입력을 바꾸지 않고 ⌘Enter를 한 번 더 누르면 지금 보냅니다.' : ''); }
      if (request !== null) await promote(shortcut.current.finish(request, result.queued_id));
    } catch (error) {
      if (request !== null) shortcut.current.finish(request);
      onError(error instanceof Error ? error.message : String(error));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <>
    <div className="channel-chat-meta">
      <span>{task ? `${task.project_name} · ${task.engine ?? '에이전트'} · ${task.status === 'running' ? '실행 중' : task.status === 'waiting' ? '응답 대기' : '대화 이어가기'}` : '이 채널의 알림을 함께 읽고 정리합니다.'}</span>
      {task && <button className="link" onClick={() => onOpenTask(task.id)}>전체 스레드</button>}
    </div>
    <div className="feed thread-feed channel-chat-feed" ref={feed} onScroll={(event) => { const el = event.currentTarget; atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40; }}>
      <div className="thread-content">
        {history.more && <div className="older-posts"><button disabled={history.loadingEarlier} onClick={earlier}>{history.loadingEarlier ? '불러오는 중…' : '이전 대화 더 보기'}</button></div>}
        {placed.map(({ post, up, down }, i) => <PostView key={post.id} post={post} task={task} model={task?.model ?? undefined}
          approval={post.kind === 'approval' ? approvals.get(post.event.payload.approvalId) : undefined}
          question={post.kind === 'question' ? questions.get(post.event.payload.questionId) : undefined}
          colId={`channel-chat:${channelId}`} selected={false} flash={false} expanded={expanded.has(post.id)} working={task?.status === 'running' && i === placed.length - 1}
          inThread up={up} down={down} onSelect={() => {}} onToggle={() => toggle(post.id)} onError={onError}
          onAllow={() => { const a = approvals.get(post.event.payload.approvalId); if (a) onApproval(a, true); }}
          onDeny={() => { const a = approvals.get(post.event.payload.approvalId); if (a) onApproval(a, false); }} />)}
        {!placed.length && <p className="empty">{taskId && !history.loaded ? '대화를 불러오는 중…' : '알림을 자료로 선택하고 요약이나 정리를 요청해 보세요. 같은 대화를 계속 이어갑니다.'}</p>}
      </div>
    </div>
    <div className="reply-box channel-chat-compose">
      {!task && <label className="channel-project">대화할 프로젝트<select className="input" aria-label="채널 대화 프로젝트" value={projectId} disabled={busy} onChange={(event) => { edited(); setProject(event.target.value); }}>
        <option value="">프로젝트 선택</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>}
      <div className="channel-source-picks" aria-label="다음 질문에 첨부할 알림">
        <span className="small">{sources.size ? `선택 자료 ${sources.size}개` : '새 자료 없이 대화 이어가기'}</span>
        <button className="link" onClick={onBrowse}>알림에서 자료 선택</button>
        {[...sources].map(([id, title]) => <button key={id} className="channel-source-chip" title={`${title || `글 #${id}`} · 누르면 자료에서 제외`} onClick={() => onRemoveSource(id)}>{title || `글 #${id}`} <span aria-hidden="true">×</span></button>)}
      </div>
      {(task?.queued.length ?? 0) > 0 && <ol className="queued" aria-label="대기 중인 채널 질문">{task!.queued.map((q, i) => <li key={q.id}>
        <span className="n">대기 {i + 1}</span><span className="t" title={q.text}>{q.text}</span>
        {q.channel_entry_count !== undefined && <span className="small">자료 {q.channel_entry_count}개</span>}
        <button className="link" onClick={() => void promote({ taskId: task!.id, queuedId: q.id })}>지금 보내기</button>
        <button className="link" onClick={() => { shortcut.current.reset(); void api.cancelQueued(task!.id, q.id).catch((error) => onError(error.message)); }}>취소</button>
      </li>)}</ol>}
      <ComposeField value={text} onChange={(value) => { edited(); setText(value); }} onSubmit={() => void submit(true)} onBlur={() => shortcut.current.reset()}
        inputRef={inputRef} projects={projects} tasks={[...tasks.values()]} mentions="refer" rows={2}
        placeholder={sources.size ? '선택한 글에 대해 질문하거나 정리를 요청하세요…' : '이전 대화에 이어 질문하세요…'} />
      {note && <p className="reply-note" role="status">{note}</p>}
      {!projects.length && !task && <p className="muted small">일반 작성창에서 프로젝트를 먼저 등록해 주세요.</p>}
      <div className="reply-tools">
        {task?.status === 'running' && <button className="link" onClick={() => void api.interrupt(task.id).catch((error) => onError(error.message))}>중단</button>}
        <span className="spacer" /><button className="btn primary" disabled={busy || !channel || !text.trim() || (!task && !projects.some((p) => p.id === projectId))} onClick={() => void submit()}>{busy ? '보내는 중…' : task?.status === 'running' ? '대기열에 보내기' : '보내기'}</button>
      </div>
    </div>
  </>;
}
