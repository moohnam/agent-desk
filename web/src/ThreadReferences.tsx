import { DocumentPreview } from './DocumentPreview.tsx';
import { previewLink } from './documentLinks.ts';
import { ArrowUpRight, Bookmark, PanelLeftClose, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ENGINE_LABEL, engineOf } from '../../shared/compose.ts';
import { api } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { referenceEvents } from './threadReferences.ts';
import type { HubEvent, TaskView } from './types.ts';

/** A reading copy, without a second set of live approval/answer controls. */
const ReferenceCard = memo(function ReferenceCard({ event, task, onError }: {
  event: HubEvent; task: TaskView; onError: (message: string) => void;
}) {
  const p = event.payload;
  const open = useMemo(() => (href: string) => { if(previewLink(task.id,href))return; void api.open(href, task.id).catch((e: Error) => onError(e.message)); }, [task.id, onError]);
  return <>
    <div className="reference-author">
      <b>{event.kind === 'user' ? '나' : event.kind === 'assistant' || event.kind === 'update' ? ENGINE_LABEL[engineOf(task.engine)] : event.kind === 'status' ? '알림' : '질문·승인'}</b>
      <time dateTime={event.ts}>{new Date(event.ts).toLocaleString('ko-KR')}</time>
    </div>
    {event.kind === 'assistant' || event.kind === 'update'
      ? <div className="body md"><Markdown text={String(p.text ?? '')} taskId={task.id} onLocalLink={open} /></div>
      : event.kind === 'approval'
        ? <><strong>{p.toolName}</strong><pre>{JSON.stringify(p.input, null, 2)}</pre></>
        : <div className="body">{String(p.text ?? p.detail?.message ?? '')}</div>}
  </>;
});

/** Parse a long Markdown body only as its card approaches the reading viewport, then retain it. */
const ReferenceBody = memo(function ReferenceBody({ visible, ...props }: { visible: boolean; event: HubEvent; task: TaskView; onError: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(typeof IntersectionObserver === 'undefined' && visible);
  useEffect(() => {
    if (ready || !visible || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setReady(true); return; }
    let alive = true;
    const observer = new IntersectionObserver(entries => {
      if (alive && entries.some(entry => entry.isIntersecting)) { setReady(true); observer.disconnect(); }
    }, { root: ref.current.closest('.reference-feed'), rootMargin: '300px' });
    observer.observe(ref.current);
    return () => { alive = false; observer.disconnect(); };
  }, [ready, visible]);
  return <div className="reference-body" ref={ref}>{ready ? <ReferenceCard {...props} /> : <p className="muted">본문을 준비하고 있습니다…</p>}</div>;
});

export const ThreadReferences = memo(ThreadReferencesInner, (a, b) => !a.visible && !b.visible && a.task.id === b.task.id && a.ids === b.ids && a.files === b.files && a.fileFocus === b.fileFocus);

function ThreadReferencesInner({ visible, task, ids, files, fileFocus, events, reload, onRemoveFile, onRemove, onClear, onClose, onReveal, onError }: {
  visible: boolean; files?: string[]; onRemoveFile: (href:string)=>void;
  fileFocus?: {href:string;revision:number};
  task: TaskView; ids: number[]; events: HubEvent[]; reload: number;
  onRemove: (id: number) => void; onClear: () => void; onClose: () => void;
  onReveal: (id: number) => void; onError: (message: string) => void;
}) {
  const [fetched, setFetched] = useState<HubEvent[]>([]);
  const [absent, setAbsent] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const selected = ids.join(',');
  useEffect(() => {
    const keep = new Set(ids);
    setFetched(previous => { const next = previous.filter(e => keep.has(e.id)); return next.length === previous.length ? previous : next; });
    setAbsent(previous => {
      const next = new Set([...previous].filter(id => keep.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [selected]);
  const originals = useMemo(() => referenceEvents(task.id, ids, [...fetched, ...events]), [task.id, ids, fetched, events]);
  const needed = ids.filter(id => !originals.has(id) && !absent.has(id)).join(',');
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    const controller = new AbortController();
    const requested = needed.split(',').map(Number);
    setError('');
    // The existing event lookup accepts at most 500 IDs per request.
    const batches = Array.from({ length: Math.ceil(requested.length / 500) }, (_, i) => requested.slice(i * 500, (i + 1) * 500));
    void Promise.all(batches.map(ids => api.events(task.id, { ids }, controller.signal))).then(pages => {
      if (!alive) return;
      const incoming = referenceEvents(task.id, requested, pages.flatMap(page => page.events));
      setFetched(previous => [...new Map([...previous.map(e => [e.id, e] as const), ...incoming]).values()]);
      setAbsent(previous => new Set([...previous, ...requested.filter(id => !incoming.has(id))]));
    }, (e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; controller.abort(); };
  }, [task.id, needed, reload, retry]);
  // A failed lookup or a missing original can be retried after reconnection or explicitly.
  useEffect(() => { setAbsent(previous => previous.size ? new Set() : previous); }, [reload, retry]);
  return <aside className={`thread-references${visible ? '' : ' reading-hidden'}`} aria-label="고정한 글" aria-hidden={!visible} inert={!visible}>
    <header className="reference-head">
      <div><h2><Bookmark /> 고정한 글·문서 <span>{ids.length+(files?.length??0)}</span></h2><p>{task.project_name}#{task.seq} · 선택한 순서</p></div>
      {(ids.length > 0 || !!files?.length) && <button className="link" onClick={onClear}>모두 해제</button>}
      <button className="icon-btn" title="고정한 글 창 닫기 · 선택은 유지" aria-label="고정한 글 창 닫기" onClick={onClose}><PanelLeftClose /></button>
    </header>
    <div className="reference-feed">
      {error && <p className="error" role="alert">글을 불러오지 못했습니다. <button className="link" onClick={() => setRetry(n => n + 1)}>다시 시도</button></p>}
      {ids.length === 0 && !files?.length && <p className="empty">오른쪽 스레드의 글에서 <Bookmark aria-label="고정" /> 버튼을 누르면 이곳에 차례로 쌓입니다.</p>}
      {files?.map(href=><DocumentPreview key={href} taskId={task.id} href={href} visible={visible} focusRevision={fileFocus?.href===href?fileFocus.revision:0} onRemove={()=>onRemoveFile(href)} onError={onError}/>)}
      {ids.map((id, index) => <section className="reference-card" key={id} data-reference={id}>
        <div className="reference-tools"><span>{index + 1}</span><span className="spacer" />
          <button className="icon-btn" title="오른쪽 스레드에서 원문 보기" aria-label={`고정한 글 ${index + 1} 원문 보기`} onClick={() => onReveal(id)}><ArrowUpRight /></button>
          <button className="icon-btn" title="고정 해제" aria-label={`고정한 글 ${index + 1} 해제`} onClick={() => onRemove(id)}><X /></button>
        </div>
        {originals.has(id) ? <ReferenceBody visible={visible} event={originals.get(id)!} task={task} onError={onError} />
          : <p className="empty">{absent.has(id) ? <>원문을 찾을 수 없습니다. <button className="link" onClick={() => setRetry(n => n + 1)}>다시 시도</button></> : error ? '불러오기를 다시 시도해 주세요.' : '원문을 불러오는 중…'}</p>}
      </section>)}
    </div>
  </aside>;
}
