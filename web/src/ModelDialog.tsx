import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './api.ts';
import { ENGINE_EFFORTS, ENGINE_INFO, ENGINE_LABEL, ENGINE_MODELS, ENGINES, MODEL_LABEL, modelTagsOf, type EngineName } from '../../shared/compose.ts';
import { Modal } from './Modal.tsx';
import { saveSettings, useSettings } from './settings.ts';
import { resetTime } from './format.ts';
import type { EngineUsage, Settings } from './types.ts';


/** From this share used on, a window shows as running low. */
const LOW_AT = 80;

/** One engine's limit windows: a bar of the share used and when the window resets. */
function UsageRows({ usage }: { usage: EngineUsage | undefined | null }) {
  if (usage === undefined) return <span className="muted small">불러오는 중…</span>;
  if (usage === null) return <span className="muted small">불러오지 못했습니다</span>;
  if (usage.error && !usage.windows.length) return <span className="muted small">조회 실패: {usage.error}</span>;
  return (
    <ul className="usage">
      {usage.windows.map((w) => (
        <li key={w.label} className={w.usedPercent != null && w.usedPercent >= LOW_AT ? 'low' : undefined}>
          <span className="name">{w.label}</span>
          <span className="bar" aria-hidden><i style={{ width: `${Math.min(100, w.usedPercent ?? 0)}%` }} /></span>
          <span className="pct">{w.usedPercent == null ? '?' : `${w.usedPercent}%`}</span>
          <span className="reset muted">{w.resetsAt ? resetTime(w.resetsAt) : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "모델": the model and effort new tasks of each engine start with when the message names none,
 * with how much of each engine's plan limits is used (account-wide, terminal use included).
 */
export function ModelDialog({ onClose, onChannels }: { onClose: () => void; onChannels?: () => void }) {
  const cur = useSettings();
  /** Per engine, read separately so each shows as it arrives: missing while loading, null when the hub couldn't answer. */
  const [usage, setUsage] = useState<Partial<Record<EngineName, EngineUsage | null>>>({});
  const loadUsage = (refresh = false) => {
    setUsage({});
    for (const e of ENGINES) {
      api.usage(e, refresh).then((u) => setUsage((p) => ({ ...p, [e]: u })), () => setUsage((p) => ({ ...p, [e]: null })));
    }
  };
  const loading = ENGINES.some((e) => !(e in usage));
  useEffect(() => loadUsage(), []);
  const [pick, setPick] = useState<Settings>(cur);
  const [error, setError] = useState<string | null>(null);
  const set = (e: EngineName, v: Partial<Settings[EngineName]>) => setPick((p) => ({ ...p, [e]: { ...p[e], ...v } }));
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    try { await saveSettings(pick); onClose(); }
    catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m === 'HTTP 404' || m.startsWith('no route') ? '허브를 재시작하면 쓸 수 있습니다.' : m);
    }
  };
  return (
    <Modal title="기본 모델" onClose={onClose}>
      <form onSubmit={submit} className="form">
        {onChannels && <button type="button" className="btn" onClick={onChannels}>읽기 전용 채널 관리 · 봇 알림 / RSS·Atom</button>}
        <p className="muted small">태그 없이 시작하는 새 작업에 씁니다. 작업마다 모델 태그와 <code>#low</code> … <code>#max</code>
          {' '}태그로 바꿀 수 있고, 바꾼 값은 그 작업에 유지됩니다. <code>#ultra</code>는 Codex에서만 씁니다.</p>
        {ENGINES.map((e) => (
          <fieldset key={e} className="field-group">
            <legend>{ENGINE_LABEL[e]} <small className="muted">{modelTagsOf(e)}{ENGINE_INFO[e].family ? ' (계열의 최신 버전)' : ''}</small></legend>
            <div className="field">
              <span className="lbl">사용량{usage[e]?.plan ? ` (${usage[e]!.plan})` : ''}
                <small>계정 전체 기준, 사용 비율과 초기화 시각</small></span>
              <UsageRows usage={usage[e]} />
            </div>
            <div className="field">
              <span className="lbl">모델</span>
              <div className="pills" role="radiogroup" aria-label={`${ENGINE_LABEL[e]} 모델`}>
                <button type="button" role="radio" className="toggle" aria-pressed={pick[e].model === null} aria-checked={pick[e].model === null}
                  onClick={() => set(e, { model: null })}>{ENGINE_LABEL[e]} 기본</button>
                {ENGINE_MODELS[e].map((m) => (
                  <button key={m} type="button" role="radio" className="toggle" aria-pressed={pick[e].model === m} aria-checked={pick[e].model === m}
                    onClick={() => set(e, { model: m })}>{MODEL_LABEL[m]}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="lbl">effort<small>모델이 지원하지 않는 단계는 가까운 단계로 실행</small></span>
              <div className="pills" role="radiogroup" aria-label={`${ENGINE_LABEL[e]} effort`}>
                <button type="button" role="radio" className="toggle" aria-pressed={pick[e].effort === null} aria-checked={pick[e].effort === null}
                  onClick={() => set(e, { effort: null })}>모델 기본</button>
                {ENGINE_EFFORTS[e].map((x) => (
                  <button key={x} type="button" role="radio" className="toggle" aria-pressed={pick[e].effort === x} aria-checked={pick[e].effort === x}
                    onClick={() => set(e, { effort: x })}>{x}</button>
                ))}
              </div>
            </div>
          </fieldset>
        ))}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" title="사용량 다시 조회" disabled={loading} onClick={() => loadUsage(true)}>
            <RefreshCw /> 사용량</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <button className="btn primary">저장</button>
        </div>
      </form>
    </Modal>
  );
}
