import { useEffect, useState } from 'react';
import { SettingsEditor, useSettingsPanel } from './settingsPanel.tsx';

interface Instructions { text: string; revision: string; defaults: string; editable?: boolean }
class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request(signal?: AbortSignal, input?: {text: string; revision: string}): Promise<Instructions> {
  // This setting belongs to the displayed hub, never the selected task's workspace.
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch('/api/instructions', {
    method: input ? 'PUT' : 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    ...(input && {headers: {'content-type': 'application/json'}, body: JSON.stringify(input)}),
  });
  const value = await response.json();
  if (!response.ok) throw new RequestError(value.error ?? `HTTP ${response.status}`, response.status);
  if (typeof value.text !== 'string' || typeof value.defaults !== 'string' || typeof value.revision !== 'string')
    throw new Error('기본 지침 응답을 확인하지 못했습니다');
  return value;
}
const errorMessage = (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
  ? '허브의 응답을 기다리는 시간이 초과되었습니다. 연결을 확인한 뒤 다시 시도하세요.'
  : error instanceof Error ? error.message : String(error);

export function InstructionsDialog({ onClose }: {onClose: () => void}) {
  const [saved, setSaved] = useState<Instructions>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [load, setLoad] = useState({kind: 'initial' as 'initial' | 'latest', attempt: 0});
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Instructions>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const panel = useSettingsPanel(!!saved && text !== saved.text, busy);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void request(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (load.kind === 'initial') { setSaved(value); setText(value.text); }
      else setLatest(value);
    }, error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);
  const close = () => {
    if (busy) return;
    if (saved && text !== saved.text && !window.confirm('저장하지 않은 기본 지침을 버리고 닫을까요?')) return;
    onClose();
  };
  const save = async (revision = saved?.revision) => {
    if (!revision || saved?.editable !== true || busy || loading) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await request(undefined, {text, revision});
      setSaved(value); setConflict(false); setLatest(undefined);
      setNotice('허브에 저장했습니다. 새 실행부터 적용됩니다.');
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) { setConflict(true); setLatest(undefined); }
      setError(errorMessage(error));
    } finally { setBusy(false); }
  };
  return <SettingsEditor title="기본 지침" wide onClose={close}>
    <form className="form instructions-form" onSubmit={event => {event.preventDefault(); if (!conflict) void save();}}>
      <p className="muted small">이 허브에서 시작하는 로컬·원격 실행에 전달합니다. 기존 대화는 재접속·문맥 재구성 후에도 시작할 때의 지침을 유지합니다.</p>
      {loading && <p className="muted small" role="status">{load.kind === 'initial' ? '기본 지침을 불러오는 중…' : '서버의 변경 내용을 불러오는 중…'}</p>}
      <label className="field"><span className="lbl">에이전트에게 전달할 지침</span>
        <textarea className="input" spellCheck={false} rows={12} value={text} disabled={!saved || busy} readOnly={saved?.editable !== true} onChange={event => {setText(event.target.value); setNotice('');}} />
      </label>
      {saved && <p className="muted small">{saved.editable ? '빈 내용도 저장할 수 있습니다. 스킬 경로와 참조 안내는 자동으로 추가하며, 엔진 자체 지침과 프로젝트 지침은 유지됩니다.' : '기본 지침은 허브가 실행 중인 기기에서 편집할 수 있습니다.'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="muted small" role="status">{notice}</p>}
      {conflict && <div className="instructions-conflict">
        <p className="muted small">편집한 내용은 유지했습니다. 서버 내용을 확인하고 필요한 부분을 위 입력란에 반영한 뒤 저장하세요.</p>
        {latest && <label className="field"><span className="lbl">서버의 현재 지침</span><textarea className="input" rows={5} readOnly value={latest.text} /></label>}
        <div className="form-actions">
          <button className="btn" type="button" disabled={loading || busy} onClick={() => {setLatest(undefined); setLoad(previous => ({kind: 'latest', attempt: previous.attempt + 1}));}}>서버 변경 확인</button>
          {latest && <button className="btn" type="button" disabled={loading || busy} onClick={() => void save(latest.revision)}>내 편집으로 덮어쓰기</button>}
        </div>
      </div>}
      <div className="form-actions">
        {!saved && !loading && <button className="btn" type="button" onClick={() => setLoad(previous => ({kind: 'initial', attempt: previous.attempt + 1}))}>다시 불러오기</button>}
        {saved?.editable && <><button className="btn" type="button" disabled={busy} onClick={() => {setText(saved.defaults); setNotice('');}}>기본값 불러오기</button>
        <button className="btn primary" type="submit" disabled={busy || loading || conflict || text === saved.text}>{busy ? '저장 중…' : '저장'}</button></>}
        {!panel.embedded && <button className="btn" type="button" onClick={close} disabled={busy}>닫기</button>}
      </div>
    </form>
  </SettingsEditor>;
}
