import { useLayoutEffect, useRef } from 'react';

const dimensions = {
  width: { variable: '--files-width', key: 'desk.codeFiles.width' },
  height: { variable: '--files-height', key: 'desk.codeFiles.height' },
} as const;

export function CodeFileDivider() {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dimension: keyof typeof dimensions; offset: number; pointerId: number } | null>(null);

  useLayoutEffect(() => {
    const grid = ref.current!.parentElement!;
    for (const { variable, key } of Object.values(dimensions)) {
      try {
        const size = Number(localStorage.getItem(key));
        if (Number.isFinite(size) && size > 0) grid.style.setProperty(variable, size + 'px');
      } catch { /* Storage can be unavailable in a private session. */ }
    }
  }, []);

  return <div ref={ref} className="code-file-divider" title="끌어서 파일 목록 크기 조절 · 더블클릭은 기본값"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const handle = event.currentTarget;
      const dimension = getComputedStyle(handle).cursor === 'row-resize' ? 'height' : 'width';
      const position = dimension === 'height' ? event.clientY : event.clientX;
      drag.current = { dimension, pointerId: event.pointerId, offset: position - handle.previousElementSibling!.getBoundingClientRect()[dimension] };
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const handle = event.currentTarget;
      if (drag.current?.pointerId !== event.pointerId) return;
      const { dimension, offset } = drag.current;
      const position = dimension === 'height' ? event.clientY : event.clientX;
      const grid = handle.parentElement!;
      const size = Math.min(grid.getBoundingClientRect()[dimension] * 0.65, Math.max(dimension === 'width' ? 120 : 44, position - offset));
      grid.style.setProperty(dimensions[dimension].variable, Math.round(size) + 'px');
    }}
    onLostPointerCapture={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const { variable, key } = dimensions[drag.current.dimension];
      const value = event.currentTarget.parentElement!.style.getPropertyValue(variable);
      if (value) try { localStorage.setItem(key, String(parseFloat(value))); } catch { /* Session only. */ }
      drag.current = null;
    }}
    onDoubleClick={event => {
      const handle = event.currentTarget;
      const { variable, key } = dimensions[getComputedStyle(handle).cursor === 'row-resize' ? 'height' : 'width'];
      handle.parentElement!.style.removeProperty(variable);
      try { localStorage.removeItem(key); } catch { /* Session only. */ }
    }}
  />;
}
