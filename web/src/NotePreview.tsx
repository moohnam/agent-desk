import type { NoteContext } from '../../shared/api.ts';
import './Note.css';

export function NotePreview({ note, clipped }: { note: NoteContext[number]; clipped?: boolean }) {
  if (clipped && !note.text) return <div className="note-preview">첨부 메모 · {note.title}</div>;
  return <details className="note-preview">
    <summary>첨부 메모 · {note.title}</summary>
    <div>{note.text || '스레드에서 원문을 확인할 수 있습니다.'}</div>
  </details>;
}
