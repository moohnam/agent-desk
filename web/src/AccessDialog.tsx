import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Modal } from './Compose.tsx';

/** "폰에서 열기": the QR code another device on the network scans to open the desk. */
export function AccessDialog({ onClose }: { onClose: () => void }) {
  const [urls, setUrls] = useState<{ url: string; qr: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  useEffect(() => { api.access().then((r) => setUrls(r.urls)).catch((e) => setError(e.message)); }, []);
  const cur = urls?.[pick];
  return (
    <Modal title="폰에서 열기" onClose={onClose}>
      <div className="form access">
        {error ? <p className="error">{error === 'HTTP 404' || error.startsWith('no route') ? '허브를 재시작하면 쓸 수 있습니다.' : error}</p>
          : !cur ? <p className="muted">불러오는 중…</p> : (
            <>
              <p className="muted">같은 Wi-Fi에 있는 폰이나 다른 기기의 카메라로 스캔하세요. 한 번 열면 그 기기를 기억합니다.</p>
              {/* The hub renders this SVG from its own URL; nothing user-supplied goes into it. */}
              <div className="qr" dangerouslySetInnerHTML={{ __html: cur.qr }} />
              <div className="access-urls" role="radiogroup" aria-label="접속 주소">
                {urls!.map((u, i) => (
                  <button key={u.url} role="radio" aria-checked={i === pick} className={`sk-file${i === pick ? ' on' : ''}`}
                    onClick={() => setPick(i)}>{new URL(u.url).host}</button>
                ))}
              </div>
              <p className="muted small">주소에 접속 토큰이 들어 있습니다. 믿을 수 있는 기기에서만 여세요.
                토큰을 바꾸려면 허브의 <code>data/access-token</code>을 지우고 허브를 재시작합니다.</p>
            </>
          )}
      </div>
    </Modal>
  );
}
