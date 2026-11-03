import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal.tsx';
import { renderMermaid } from './mermaid.ts';

export const MermaidBlock = memo(function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ source: string; image?: string; background?: string; error?: string }>();
  const [large, setLarge] = useState(false);
  const current = result?.source === source ? result : undefined;
  useEffect(() => {
    let alive = true;
    let started = false;
    const controller = new AbortController();
    const render = () => {
      if (!alive || started) return;
      started = true;
      void renderMermaid(source, controller.signal).then(
        (rendered) => { if (alive) setResult({ source, ...rendered }); },
        () => { if (alive) setResult({ source, error: '도표를 그리지 못했습니다. 아래 원문을 확인해 주세요.' }); });
    };
    if (typeof IntersectionObserver === 'undefined') { render(); return () => { alive = false; controller.abort(); }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); render(); }
    }, { rootMargin: '200px' });
    if (ref.current) observer.observe(ref.current);
    return () => { alive = false; controller.abort(); observer.disconnect(); };
  }, [source]);
  return (
    <div className="mermaid-block" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="mermaid-tools">
        <span className="muted small">Mermaid</span><span className="spacer" />
        {current?.image && <button className="link" onClick={() => setLarge(true)}>크게 보기</button>}
      </div>
      {current?.image ? <div className="mermaid-canvas" style={{ backgroundColor: current.background }}><img src={current.image} alt="Mermaid 도표" /></div>
        : current?.error ? <p className="muted small" role="alert">{current.error}</p>
        : <p className="muted small" role="status">도표를 불러오는 중…</p>}
      <details open={!!current?.error}>
        <summary>원문 보기</summary>
        <pre><code>{source}</code></pre>
      </details>
      {large && current?.image && createPortal(
        <div onMouseDown={(e) => e.stopPropagation()}>
          <Modal title="Mermaid 도표" wide onClose={() => setLarge(false)}>
            <div className="mermaid-canvas mermaid-large" style={{ backgroundColor: current.background }}><img src={current.image} alt="Mermaid 도표 확대" /></div>
          </Modal>
        </div>, document.body)}
    </div>
  );
});
