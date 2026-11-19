import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, ChevronDown, Package, Plug, Server } from 'lucide-react';
import { Modal } from './Modal.tsx';
import { ModelDialog } from './ModelDialog.tsx';
import { InstructionsDialog } from './InstructionsDialog.tsx';
import { ChannelsDialog } from './Channels.tsx';
import { RunnersDialog } from './Runners.tsx';
import { SessionsPanel } from './Sessions.tsx';
import { ConnectorsPanel } from './Connectors.tsx';
import { WorkspaceDeliveries } from './Workspaces.tsx';
import { SettingsPanelContext, type PanelGuard } from './settingsPanel.tsx';
import type { Channel, TaskView } from './types.ts';
import { Updates } from './Updates.tsx';
import type { UpdatesState } from './useUpdates.ts';
import type { RunnerConnectionProblem } from '../../shared/api.ts';
import './settings-dialog.css';

const SECTIONS = [
  { id: 'agent', label: '에이전트', Icon: Bot },
  { id: 'connections', label: '연결', Icon: Plug },
  { id: 'runners', label: '러너', Icon: Server },
  { id: 'version', label: '버전 정보', Icon: Package },
] as const;
const runnerGuidance: Record<RunnerConnectionProblem, string> = {
  unreachable: '로컬 러너에 연결할 수 없습니다. 러너가 실행 중인지 확인하세요.',
  authentication: '로컬 러너의 연결 확인을 받지 못했습니다. 허브와 러너의 연결 토큰 설정 및 러너 로그를 확인하세요.',
  token: '허브가 로컬 러너의 연결 토큰을 읽지 못했습니다. 토큰 파일의 경로와 읽기 권한을 확인하세요.',
  disconnected: '로컬 러너와 연결이 끊겼습니다. 연결이 돌아오지 않으면 러너 실행 상태를 확인하세요.',
};

function SettingSection({title, description, visible, register, children, preload=false}: {
  title:string; description:string; visible:boolean;
  register:(id:string,state:PanelGuard)=>()=>void; children:ReactNode; preload?:boolean;
}) {
  const [open,setOpen]=useState(false),[visited,setVisited]=useState(false);
  const context=useMemo(()=>({active:visible&&open,register}),[visible,open,register]);
  return <div className="settings-disclosure">
    <button className="settings-row" aria-expanded={open} onClick={()=>{setVisited(true);setOpen(value=>!value);}}>
      <span><strong>{title}</strong><span className="muted small">{description}</span></span>
      <ChevronDown aria-hidden="true" />
    </button>
    <div className="settings-panel-body" hidden={!open}>
      {(preload||visited)&&<SettingsPanelContext.Provider value={context}>{children}</SettingsPanelContext.Provider>}
    </div>
  </div>;
}

/** Editors stay mounted after first expansion so folding or changing sections preserves drafts. */
export function SettingsDialog({ local, onClose, channels, onOpenChannel, tasks, onOpenSession, onChanged, manageChannels=true, updates, updateAvailable, runnerProblem }: {
  local:boolean; onClose:()=>void; channels:Channel[]; onOpenChannel:(channel:Channel)=>void;
  tasks:ReadonlyMap<string,TaskView>; onOpenSession:(taskId:string)=>void;
  onChanged:()=>Promise<unknown>; manageChannels?:boolean; updates:UpdatesState; updateAvailable:boolean; runnerProblem?:RunnerConnectionProblem;
}) {
  const [section,setSection]=useState<typeof SECTIONS[number]['id']>('agent');
  const [notice,setNotice]=useState('');
  const guards=useRef(new Map<string,PanelGuard>());
  const register=useCallback((id:string,state:PanelGuard)=>{guards.current.set(id,state);return()=>{guards.current.delete(id);};},[]);
  const versionContext=useMemo(()=>({active:section==='version',register}),[section,register]);
  const canClose=()=>{
    if([...guards.current.values()].some(state=>state.busy)){setNotice('처리가 끝난 뒤 닫아 주세요.');return false;}
    return ![...guards.current.values()].some(state=>state.dirty)||window.confirm('저장하지 않은 설정이 있습니다. 버리고 닫을까요?');
  };
  const close=()=>{if(canClose())onClose();};
  const panel=(id:typeof section,title:string,description:string,children:ReactNode,preload=false)=><SettingSection title={title} description={description} visible={section===id} register={register} preload={preload}>{children}</SettingSection>;
  return <Modal title="설정" wide onClose={close}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="설정 항목">
        {SECTIONS.map(({id,label,Icon})=>{
          const showUpdate = id === 'version' && updateAvailable;
          return <button key={id} className="btn" aria-pressed={section===id} aria-label={showUpdate ? `${label}: 새 버전 있음` : undefined}
            data-update={showUpdate ? '' : undefined} onClick={()=>{setSection(id);setNotice('');if(id==='version')updates.refreshLatest();}}>
            <Icon aria-hidden="true"/>{label}
          </button>;
        })}
      </nav>
      <div className="settings-pages">
        {notice&&<p className="muted small" role="status">{notice}</p>}
        <section className="settings-content" hidden={section!=='agent'} aria-label="에이전트">
          {panel('agent','기본 모델·사용량','새 작업의 기본 모델과 추론 강도, 계정 사용량',<ModelDialog onClose={close} prefetchUsage/>,true)}
          {panel('agent','기본 지침','이 허브에서 시작하는 실행에 전달할 공통 지침',<InstructionsDialog onClose={close}/>)}
        </section>
        <section className="settings-content" hidden={section!=='connections'} aria-label="연결">
          {panel('connections','외부 서비스','Slack · Jira · Confluence 연결',<ConnectorsPanel local={local}/>)}
          {manageChannels&&panel('connections','RSS·Atom / 봇 알림','구독·수신 채널 관리',<ChannelsDialog channels={channels} onClose={close} onChanged={onChanged} onOpen={channel=>{if(canClose())onOpenChannel(channel);}}/>)}
        </section>
        <section className="settings-content" hidden={section!=='runners'} aria-label="러너">
          {runnerProblem && <p className="error small" role="status">{runnerGuidance[runnerProblem]}</p>}
          {panel('runners','열린 세션','현재 실행 중인 엔진과 터미널 세션',<SessionsPanel tasks={tasks} onOpen={id=>{if(canClose()){onOpenSession(id);onClose();}}}/>)}
          {local?panel('runners','러너 연결 관리','원격 머신 등록과 공유 러너 연결',<RunnersDialog onClose={close}/>):<p className="muted small">러너 등록과 연결 관리는 허브가 실행 중인 기기에서 할 수 있습니다.</p>}
          {panel('runners','공유 러너 전달 내역','연결 대기 또는 처리에 실패한 요청',<WorkspaceDeliveries/>)}
        </section>
        <section className="settings-content" hidden={section!=='version'} aria-label="버전 정보">
          <SettingsPanelContext.Provider value={versionContext}>
            <Updates state={updates} local={local}/>
          </SettingsPanelContext.Provider>
        </section>
      </div>
    </div>
  </Modal>;
}
