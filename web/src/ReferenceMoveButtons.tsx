import { ArrowDown, ArrowUp } from 'lucide-react';
import type { KeyboardEvent } from 'react';

function keepButtonKeys(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

export function ReferenceMoveButtons({ first, last, onMove }: { first: boolean; last: boolean; onMove: (direction: -1 | 1) => void }) {
  return <>
    <button type="button" className="icon-btn" title="위로 이동" aria-label="위로 이동" disabled={first} onKeyDown={keepButtonKeys} onClick={() => onMove(-1)}><ArrowUp /></button>
    <button type="button" className="icon-btn" title="아래로 이동" aria-label="아래로 이동" disabled={last} onKeyDown={keepButtonKeys} onClick={() => onMove(1)}><ArrowDown /></button>
  </>;
}
