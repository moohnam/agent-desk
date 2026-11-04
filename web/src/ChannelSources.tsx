import type { ChannelContext } from '../../shared/api.ts';
import { safeChannelUrl } from './channelEntries.ts';

/** Saved with the message, so later feed edits/deletion do not change its evidence. */
export function ChannelSources({ context, clipped }: { context: ChannelContext; clipped?: boolean }) {
  if (!context.entries.length) return null;
  return <details className="channel-sources" onClick={(event) => event.stopPropagation()}>
    <summary>{context.channel_name} · 첨부 자료 {context.entries.length}개</summary>
    {context.entries.map((entry) => {
      const url = safeChannelUrl(entry.url);
      return <div key={entry.id} className="channel-source">
        <b>{entry.title || `글 #${entry.id}`}</b>
        <span className="muted small"> · {new Date(entry.published_at ?? entry.received_at).toLocaleString('ko-KR')}</span>
        {url && <a href={url} target="_blank" rel="noreferrer noopener">원문 보기</a>}
        {clipped ? <p className="muted small">첨부 당시의 본문은 대화에서 확인할 수 있습니다.</p> : <pre>{entry.body}</pre>}
      </div>;
    })}
  </details>;
}
