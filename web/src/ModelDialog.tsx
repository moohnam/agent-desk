import { useState, type FormEvent } from 'react';
import { ENGINE_EFFORTS, ENGINE_LABEL, ENGINE_MODELS, MODEL_LABEL, type EngineName } from '../../hub/src/compose.ts';
import { Modal } from './Compose.tsx';
import { saveSettings, useSettings } from './settings.ts';
import type { Settings } from './types.ts';

const ENGINES: EngineName[] = ['claude', 'codex'];
const TAG_HINT: Record<EngineName, string> = {
  claude: '#opus #sonnet #haiku',
  codex: '#sol #astra #terra #luna (계열의 최신 버전)',
};

/** "모델": the model and effort new tasks of each engine start with when the message names none. */
export function ModelDialog({ onClose }: { onClose: () => void }) {
  const cur = useSettings();
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
        <p className="muted small">태그 없이 시작하는 새 작업에 씁니다. 작업마다 모델 태그와 <code>#low</code> … <code>#max</code>
          {' '}태그로 바꿀 수 있고, 바꾼 값은 그 작업에 유지됩니다. <code>#ultra</code>는 Codex에서만 씁니다.</p>
        {ENGINES.map((e) => (
          <fieldset key={e} className="field-group">
            <legend>{ENGINE_LABEL[e]} <small className="muted">{TAG_HINT[e]}</small></legend>
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
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <button className="btn primary">저장</button>
        </div>
      </form>
    </Modal>
  );
}
