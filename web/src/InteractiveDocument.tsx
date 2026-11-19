import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

type Surface = { id: string; width: number; height: number };
type Frame = { data: string; scroll: { top: number; total: number } };

export function InteractiveDocument({ id, version, title, onChanged, onFailure }: {
  id: string; version: string; title: string; onChanged: () => void; onFailure: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<Surface>();
  const [frame, setFrame] = useState<Frame>();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = (within: boolean) => setVisible(within && !document.hidden);
    let within = typeof IntersectionObserver === 'undefined';
    const changed = () => show(within);
    const observer = typeof IntersectionObserver === 'undefined' ? undefined
      : new IntersectionObserver(([entry]) => { within = !!entry?.isIntersecting; changed(); });
    observer?.observe(el);
    document.addEventListener('visibilitychange', changed);
    changed();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', changed); };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    const controller = new AbortController();
    setSurface(undefined); setFrame(undefined);
    const { width, height } = el.getBoundingClientRect();
    const run = async () => {
      const response = await fetch('/api/preview/interactive', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, version, width, height }) });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const { error } = await response.json();
        if (response.status === 409 && !controller.signal.aborted) { onChanged(); return; }
        throw new Error(error ?? 'JS 미리보기를 열지 못했습니다.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('JS 미리보기 연결을 열지 못했습니다.');
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) return;
          if (done) throw new Error('JS 미리보기가 끝났습니다. 다시 열어 주세요.');
          const lines = (buffer + decoder.decode(value, { stream: true })).split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            const message = JSON.parse(line) as Surface | Frame;
            if ('id' in message) { setSurface(message); setFrame(undefined); }
            else setFrame(message);
          }
        }
      } finally { reader.releaseLock(); }
    };
    void run().catch(error => { if (!controller.signal.aborted) onFailure(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, [id, version, visible, onChanged, onFailure]);

  const send = (type: 'click' | 'scroll', event: { clientX: number; clientY: number }, dy?: number) => {
    const el = ref.current;
    if (!el || !surface || !visible) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    return fetch('/api/preview/input', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: surface.id, type, dy,
        x: (event.clientX - rect.left) * surface.width / rect.width,
        y: (event.clientY - rect.top) * surface.height / rect.height }),
    }).then(() => {}, () => {});
  };
  const input = useRef(send);
  input.current = send;
  const bounds = useRef(frame?.scroll);
  bounds.current = frame?.scroll;
  useEffect(() => {
    const el = ref.current;
    if (!el || !surface || !visible) return;
    let dy = 0, frameId = 0, pending = false, closed = false, touchY: number | undefined;
    let point = { clientX: 0, clientY: 0 };
    const flush = async () => {
      frameId = 0;
      if (closed || !dy) return;
      const delta = dy; dy = 0; pending = true;
      await input.current('scroll', point, delta);
      pending = false;
      if (!closed && dy) frameId = requestAnimationFrame(() => { void flush(); });
    };
    const scroll = (event: Event, position: typeof point, delta: number) => {
      const current = bounds.current;
      if (!current) return;
      // At the root edge, let the pane scroll too. The remote page may still have
      // a nested scrolling region or a widget that uses the wheel.
      if (event.cancelable && (delta < 0 ? current.top > 2 : current.total - surface.height - current.top > 2))
        event.preventDefault();
      dy += delta;
      point = position;
      if (!pending && !frameId) frameId = requestAnimationFrame(() => { void flush(); });
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      scroll(event, event, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.height : 1));
    };
    const touch = (event: TouchEvent) => {
      const finger = event.touches.length === 1 ? event.touches[0] : undefined;
      if (event.type === 'touchmove' && finger && touchY !== undefined) {
        const delta = touchY - finger.clientY;
        if (Math.abs(delta) >= 1) scroll(event, finger, delta);
      }
      touchY = finger?.clientY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', touch, { passive: true });
    el.addEventListener('touchmove', touch, { passive: false });
    return () => {
      closed = true; cancelAnimationFrame(frameId);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', touch);
      el.removeEventListener('touchmove', touch);
    };
  }, [surface, visible]);
  const click = (event: MouseEvent) => { if (event.button === 0) void send('click', event); };
  const top = frame?.scroll.top ?? 0;
  const total = frame?.scroll.total ?? 0;
  const remain = total - (surface?.height ?? 0);
  const ratio = surface && total > 0 ? Math.max(0.08, surface.height / total) : 1;
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !surface) return;
    const dy = ({ ArrowUp: -60, ArrowDown: 60, PageUp: -surface.height, PageDown: surface.height } as Record<string,number>)[event.key];
    if (!dy) return;
    if (dy < 0 ? top > 2 : remain - top > 2) event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    void send('scroll',{ clientX:rect.left + rect.width / 2, clientY:rect.top + rect.height / 2 },dy);
  };
  return <div className="document-frame document-interactive" ref={ref} tabIndex={0} onClick={click} onKeyDown={keyDown}>
    {frame ? <img alt={title} src={`data:image/jpeg;base64,${frame.data}`} draggable={false} />
      : visible && <span role="status">JS 미리보기를 여는 중…</span>}
    {top > 2 && remain - top > 2 &&
      <i className="document-scroll-thumb" aria-hidden="true" style={{ height: `${100 * ratio}%`, top: `${(1 - ratio) * 100 * top / remain}%` }} />}
  </div>;
}
