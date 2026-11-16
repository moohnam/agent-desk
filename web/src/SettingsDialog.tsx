import { InstructionsDialog } from './InstructionsDialog.tsx';
import { useEffect, useRef, useState } from 'react';
import { Bot, Plug, Server } from 'lucide-react';
import { Modal } from './Modal.tsx';
import { ConnectorsPanel } from './Connectors.tsx';
import { WorkspaceDeliveries } from './Workspaces.tsx';
import './settings-dialog.css';

const SECTIONS = [
  { id: 'agent', label: '에이전트', Icon: Bot },
  { id: 'connections', label: '연결', Icon: Plug },
  { id: 'runners', label: '러너', Icon: Server },
] as const;

function SettingRow({ title, description, onOpen }: { title: string; description: string; onOpen: () => void }) {
  return <div className="settings-row">
    <div><strong>{title}</strong><p className="muted small">{description}</p></div>
    <button className="btn" onClick={onOpen} aria-label={`${title} 열기`}>열기</button>
  </div>;
}

/** Management entry points share one home; existing editors keep their save/close behavior. */
export function SettingsDialog({ local, onClose, onModels, onSkills, onChannels, onRunners }: {
  local: boolean; onClose: () => void; onModels: () => void;
  onSkills?: () => void; onChannels?: () => void; onRunners: () => void;
}) {
  const [section, setSection] = useState<typeof SECTIONS[number]['id']>('agent');
  const [instructions, setInstructions] = useState(false);
  const instructionsOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!instructions && instructionsOpener.current) {
      instructionsOpener.current.focus();
      instructionsOpener.current = null;
    }
  }, [instructions]);
  return <><div inert={instructions} aria-hidden={instructions || undefined}><Modal title="설정" wide onClose={instructions ? () => {} : onClose}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="설정 항목">
        {SECTIONS.map(({ id, label, Icon }) => <button key={id} className="btn" aria-pressed={section === id}
          onClick={() => setSection(id)}><Icon aria-hidden="true" />{label}</button>)}
      </nav>
      <section className="settings-content" aria-label={SECTIONS.find(item => item.id === section)!.label} key={section}>
        {section === 'agent' && <>
          <h3>에이전트</h3>
          <SettingRow title="기본 모델·사용량" description="새 작업의 엔진별 기본 모델과 effort, 계정 사용량" onOpen={onModels} />
          <SettingRow title="기본 지침" description="이 허브에서 시작하는 실행에 전달할 공통 지침" onOpen={() => { instructionsOpener.current = document.activeElement as HTMLElement; setInstructions(true); }} />
          {onSkills && <SettingRow title="스킬" description="#이름으로 불러오는 스킬과 부속 파일 관리" onOpen={onSkills} />}
        </>}
        {section === 'connections' && <>
          <ConnectorsPanel local={local} />
          {onChannels && <>
            <h3>구독·수신 채널</h3>
            <SettingRow title="RSS·Atom / 봇 알림" description="피드 URL 구독과 봇 입력을 관리하고 컬럼에서 열기" onOpen={onChannels} />
          </>}
        </>}
        {section === 'runners' && <>
          <h3>러너</h3>
          {local ? <SettingRow title="러너 연결 관리" description="원격 머신 등록과 공유 러너 연결·접근 설정" onOpen={onRunners} />
            : <p className="muted small">러너 등록과 연결 관리는 허브가 실행 중인 기기에서 할 수 있습니다.</p>}
          <WorkspaceDeliveries />
        </>}
      </section>
    </div>
  </Modal></div>{instructions && <InstructionsDialog onClose={() => setInstructions(false)} />}</>;
}
