import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Modal } from './Modal.tsx';
import type { RemoteRunnerView } from '../../shared/remote.ts';
import { WorkspaceConnections } from './Workspaces.tsx';

export function RunnersDialog({ onClose }: { onClose: () => void }) {
  const [runners,setRunners]=useState<RemoteRunnerView[]>([]);
  const [address,setAddress]=useState('');
  const [receipt,setReceipt]=useState<{runner:RemoteRunnerView;token:string}|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let active=true;
    const refresh=()=>api.runners().then(r=>{if(active)setRunners(r);}).catch(e=>{if(active)setError(String(e.message));});
    void refresh();const timer=setInterval(refresh,3000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  return <Modal title="원격 러너" onClose={onClose} wide>
    <div className="form">
      <p>프로젝트 경로에 <code>ws20:~/project</code>를 쓰면 등록된 머신에서 실행합니다. 같은 호스트에 러너가 여러 개면 <code>moohnam@ws20:~/project</code>처럼 계정을 지정하세요. 같은 저장소라도 머신과 디렉터리가 다르면 별도 프로젝트로 등록하세요.</p>
      {runners.map(r=><div className="field-group" key={r.id}>
        <strong>{r.address}</strong> · {r.connected?'연결됨':'연결 대기'} · 미수신 명령 {r.pending}개
        <button className="btn" onClick={async()=>{try{setReceipt(await api.rotateRunner(r.id));}catch(e){setError(e instanceof Error?e.message:String(e));}}}>연결 토큰 재발급</button>
        <div className="muted small">{r.last_seen?`마지막 연결 ${new Date(r.last_seen).toLocaleString()}`:'아직 연결하지 않았거나 연결이 끊겼습니다'}</div>
      </div>)}
      <form className="form" onSubmit={async e=>{
        e.preventDefault();if(busy)return;setBusy(true);setError('');
        try{const r=await api.registerRunner(address.trim());setReceipt(r);setAddress('');setRunners(await api.runners());}
        catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
      }}>
        <label>호스트 또는 SSH 별칭<input className="input" placeholder="ws20 또는 moohnam@ws20" value={address} onChange={e=>setAddress(e.target.value)} required /></label>
        <button className="btn" disabled={busy||!address.trim()}>러너 등록</button>
      </form>
      {receipt&&<section className="field-group">
        <strong>연결 토큰 — 이 창에서 한 번만 표시합니다</strong>
        <input className="input" type="password" readOnly value={receipt.token} aria-label="원격 러너 연결 토큰" />
        <button className="btn" onClick={()=>{void navigator.clipboard.writeText(receipt.token).catch(()=>setError('토큰을 선택해 직접 복사해 주세요'));}}>토큰 복사</button>
        <p className="small">대상 머신에 Agent Desk 저장소와 Node.js 26 이상을 설치하고 <code>npm ci</code>를 실행하세요. 위 토큰은 해당 머신의 본인만 읽을 수 있는 파일에 저장합니다.</p>
        <pre className="runner-command">{`AGENT_DESK_HUB_URL=https://허브주소 \\\nAGENT_DESK_RUNNER_ID=${receipt.runner.id} \\\nAGENT_DESK_REMOTE_TOKEN_FILE=토큰파일의_절대경로 \\\nnpm run runner:remote`}</pre>
        <p className="small muted">이 주소 표기는 실행 위치를 식별합니다. SSH 접속이나 프로그램 설치를 자동으로 수행하지 않습니다. HTTPS 또는 localhost SSH 터널을 사용하세요. CLI 로그인과 저장소는 대상 계정에 준비되어 있어야 합니다.</p>
      </section>}
      <p className="muted small">연결이 끊겨도 실행은 대상 머신에서 이어지고, 메시지와 결과는 양쪽 디스크에 보관됩니다. 승인이 필요하면 답을 받을 때까지 기다립니다. 연결 토큰과 전달 DB를 보관하세요.</p>
      {error&&<p className="error" role="alert">{error}</p>}
      <WorkspaceConnections />
    </div>
  </Modal>;
}
