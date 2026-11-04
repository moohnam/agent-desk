import { useState } from 'react';
import { botIngestExample } from './channelEntries.ts';

export function BotGuide({ channelId }: { channelId: string }) {
  const [note, setNote] = useState('');
  const example = botIngestExample(typeof location === 'undefined' ? 'http://localhost:4317' : location.origin, channelId);
  const copy = async () => {
    try { await navigator.clipboard.writeText(example); setNote('예제를 복사했습니다. 발행 토큰은 포함하지 않습니다.'); }
    catch { setNote('복사하지 못했습니다. 예제를 직접 선택해 복사해 주세요.'); }
  };
  return <details className="channel-guide bot-guide">
    <summary>봇에서 이 채널로 알림 보내기</summary>
    <ol>
      <li>채널 생성 직후 표시된 발행 토큰을 봇의 비밀 설정에 보관합니다. 잃어버렸다면 <strong>토큰 재발급</strong>으로 새 토큰을 받으세요.</li>
      <li>봇이 실행되는 환경에 <code>CHANNEL_TOKEN</code> 환경 변수로 넣고 아래 예제를 실행합니다.</li>
    </ol>
    <pre>{example}</pre>
    <button className="btn" onClick={() => void copy()}>전송 예제 복사</button>
    {note && <p className="muted small" role="status">{note}</p>}
    <p>다른 머신의 봇에서는 주소를 이 허브의 접속 주소로 바꾸세요. 상단 <strong>폰에서 열기</strong>에서 확인할 수 있습니다. <code>localhost</code>는 봇이 실행되는 머신을 뜻합니다.</p>
    <p><code>external_id</code>는 알림의 고유 ID입니다. 같은 ID를 다시 보내면 기존 글을 갱신하고, 다른 ID를 보내면 새 글을 만듭니다. 제목과 본문 중 하나는 필요하며 원문 링크는 선택입니다.</p>
    <p><code>{'{"entries": [...]}'}</code> 형식은 한 번에 최대 100개를 받습니다. 성공 응답의 <code>created / updated / unchanged</code>로 결과를 확인하세요. 401이면 해당 채널의 발행 토큰을 확인하세요.</p>
  </details>;
}
