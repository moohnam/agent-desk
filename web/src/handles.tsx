import { useState } from 'react';
import { WIDTH_PRESETS } from './columns.ts';

/** The split thread's share of the workspace, in percent: its limits and default. */
export const PANE_MIN = 30, PANE_MAX = 70, PANE_DEFAULT = 50;

/** Drag the split thread's left edge to share the workspace; double-click restores half and half. */
export function SplitHandle({ split, onResize }: { split: number; onResize: (pct: number | null) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <>
      {drag != null && <span className="wbadge">{drag}%</span>}
      <div className={`split-resize${drag != null ? ' dragging' : ''}`} title="끌어서 폭 조절 · 더블클릭은 절반"
        onDoubleClick={() => onResize(null)}
        onPointerDown={(e) => {
          e.preventDefault();
          const el = e.currentTarget, startX = e.clientX;
          const total = el.closest('.workspace')?.getBoundingClientRect().width ?? window.innerWidth;
          el.setPointerCapture(e.pointerId);
          document.body.classList.add('resizing');
          const move = (ev: PointerEvent) => {
            const pct = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(split + (startX - ev.clientX) / total * 100)));
            setDrag(pct);
            onResize(pct);
          };
          // A cancelled pointer or a lost capture ends the drag as a release does.
          const up = () => {
            setDrag(null);
            document.body.classList.remove('resizing');
            el.removeEventListener('pointermove', move);
            for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.removeEventListener(t, up);
          };
          el.addEventListener('pointermove', move);
          for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        }} />
    </>
  );
}

/** Snap to a preset when the drag ends this close to it. */
export const SNAP = 12;

/** Drag the column's right edge to set a fixed width; double-click restores the default. */
export function ResizeHandle({ width, onResize }: { width: number; onResize: (px: number | null) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <>
      {drag != null && <span className="wbadge">{drag}px</span>}
      <div className={`col-resize${drag != null ? ' dragging' : ''}`} title="끌어서 폭 조절 · 더블클릭은 기본값"
        onDoubleClick={() => onResize(null)}
        onPointerDown={(e) => {
          e.preventDefault();
          const el = e.currentTarget, startX = e.clientX;
          el.setPointerCapture(e.pointerId);
          document.body.classList.add('resizing');
          const at = (ev: PointerEvent) => {
            const raw = Math.round((width + ev.clientX - startX) / 10) * 10;
            return WIDTH_PRESETS.find((p) => Math.abs(p.px - raw) <= SNAP)?.px ?? raw;
          };
          const move = (ev: PointerEvent) => { const px = at(ev); setDrag(px); onResize(px); };
          // A cancelled pointer or a lost capture ends the drag as a release does.
          const up = () => {
            setDrag(null);
            document.body.classList.remove('resizing');
            el.removeEventListener('pointermove', move);
            for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.removeEventListener(t, up);
          };
          el.addEventListener('pointermove', move);
          for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
        }} />
    </>
  );
}
