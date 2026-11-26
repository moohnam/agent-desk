import { useMemo } from 'react';
import { openLink } from './documentLinks.ts';
import { Markdown } from './Markdown.tsx';

export function RequestMessage({ text, taskId, onError }: {
  text: string; taskId: string; onError?: (message: string) => void;
}) {
  const onLocalLink = useMemo(() => openLink(taskId, onError), [taskId, onError]);
  return <div className="request-preview" onKeyDown={event => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).closest('a, summary, button'))
      event.stopPropagation();
  }}>
    <div className="md"><Markdown text={text} taskId={taskId} onLocalLink={onLocalLink} onNotice={onError} mentions /></div>
    <details><summary>원문 보기</summary><pre>{text}</pre></details>
  </div>;
}
