import { useSettingsPanel } from './settingsPanel.tsx';
import type { UpdatesState } from './useUpdates.ts';
import { Settings } from 'lucide-react';
import type { UpdateRole } from '../../shared/update.ts';

export function UpdateSettingsButton({available, open, onOpen}: {available: boolean; open: boolean; onOpen: () => void}) {
  return <button className="btn settings-button" title={`설정: 에이전트·연결·러너·버전 정보${available ? ' (새 버전 있음)' : ''}`} aria-label={available ? '설정: 새 버전 있음' : '설정'} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
    <Settings />{available && <span className="settings-update-badge" aria-hidden="true" />}
  </button>;
}

const PHASES = {
  'not-configured': '업데이트 설정 없음', idle: '확인 대기', checking: '새 버전 확인 중',
  ready: '새 버전 준비됨', waiting: '작업 종료 대기', switching: '업데이트 적용 중',
  active: '적용됨', failed: '업데이트 실패',
};
const roleLabel = (role: UpdateRole) => ({hub: '허브', daemon: '러너 데몬', local: '로컬 러너', shared: '공유 러너', remote: '원격 러너'}[role]);

export function Updates({state, local}: {state: UpdatesState; local: boolean}) {
  const {view, error, busy} = state;
  useSettingsPanel(false, busy);
  const applying = view?.phase === 'switching';
  const disabled = busy || applying;
  const canApprove = !!view?.available && view.canApply && !view.approval && local && !disabled && !view.checking && !state.unavailable;
  const version = view?.latest ?? view?.available;
  const versionsDiffer = !!view?.latest && !!view.available && view.latest !== view.available;
  const phase = view?.phase === 'waiting' && view.approval?.mode !== 'when-idle'
    ? '실행 중인 작업 때문에 적용하지 못했습니다. 작업 종료 후 다시 선택해 주세요.'
    : view ? PHASES[view.phase] : '버전 정보를 불러오는 중입니다.';
  return <div className="updates-panel">
    <dl className="update-versions">
      <dt>현재 허브 버전</dt><dd><code>{view?.current ?? '확인할 수 없음'}</code></dd>
      <dt>{view?.current ? '새 버전' : '원격 버전'}</dt><dd>{version && version === view?.current ? '없음 · 현재 최신 버전입니다.' : <code>{version ?? (view?.checking ? '확인 중' : '확인된 버전 없음')}</code>}</dd>
      {!!view?.available && <><dt>준비된 버전</dt><dd><code>{view.available}</code></dd></>}
      <dt>적용 대상</dt><dd>{view?.targets.length ? view.targets.map(roleLabel).join(' · ') : '설정 없음'}</dd>
    </dl>
    <p className="muted small">이 허브 머신의 설정에 명시된 서비스만 적용합니다. 연결된 다른 머신 전체를 업데이트하지 않습니다.</p>
    <p className="muted small" role="status">{phase}</p>
    {view && !view.current && <p className="muted small">현재 실행 버전을 알 수 없어 원격 버전과 비교할 수 없습니다.</p>}
    {view?.discoveryError && <p className="muted small">자동 버전 확인 실패: {view.discoveryError} 새 버전 확인 버튼으로 다시 확인해 주세요.</p>}
    {view?.ciPending && <p className="muted small">최신 커밋의 GitHub CI 통과 기록이 없습니다.</p>}
    {view?.summary && <div className="update-summary">
      <strong>준비된 버전의 변경 요약</strong>
      <p className="muted small"><code>{view.available}</code> 기준</p>
      <p className="muted small">파일 {view.summary.files}개 · {[
        view.summary.hub && '허브 변경', view.summary.runner && '러너 변경',
      ].filter(Boolean).join(' · ') || '공통 변경'}</p>
      <ul>{view.summary.commits.map(commit => <li key={commit.sha}><code title={commit.sha}>{commit.sha.slice(0, 8)}</code> {commit.subject}</li>)}</ul>
    </div>}
    {view?.reason && <p className="muted small">{view.reason}</p>}
    {!local && <p className="muted small">확인과 적용은 허브가 실행 중인 기기에서 선택해 주세요.</p>}
    {view?.approval && <div className="update-approval" role="status">
      <p><code>{view.approval.commit}</code> 버전에 {view.approval.mode === 'when-idle' ? '작업 종료 후 적용을 예약했습니다.' : '지금 적용을 요청했습니다.'}</p>
      {view.approval.mode === 'when-idle' && !applying && <button className="btn" disabled={!local || disabled} onClick={() => void state.cancel(view.approval!.commit)}>예약 취소</button>}
    </div>}
    {(error || view?.error) && <p className="error small" role="alert">{error || view?.error}</p>}
    <div className="row">
      <button className="btn" disabled={!local || disabled || !!view?.checking || !view?.configured} onClick={() => void state.check()}>{view?.checking ? '확인·준비 중…' : view?.latest && view.latest !== view.available ? '새 버전 준비' : '새 버전 확인'}</button>
      {!!view?.available && <>
        <button className="btn primary" disabled={!canApprove} onClick={() => void state.approve(view!.available!, 'immediate')}>지금 적용</button>
        <button className="btn" disabled={!canApprove} onClick={() => void state.approve(view!.available!, 'when-idle')}>작업 종료 후 적용</button>
      </>}
    </div>
    {!!view?.available && !view.approval && <p className="muted small">
      {versionsDiffer && '발견한 버전과 준비된 버전이 다릅니다. '}
      {versionsDiffer && local && !view.checking && '최신 커밋을 다시 확인하고 준비하려면 ‘새 버전 준비’를 누르세요. '}
      적용 버튼은 화면의 준비된 버전을 승인합니다. 지금 적용할 수 없어 실패해도 자동으로 예약하지 않습니다.
    </p>}
  </div>;
}
