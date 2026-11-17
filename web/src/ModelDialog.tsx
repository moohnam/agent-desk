import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { workspaceId } from './workspace.ts';
import { ENGINE_EFFORTS, ENGINE_INFO, ENGINE_LABEL, ENGINE_MODELS, ENGINES, MODEL_LABEL, type EngineName, type ModelName } from '../../shared/compose.ts';
import { SettingsEditor, useSettingsPanel } from './settingsPanel.tsx';
import { saveSettings } from './settings.ts';
import { resetTime } from './format.ts';
import type { EngineUsage, Settings } from './types.ts';
import './model-dialog.css';

const LOW_AT = 80;
const errorMessage = (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
  ? '응답 시간이 초과되었습니다. 다시 시도하세요.' : error instanceof Error ? error.message : String(error);

/** Settings and usage belong to this hub, independently of the selected task's workspace. */
async function read<T>(path: string, signal: AbortSignal, timeout = 15000): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

function checkedSettings(value: Settings): Settings {
  if (!value || !ENGINES.every(engine => value[engine]
    && (value[engine].model === null || ENGINE_MODELS[engine].includes(value[engine].model!))
    && (value[engine].effort === null || ENGINE_EFFORTS[engine].includes(value[engine].effort!))))
    throw new Error('저장된 기본 모델 설정을 확인하지 못했습니다. 다시 불러오세요.');
  return value;
}

function fetchedTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '조회 시각 없음' : time.toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

type UsageState = { value: EngineUsage } | { error: string };
function UsageRows({ state }: {state: UsageState | undefined}) {
  if (!state) return <p className="muted small" role="status">사용량을 불러오는 중…</p>;
  if ('error' in state) return <p className="error small" role="alert">사용량 조회 실패: {state.error}</p>;
  const usage = state.value;
  return <>
    <div className="model-usage-heading"><strong>사용량{usage.plan ? ` · ${usage.plan}` : ''}</strong>
      <span className="muted small">조회 {fetchedTime(usage.fetchedAt)}</span></div>
    {usage.error && <p className="error small" role="alert">조회 안내: {usage.error}</p>}
    {!usage.windows.length && !usage.error && <p className="muted small">이 계정에서 제공한 사용량 정보가 없습니다.</p>}
    {!!usage.windows.length && <ul className="model-usage-list">
      {usage.windows.map((window, index) => {
        const percent = window.usedPercent != null && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null;
        const reset = window.resetsAt && !Number.isNaN(Date.parse(window.resetsAt)) ? resetTime(window.resetsAt) : null;
        return <li key={`${window.label}-${index}`} className={percent != null && percent >= LOW_AT ? 'low' : undefined}>
          <span className="model-usage-name">{window.label}</span>
          <span className="model-usage-percent">{percent === null ? '정보 없음' : `${percent}% 사용`}</span>
          <span className="model-usage-bar" aria-hidden="true"><i style={{width: `${percent ?? 0}%`}} /></span>
          <span className="model-usage-reset muted">{reset ? `초기화 ${reset}` : '초기화 시각 없음'}</span>
        </li>;
      })}
    </ul>}
  </>;
}

/** New-task defaults and the hub CLI accounts' plan usage share one editor. */
export function ModelDialog({ onClose, prefetchUsage=false }: { onClose: () => void; prefetchUsage?:boolean }) {
  const [savedPick, setSavedPick] = useState('');
  const [notice, setNotice] = useState('');
  const [pick, setPick] = useState<Settings>();
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [usage, setUsage] = useState<Partial<Record<EngineName, UsageState>>>({});
  const [usageAttempt, setUsageAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const panel = useSettingsPanel(!!pick && JSON.stringify(pick) !== savedPick, saving);
  const usageActive = prefetchUsage || panel.active;
  const alive = useRef(false);
  const saveRequest = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; saveRequest.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSettingsLoading(true); setSettingsError('');
    void read<Settings>('settings', controller.signal).then(checkedSettings).then(value => {
      if (!controller.signal.aborted) { setPick(value); setSavedPick(JSON.stringify(value)); }
    }, error => { if (!controller.signal.aborted) setSettingsError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setSettingsLoading(false); });
    return () => controller.abort();
  }, [settingsAttempt]);
  useEffect(() => {
    if (workspaceId || !usageActive) return;
    const controller = new AbortController();
    setUsage({});
    for (const engine of ENGINES) {
      // The hub's CLI readers time out after 30 seconds; leave time for that error to arrive.
      void read<EngineUsage>(`usage?engine=${engine}${usageAttempt ? '&refresh=1' : ''}`, controller.signal, 35000).then(value => {
        if (!value || !Array.isArray(value.windows)) throw new Error('사용량 응답을 확인하지 못했습니다');
        if (!controller.signal.aborted) setUsage(previous => ({...previous, [engine]: {value}}));
      }).catch(error => {
        if (!controller.signal.aborted) setUsage(previous => ({...previous, [engine]: {error: errorMessage(error)}}));
      });
    }
    return () => controller.abort();
  }, [usageAttempt, usageActive]);
  const loadingUsage = !workspaceId && ENGINES.some(engine => !usage[engine]);
  const set = (engine: EngineName, value: Partial<Settings[EngineName]>) => {
    setPick(previous => previous ? {...previous, [engine]: {...previous[engine], ...value}} : previous);
    setError(''); setNotice('');
  };
  const close = () => { if (!saving) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pick || settingsLoading || settingsError || saving) return;
    setSaving(true); setError('');
    const controller = new AbortController(); saveRequest.current = controller;
    try { await saveSettings(pick, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])); if (alive.current) { setSavedPick(JSON.stringify(pick)); if (panel.embedded) setNotice('저장했습니다'); else onClose(); } }
    catch (error) {
      if (alive.current) {
        const message = errorMessage(error);
        setError(message === 'HTTP 404' || message.startsWith('no route') ? '허브를 재시작하면 쓸 수 있습니다.' : message);
      }
    } finally { if (saveRequest.current === controller) saveRequest.current = null; if (alive.current) setSaving(false); }
  };
  return <SettingsEditor title="기본 모델·사용량" wide onClose={close}>
    <form onSubmit={submit} className="model-dialog-form">
      <div className="model-dialog-scroll">
        <p className="muted small model-dialog-intro">모델·effort 태그 없이 시작하는 새 작업의 기본값입니다. 작업에서 태그를 지정하면 해당 작업에 유지됩니다.</p>
        <p className="muted small model-dialog-source">사용량은 허브 기기의 CLI 로그인 계정 전체 기준이며, 터미널 사용도 포함합니다.</p>
        {settingsLoading && <p className="muted small" role="status">저장된 기본 모델 설정을 불러오는 중…</p>}
        {settingsError && <div className="model-settings-error"><p className="error small" role="alert">설정 조회 실패: {settingsError}</p>
          <button type="button" className="btn" onClick={() => setSettingsAttempt(value => value + 1)}>설정 다시 불러오기</button></div>}
        {ENGINES.map(engine => <section key={engine} className="model-engine" aria-label={ENGINE_LABEL[engine]}>
          <fieldset className="model-engine-settings" disabled={!pick || settingsLoading || !!settingsError || saving}>
            <legend>{ENGINE_LABEL[engine]}</legend>
            <label className="field"><span className="lbl">기본 모델{ENGINE_INFO[engine].family && <small>선택한 계열의 최신 버전</small>}</span>
              <select className="input model-select" aria-label={`${ENGINE_LABEL[engine]} 기본 모델`} value={pick?.[engine].model ?? ''}
                onChange={event => set(engine, {model: event.target.value ? event.target.value as ModelName : null})}>
                <option value="">{ENGINE_LABEL[engine]} 기본</option>
                {ENGINE_MODELS[engine].map(model => <option key={model} value={model}>{MODEL_LABEL[model]}</option>)}
              </select>
            </label>
            <div className="field"><span className="lbl">추론 강도 · effort</span>
              <div className="model-efforts" role="radiogroup" aria-label={`${ENGINE_LABEL[engine]} effort`}>
                {[null, ...ENGINE_EFFORTS[engine]].map(effort => <label key={effort ?? 'default'} className="model-effort-choice">
                  <input type="radio" name={`${engine}-effort`} value={effort ?? ''} checked={(pick?.[engine].effort ?? null) === effort} onChange={() => set(engine, {effort})} />
                  <span>{effort ?? '모델 기본'}</span>
                </label>)}
              </div>
              <span className="muted small">지원하지 않는 단계는 가까운 단계로 실행합니다.{engine === 'codex' && ' ultra는 Codex에서만 지원합니다.'}</span>
            </div>
          </fieldset>
          <div className="model-engine-usage" aria-label={`${ENGINE_LABEL[engine]} 사용량`}>
            {workspaceId ? <p className="muted small">사용량은 허브 화면에서 확인할 수 있습니다.</p> : <UsageRows state={usage[engine]} />}
          </div>
        </section>)}
      </div>
      <footer className="model-dialog-footer">
        {error && <p className="error small" role="alert">{error}</p>}
        {notice && <p className="muted small" role="status">{notice}</p>}
        <div className="form-actions">
          {!workspaceId && <button type="button" className="btn" disabled={loadingUsage || saving} onClick={() => setUsageAttempt(value => value + 1)}>
            <RefreshCw aria-hidden="true" />{loadingUsage ? '조회 중…' : '사용량 새로고침'}</button>}
          <span className="spacer" />
          {!panel.embedded && <button type="button" className="btn" disabled={saving} onClick={close}>취소</button>}
          <button className="btn primary" disabled={!pick || settingsLoading || !!settingsError || saving}>{saving ? '저장 중…' : '저장'}</button>
        </div>
      </footer>
    </form>
  </SettingsEditor>;
}
