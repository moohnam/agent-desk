import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal.tsx';
import { renderWhenVisible } from './mermaid.ts';
import { renderDiagram } from './hubDiagram.ts';

/** Map the generated SVG's base font to the surrounding text, without stretching small diagrams. */
function diagramWidth(image:string) {
  try {
    const svg=decodeURIComponent(image.slice(image.indexOf(',')+1));
    const viewBox=svg.match(/<svg\b[^>]*\bviewBox=["']([^"']+)["']/i)?.[1];
    const width=Number(viewBox?.trim().split(/[\s,]+/)[2]);
    const fontSize=Number(svg.match(/<style\b[^>]*>[\s\S]*?\bfont-size:\s*([\d.]+)px\b/i)?.[1])||16;
    return Number.isFinite(width)&&width>0?`${width/fontSize}em`:undefined;
  }catch{return undefined;}
}

export const MermaidBlock = memo(function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ source: string; image?: string; background?: string; width?:string; error?: string }>();
  const [large, setLarge] = useState(false);
  const current = result?.source === source ? result : undefined;
  useEffect(() => {
    if (!ref.current) return;
    return renderWhenVisible(ref.current, async (signal) => {
      try {
        const rendered = await renderDiagram(source, signal);
        if (!signal.aborted) setResult({ source, ...rendered, width:diagramWidth(rendered.image) });
      } catch (error) {
        const cause = (error instanceof Error ? error.message : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[.!?]+$/, '');
        if (!signal.aborted) setResult({ source, error: `도표를 그리지 못했습니다.${cause ? ` 원인: ${cause}.` : ''} 아래 원문을 확인해 주세요.` });
      }
    });
  }, [source]);
  return (
    <div className="mermaid-block" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="mermaid-tools">
        <span className="muted small">Mermaid</span><span className="spacer" />
        {current?.image && <button className="link" onClick={() => setLarge(true)}>크게 보기</button>}
      </div>
      {current?.image ? <div className="mermaid-canvas" style={{ backgroundColor: current.background }}><img src={current.image} alt="Mermaid 도표" style={{width:current.width}} /></div>
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
