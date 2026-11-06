import { useEffect, useRef, useState } from 'react';
import type { AccessDevice, AccessRequest, AccessView } from '../../shared/api.ts';
import { api } from './api.ts';
import { relTime } from './format.ts';
import { Modal } from './Modal.tsx';

/** Allow and Deny for one device asking to connect, with the code its screen shows. */
export function AccessRequestRow({ r, onError }: { r: AccessRequest; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    setBusy(true);
    api.answerAccess(r.id, allow).catch((e) => { onError(e.message); setBusy(false); });
  };
  return (
    <div className="access-row">
      <div className="who">
        <b>{r.name}</b> <span className="muted">{r.ip} · 코드 <b className="code">{r.code}</b> · {relTime(r.created_at)}</span>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => answer(true)}>허용</button>
      <button className="btn" disabled={busy} onClick={() => answer(false)}>거절</button>
    </div>
  );
}

/** New devices asking to connect, on this Mac's screen until answered. */
export function AccessRequests({ requests, onError }: { requests: AccessRequest[]; onError: (msg: string) => void }) {
  if (!requests.length) return null;
  return (
    <div className="access-requests" role="alert">
      <p className="title">다른 기기가 데스크에 접속하려고 합니다</p>
      {requests.map((r) => <AccessRequestRow key={r.id} r={r} onError={onError} />)}
      <p className="muted small">그 기기 화면의 코드와 같은지 확인하고 허용하세요. 직접 요청한 적이 없으면 거절하세요. 허용한 기기는 이 Mac의 에이전트를 부릴 수 있습니다.</p>
    </div>
  );
}

function DeviceRow({ d, onError }: { d: AccessDevice; onError: (msg: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState<string | null>(null);
  // Esc closes the field without saving, though the field's blur comes right after.
  const cancelled = useRef(false);
  const rename = () => {
    if (!cancelled.current && name != null && name.trim() && name !== d.name) api.renameDevice(d.id, name).catch((e) => onError(e.message));
    cancelled.current = false;
    setName(null);
  };
  return (
    <div className="access-row">
      <div className="who">
        {name == null ? <button className="device-name" title="이름 바꾸기" onClick={() => setName(d.name)}>{d.name}</button> : (
          <input className="input" autoFocus value={name} maxLength={60} aria-label="기기 이름"
            onChange={(e) => setName(e.target.value)} onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename();
              if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setName(null); }
            }} />
        )}
        <span className="muted">
          {d.connections ? <span className="live">연결 중{d.connections > 1 ? ` (${d.connections})` : ''}</span>
            : d.last_seen_at ? `마지막 접속 ${relTime(d.last_seen_at)}` : '접속 기록 없음'}
          {d.last_ip && ` · ${d.last_ip}`}
        </span>
      </div>
      {confirm ? (
        <>
          <button className="btn danger" onClick={() => api.removeDevice(d.id).catch((e) => onError(e.message))}>끊고 삭제</button>
          <button className="btn" onClick={() => setConfirm(false)}>취소</button>
        </>
      ) : <button className="btn" onClick={() => setConfirm(true)}>끊기</button>}
    </div>
  );
}

function RotateToken({ onDone, onError }: { onDone: () => void; onError: (msg: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button className="btn" onClick={() => setConfirm(true)}>QR 토큰 바꾸기</button>;
  return (
    <div className="access-row">
      <span className="who muted">지금 QR 주소는 더 쓸 수 없게 됩니다.</span>
      <button className="btn danger" onClick={() => api.rotateAccessToken().then(() => { setConfirm(false); onDone(); }, (e) => onError(e.message))}>바꾸기</button>
      <button className="btn" onClick={() => setConfirm(false)}>취소</button>
    </div>
  );
}

/**
 * Other devices: requests to answer, the devices let in (each with a token of its own, cut off one
 * at a time), and the QR code that lets a device in at once.
 */
export function AccessDialog({ access, onError, onClose }: { access: AccessView | null; onError: (msg: string) => void; onClose: () => void }) {
  const [urls, setUrls] = useState<{ url: string; qr: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  useEffect(() => { api.access().then((r) => setUrls(r.urls)).catch((e) => setError(e.message)); }, []);
  const cur = urls?.[pick];
  return (
    <Modal title="다른 기기 연결" onClose={onClose}>
      <div className="form access">
        {access && access.requests.length > 0 && (
          <section>
            <h3>접속 요청</h3>
            {access.requests.map((r) => <AccessRequestRow key={r.id} r={r} onError={onError} />)}
          </section>
        )}
        <section>
          <h3>연결한 기기</h3>
          {!access ? <p className="muted">허브를 재시작하면 볼 수 있습니다.</p>
            : access.devices.length ? access.devices.map((d) => <DeviceRow key={d.id} d={d} onError={onError} />)
            : <p className="muted">아직 없습니다. 다른 기기에서 이 허브 주소를 열면 이 Mac에 접속 요청이 옵니다.</p>}
        </section>
        <section>
          <h3>QR 코드로 바로 연결</h3>
          {error ? <p className="error">{error === 'HTTP 404' || error.startsWith('no route') ? '허브를 재시작하면 쓸 수 있습니다.' : error}</p>
            : !cur ? <p className="muted">불러오는 중…</p> : (
              <>
                <p className="muted">같은 Wi-Fi에 있는 폰이나 다른 기기의 카메라로 스캔하면 요청 없이 바로 연결됩니다.</p>
                {/* The hub renders this SVG from its own URL; nothing user-supplied goes into it. */}
                <div className="qr" dangerouslySetInnerHTML={{ __html: cur.qr }} />
                <div className="access-urls" role="radiogroup" aria-label="접속 주소">
                  {urls!.map((u, i) => (
                    <button key={u.url} role="radio" aria-checked={i === pick} className={`sk-file${i === pick ? ' on' : ''}`}
                      onClick={() => setPick(i)}>{new URL(u.url).host}</button>
                  ))}
                </div>
                <p className="muted small">QR 주소에는 공용 접속 토큰이 들어 있습니다. 믿을 수 있는 기기에서만 여세요.
                  QR로 연결했던 기기는 끊어도 그 주소를 알면 다시 들어올 수 있으니, 그런 기기를 끊을 때는 QR 토큰도 바꾸세요.
                  연결한 기기는 그대로 남습니다.</p>
                <RotateToken onDone={() => api.access().then((r) => setUrls(r.urls), (e) => onError(e.message))} onError={onError} />
              </>
            )}
        </section>
      </div>
    </Modal>
  );
}
