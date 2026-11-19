import { catalogModel } from '../../shared/model-catalog.ts';
import {useModelCatalogs} from './modelCatalogs.ts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { ENGINE_EFFORTS, ENGINE_INFO, ENGINE_LABEL, ENGINE_MODELS, ENGINES, MODEL_LABEL, catalogModelName, modelReference, modelEngine, modelLabel, type EngineName, type ModelName } from '../../shared/compose.ts';
import { SettingsEditor, useSettingsPanel } from './settingsPanel.tsx';
import { saveSettings } from './settings.ts';
import { resetTime } from './format.ts';
import type { Settings } from './types.ts';
import { checkUsageReading, checkUsageTargets, type UsageReading, type UsageTarget } from '../../shared/runner-usage.ts';
import './model-dialog.css';

const LOW_AT = 20;
const errorMessage = (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
  ? '응답 시간이 초과되었습니다. 다시 시도하세요.' : error instanceof Error ? error.message : String(error);

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
    && (value[engine].model === null || modelEngine(value[engine].model!) === engine)
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

const usageKey = (target: UsageTarget) => `${target.source ?? ''}/${target.id}`;
function UsageRows({ reading }: { reading: UsageReading | undefined }) {
  if (!reading) return <p className="muted small" role="status">사용량을 불러오는 중…</p>;
  if (reading.status === 'unsupported') return <p className="muted small">이 러너에서 사용량을 조회할 수 없습니다. 러너 버전과 엔진 지원 여부를 확인하세요.</p>;
  const usage = reading.value;
  const notice = reading.status === 'offline' ? '러너 연결이 끊겼습니다.'
    : reading.status === 'error' ? reading.message ?? '사용량을 조회하지 못했습니다.' : '';
  return <>
    {notice && <p className="muted small" role="status">{notice}{usage && ' 마지막 조회값을 표시합니다.'}</p>}
    {usage && <>
    <div className="model-usage-heading"><strong>사용량{usage.plan ? ` · ${usage.plan}` : ''}</strong>
      <span className="muted small">조회 {fetchedTime(usage.fetchedAt)}</span></div>
    {!usage.windows.length && <p className="muted small">이 계정에서 제공한 한도 정보가 없습니다.</p>}
    {!!usage.windows.length && <ul className="model-usage-list">
      {usage.windows.map((window, index) => {
        const percent = window.usedPercent == null ? null : Math.round((100 - window.usedPercent) * 10) / 10;
        const reset = window.resetsAt && !Number.isNaN(Date.parse(window.resetsAt)) ? resetTime(window.resetsAt) : null;
        return <li key={`${window.label}-${index}`} className={percent != null && percent <= LOW_AT ? 'low' : undefined}>
          <span className="model-usage-name">{window.label}</span>
          <span className="model-usage-percent">{percent === null ? '정보 없음' : `${percent}% 남음`}</span>
          <span className="model-usage-bar" aria-hidden="true"><i style={{width: `${percent ?? 0}%`}} /></span>
          <span className="model-usage-reset muted">{reset ? `초기화 ${reset}` : '초기화 시각 없음'}</span>
        </li>;
      })}
    </ul>}
    </>}
  </>;
}

/** New-task defaults and runner account meters share one editor. */
export function ModelDialog({ onClose, prefetchUsage=false }: { onClose: () => void; prefetchUsage?:boolean }) {
  const models = useModelCatalogs();
  const [savedPick, setSavedPick] = useState('');
  const [notice, setNotice] = useState('');
  const [pick, setPick] = useState<Settings>();
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [targets, setTargets] = useState<UsageTarget[]>([]);
  const [targetsError, setTargetsError] = useState('');
  const [selectedRunner, setSelectedRunner] = useState('');
  const [usage, setUsage] = useState<{ key: string; values: Partial<Record<EngineName, UsageReading>> }>();
  const [usageAttempt, setUsageAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const panel = useSettingsPanel(!!pick && JSON.stringify(pick) !== savedPick, saving);
  const usageActive = prefetchUsage || panel.active;
  const target = targets.find(candidate => usageKey(candidate) === selectedRunner) ?? targets[0];
  const targetId = target?.id, targetSource = target?.source, targetKey = target && usageKey(target);
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
    if (!usageActive) return;
    const controller = new AbortController();
    void read<unknown>('runner-usage', controller.signal).then(value => {
      if (!checkUsageTargets(value)) throw new Error('러너 목록 응답을 확인하지 못했습니다.');
      if (!controller.signal.aborted) { setTargets(value); setTargetsError(''); }
    }).catch(error => { if (!controller.signal.aborted) setTargetsError(errorMessage(error)); });
    return () => controller.abort();
  }, [usageActive, usageAttempt]);
  useEffect(() => {
    if (!usageActive || !targetId || !targetKey) return;
    const controller = new AbortController();
    setUsage({ key: targetKey, values: {} });
    const params = new URLSearchParams({ runner: targetId });
    if (targetSource) params.set('source', targetSource);
    if (usageAttempt) params.set('refresh', '1');
    const update = (engine: EngineName, reading: UsageReading) => {
      if (!controller.signal.aborted) setUsage(previous => previous?.key === targetKey
        ? { key: targetKey, values: { ...previous.values, [engine]: reading } } : previous);
    };
    for (const engine of ENGINES) {
      params.set('engine', engine);
      void read<unknown>(`runner-usage?${params}`, controller.signal, 45_000).then(value => {
        if (!checkUsageReading(value, engine)) throw new Error('사용량 응답을 확인하지 못했습니다.');
        update(engine, value);
      }).catch(error => {
        update(engine, { status: 'error', message: errorMessage(error) });
      });
    }
    return () => controller.abort();
  }, [targetId, targetSource, targetKey, usageAttempt, usageActive]);
  const readings = usage?.key === targetKey ? usage?.values : undefined;
  const loadingUsage = !!target && ENGINES.some(engine => !readings?.[engine]);
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
        <label className="field model-usage-runner">
          <span className="lbl">사용량을 조회할 러너</span>
          <select className="input model-select" value={targetKey ?? ''} disabled={!targets.length}
            onChange={event => { setSelectedRunner(event.target.value); setUsageAttempt(0); }}>
            {!targets.length && <option value="">러너 목록을 불러오는 중…</option>}
            {targets.map(candidate => <option key={usageKey(candidate)} value={usageKey(candidate)}>{candidate.label}</option>)}
          </select>
        </label>
        <p className="muted small model-dialog-source">러너가 로그인한 계정의 전체 한도입니다. 같은 계정을 쓰는 러너와 터미널은 한도를 공유합니다.</p>
        {targetsError && <p className="error small" role="alert">러너 목록을 조회하지 못했습니다. {targetsError}</p>}
        {settingsLoading && <p className="muted small" role="status">저장된 기본 모델 설정을 불러오는 중…</p>}
        {settingsError && <div className="model-settings-error"><p className="error small" role="alert">설정 조회 실패: {settingsError}</p>
          <button type="button" className="btn" onClick={() => setSettingsAttempt(value => value + 1)}>설정 다시 불러오기</button></div>}
        {models.error && <p className="error small" role="alert">모델 목록 조회 실패: {models.error} · 기존 태그와 설정은 유지합니다.</p>}
        {ENGINES.map(engine => {
          const catalogs = models.runners.flatMap(r=>r.catalogs[engine] ? [{runner:r,catalog:r.catalogs[engine]!}] : []);
          const choices = [...new Map(catalogs.flatMap(({catalog})=>catalog.models.map(model=>[model.id,model] as const))).values()];
          const selected = pick?.[engine].model;
          const selectedModel = catalogs.map(({catalog})=>catalogModel(catalog,selected ?? undefined,pick?.[engine].effort ?? undefined)).find(Boolean);
          const supported = modelReference(selected) && selectedModel?.efforts !== null && selectedModel?.efforts !== undefined
            ? selectedModel.efforts : ENGINE_EFFORTS[engine];
          const visibleEfforts = [...new Set([...supported,...(pick?.[engine].effort ? [pick[engine].effort!] : [])])];
          const changeModel = (model: ModelName | null) => {
            const next = catalogs.map(({catalog})=>catalogModel(catalog,model ?? undefined)).find(Boolean);
            const effort = pick?.[engine].effort;
            set(engine,{model,...(modelReference(model) && effort && next?.efforts && !next.efforts.includes(effort) ? {effort:null} : {})});
          };
          return <section key={engine} className="model-engine" aria-label={ENGINE_LABEL[engine]}>
          <fieldset className="model-engine-settings" disabled={!pick || settingsLoading || !!settingsError || saving}>
            <legend>{ENGINE_LABEL[engine]}</legend>
            <label className="field"><span className="lbl">기본 모델{ENGINE_INFO[engine].family && <small>기존 태그는 계열 최신, 실제 ID는 선택한 버전</small>}</span>
              <select className="input model-select" aria-label={`${ENGINE_LABEL[engine]} 기본 모델`} value={pick?.[engine].model ?? ''}
                onChange={event => changeModel(event.target.value ? event.target.value as ModelName : null)}>
                <option value="">{ENGINE_LABEL[engine]} 기본</option>
                {ENGINE_MODELS[engine].map(model => <option key={model} value={model}>{MODEL_LABEL[model]} · 기존 태그</option>)}
                {choices.map(model => <option key={model.id} value={catalogModelName(engine,model.id)}>{model.label} · {model.id}</option>)}
                {selected && modelReference(selected) && !choices.some(model=>catalogModelName(engine,model.id)===selected)
                  && <option value={selected} disabled>{modelLabel(selected)} · 현재 목록에 없음</option>}
              </select>
            </label>
            <div className="field"><span className="lbl">추론 강도 · effort</span>
              <div className="model-efforts" role="radiogroup" aria-label={`${ENGINE_LABEL[engine]} effort`}>
                {[null, ...visibleEfforts].map(effort => <label key={effort ?? 'default'} className="model-effort-choice">
                  <input type="radio" name={`${engine}-effort`} value={effort ?? ''} checked={(pick?.[engine].effort ?? null) === effort} disabled={effort !== null && !supported.includes(effort)} onChange={() => set(engine, {effort})} />
                  <span>{effort ?? '모델 기본'}</span>
                </label>)}
              </div>
              <span className="muted small">{modelReference(selected) ? selectedModel?.efforts === null ? 'CLI가 이 모델의 effort 정보를 제공하지 않았습니다.' : '실제 모델 ID와 지원하는 effort를 그대로 실행합니다.' : '기존 계열 태그는 지원하는 가까운 단계로 실행합니다.'}</span>
              {selectedModel && <span className="muted small">실제 지원 effort: {selectedModel.efforts?.join(', ') || (selectedModel.efforts ? '없음' : '정보 없음')}</span>}
              {catalogs.map(({runner,catalog})=><p key={runner.runnerId} className="muted small">{runner.label}{!runner.connected && ' · 연결 끊김'} · {catalog.updatedAt ? `모델 ${catalog.models.length}개 · 조회 ${fetchedTime(catalog.updatedAt)}` : '모델 목록 확인 중'}{catalog.error && ` · 갱신 실패: ${catalog.error}${catalog.updatedAt ? ' · 마지막 성공 목록 유지' : ''}`}</p>)}
            </div>
          </fieldset>
          <div className="model-engine-usage" aria-label={`${ENGINE_LABEL[engine]} 사용량`}>
            {target && <UsageRows reading={readings?.[engine]} />}
          </div>
        </section>; })}
      </div>
      <footer className="model-dialog-footer">
        {error && <p className="error small" role="alert">{error}</p>}
        {notice && <p className="muted small" role="status">{notice}</p>}
        <div className="form-actions">
          <button type="button" className="btn" disabled={loadingUsage || saving} onClick={() => setUsageAttempt(value => value + 1)}>
            <RefreshCw aria-hidden="true" />{loadingUsage ? '조회 중…' : '사용량 새로고침'}</button>
          <button type="button" className="btn" disabled={models.loading || saving} onClick={models.refresh}><RefreshCw aria-hidden="true" />{models.loading ? '모델 조회 중…' : '모델 목록 새로고침'}</button>
          <span className="spacer" />
          {!panel.embedded && <button type="button" className="btn" disabled={saving} onClick={close}>취소</button>}
          <button className="btn primary" disabled={!pick || settingsLoading || !!settingsError || saving}>{saving ? '저장 중…' : '저장'}</button>
        </div>
      </footer>
    </form>
  </SettingsEditor>;
}
