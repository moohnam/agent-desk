import { useSettingsPanel } from './settingsPanel.tsx';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SharedWorkspaceView, WorkspaceDelivery, SshPeerView, OutgoingConnectRequest, WorkspaceConnectRequest } from '../../shared/workspace.ts';
import { Modal } from './Modal.tsx';
import { legacyWorkspaceId } from './workspace.ts';
import { discoverSources, getSources, legacySourceId, splitId, subscribeSources } from './federation.ts';
import { api } from './api.ts';
import type { TaskView } from './types.ts';
import type { RemoteRunnerView } from '../../shared/remote.ts';

export const useSources=()=>useSyncExternalStore(subscribeSources,getSources);
export function initialLocation(){try{if(legacyWorkspaceId){history.replaceState(history.state,'','/'+location.search);const selected=`workspace:${legacySourceId(legacyWorkspaceId)}`;localStorage.setItem('agent-desk.location',selected);return selected;}return localStorage.getItem('agent-desk.location')??'';}catch{return '';}}
export function inLocation(task:TaskView,location:string){
  if(!location)return true;
  const source=splitId(task.id)[0];
  if(location.startsWith('workspace:'))return source===location.slice(10);
  if(location==='local')return !source&&!task.runner_id?.startsWith('remote-');
  return !source&&task.runner_id===location.slice(7);
}

export async function workspaceCall<T>(path:string,method='GET',body?:unknown):Promise<T> {
  const res=await fetch('/api/workspaces'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const value=await res.json();if(!res.ok)throw new Error(value.error??`HTTP ${res.status}`);return value;
}
export function useWorkspaceRequests(active: boolean) {
  const [requests,setRequests]=useState<WorkspaceConnectRequest[]>([]);
  const sequence=useRef(0);
  const refresh=useCallback(async (signal?:AbortSignal)=>{
    const current=++sequence.current;
    try {
      const response=await fetch('/api/workspaces/ssh-requests',{signal});
      if (response.ok) {
        const items=await response.json();
        if (current===sequence.current && !signal?.aborted && Array.isArray(items)) setRequests(before=>JSON.stringify(before)===JSON.stringify(items)?before:items);
      }
    } catch { /* retry on the next poll */ }
  },[]);
  useEffect(()=>{
    if (!active) { sequence.current++; setRequests([]); return; }
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{ await refresh(controller.signal); if(!controller.signal.aborted) timer=setTimeout(poll,6000); };
    void poll();
    return ()=>{sequence.current++;controller.abort();clearTimeout(timer);};
  },[active,refresh]);
  return { requests, refresh };
}

export function WorkspaceDialog({value,onChange,onClose}:{value:string;onChange:(value:string)=>void;onClose:()=>void}) {
  const links=useSources();
  const [runners,setRunners]=useState<RemoteRunnerView[]>([]);
  useEffect(()=>{let alive=true;const refresh=()=>api.runners().then(v=>{if(alive)setRunners(v);},()=>{});void refresh();const t=setInterval(refresh,5000);return()=>{alive=false;clearInterval(t);};},[]);
  const options=[{id:'local',name:'이 기기'},...runners.map(r=>({id:`runner:${r.id}`,name:r.address})),...links.map(l=>({id:`workspace:${l.id}`,name:`${l.name} · 공유${l.connected===false?' · 연결 끊김':''}`}))];
  return <Modal title="실행 위치 필터" onClose={onClose}><div className="form">
    <label className="field"><span className="lbl">실행 위치 필터</span>
    <select className="input" autoFocus aria-label="실행 위치 필터" value={value} onChange={e=>onChange(e.target.value)}>
      <option value="">모든 실행 위치</option>
      {value&&!options.some(o=>o.id===value)&&<option value={value}>연결되지 않은 실행 위치</option>}
      {options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
    <span className="muted small">모든 뷰와 검색 결과에 바로 적용합니다. 작업을 실행할 대상은 바뀌지 않습니다.</span></label>
  </div></Modal>;
}
export function WorkspaceDeliveries() {
  const panel=useSettingsPanel();
  const links=useSources();
  const [open,setOpen]=useState<string>();
  return <section className="workspace-deliveries">
    <h3>공유 러너 전달 내역</h3>
    {links.length ? links.map(l=><button key={l.id} className="btn" aria-expanded={open===l.id} onClick={()=>setOpen(open===l.id?undefined:l.id)} aria-label={`${l.name} 전달 내역`}>
      {l.name} · {l.pending ? `전달 대기 ${l.pending}개` : '전달 내역 보기'}
    </button>) : <p className="muted small">연결한 공유 러너가 없습니다.</p>}
    {open&&panel.active&&<Deliveries workspaceId={open} inline={panel.embedded} onClose={()=>setOpen(undefined)}/>}
  </section>;
}
function Deliveries({workspaceId,onClose,inline=false}:{workspaceId:string;onClose:()=>void;inline?:boolean}) {
  const [items,setItems]=useState<WorkspaceDelivery[]>([]),[error,setError]=useState('');
  useEffect(()=>{let alive=true;const refresh=()=>workspaceCall<WorkspaceDelivery[]>(`/${workspaceId}/deliveries`).then(v=>{if(alive){setItems(v);setError('');}},e=>{if(alive)setError(e.message);});void refresh();const t=setInterval(refresh,2000);return()=>{alive=false;clearInterval(t);};},[workspaceId]);
  const content=<div className="form">
    <p className="muted small">아직 전달하지 못했거나 처리에 실패한 최근 100건입니다. 연결이 복구되면 대기 입력을 순서대로 전달합니다.</p>
    {!items.length&&<p>미전달·실패한 요청이 없습니다.</p>}
    {items.map(i=><div key={i.id} className="field-group"><strong>{i.status===null?'연결 대기':'처리 실패'}</strong><p className="small">{i.path.includes('/messages')?'답글':i.path==='/compose'?'새 지시':i.path.includes('/approvals/')?'승인·질문 답변':'작업 조작'} · {i.id.slice(0,8)}</p>{i.error&&<p className="error">{i.error}</p>}{i.text&&<button className="btn" onClick={()=>{void navigator.clipboard.writeText(i.text!).catch(()=>setError('본문을 복사하지 못했습니다'));}}>실패한 입력 복사</button>}</div>)}
    {error&&<p className="error">{error}</p>}
  </div>;
  return inline?content:<Modal title="공유 러너 전달 내역" onClose={onClose}>{content}</Modal>;
}
export function WorkspaceConnections() {
  const [links,setLinks]=useState<SharedWorkspaceView[]>([]);
  const [name,setName]=useState(''),[url,setUrl]=useState(''),[token,setToken]=useState(''),[edit,setEdit]=useState<string>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [ssh,setSsh]=useState(true),[publicKey,setPublicKey]=useState(''),[workspaceId,setWorkspaceId]=useState(''),[manage,setManage]=useState<string>();
  const [keys,setKeys]=useState<{key:string; fingerprint:string; comment:string}[]>([]),[loadingKeys,setLoadingKeys]=useState(true);
  const [hubName,setHubName]=useState(''),[ownerName,setOwnerName]=useState(''),[requesting,setRequesting]=useState(false);
  const [outgoing,setOutgoing]=useState<OutgoingConnectRequest[]>([]);
  const defaultKey=keys.length===1?keys[0].key:'';
  useSettingsPanel(!!name.trim()||!!url.trim()||!!token||!!publicKey&&publicKey!==defaultKey||
    !!workspaceId||requesting&&ssh&&(!!hubName.trim()||!!ownerName.trim()),busy);
  const refresh=()=>workspaceCall<SharedWorkspaceView[]>('').then(v=>{setLinks(v);void discoverSources(true);});
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  useEffect(()=>{
    let live=true;
    void workspaceCall<typeof keys>('/ssh-keys').then(items=>{
      if(!live || !Array.isArray(items))return;
      setKeys(items);
      if(items.length===1)setPublicKey(p=>p||items[0].key);
    },()=>{}).finally(()=>{if(live)setLoadingKeys(false);});
    let timer:ReturnType<typeof setTimeout>;
    let known=new Set<string>();
    const poll=async()=>{
      try {
        const items=await workspaceCall<OutgoingConnectRequest[]>('/ssh-outgoing');
        if(!live || !Array.isArray(items))return;
        setOutgoing(items);
        const connected=items.filter(x=>x.status==='connected');
        if(connected.some(x=>!known.has(x.id))) await refresh();
        known=new Set(connected.map(x=>x.id));
      } catch { /* retry on the next poll */ }
      finally { if(live)timer=setTimeout(poll,6000); }
    };
    void poll();
    return ()=>{live=false;clearTimeout(timer);};
  },[]);
  const resetForm=()=>{
    setName('');setUrl('');setToken('');setPublicKey(defaultKey);setWorkspaceId('');setEdit(undefined);
    setHubName('');setOwnerName('');setRequesting(false);
  };
  const sendRequest=async()=>{
    if(busy)return;
    setBusy(true);setError('');
    try {
      const item=await workspaceCall<OutgoingConnectRequest>('/ssh-outgoing','POST',{name,url,workspaceId,hubName,ownerName,
        ...(publicKey?{publicKey}:{}),...(edit?{linkId:edit}:{})});
      setOutgoing(items=>[...items.filter(x=>x.id!==item.id),item]);
      resetForm();
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setBusy(false);}
  };
  return <section className="form">
    <h3>같은 작업을 여러 허브에서 공유</h3>
    <p className="small">공유 러너의 주소와 이 허브에 등록한 SSH 공개키를 연결합니다. 연결하면 기존 컬럼에 함께 표시되며, 다른 허브와 같은 대화·대기열·승인 상태를 보고 조작합니다. 상단에서 실행 위치를 필터링하고 설정의 러너 항목에서 전달 내역을 확인할 수 있습니다.</p>
    {links.map(l=><div key={l.id} className="field-group"><strong>{l.name}</strong> · 미전달 {l.pending}개
      <div className="row">
      <button className="btn" onClick={()=>{setEdit(l.id);setName(l.name);setUrl(l.url);setToken('');setSsh(true);setRequesting(!l.publicKey);setPublicKey(l.publicKey??defaultKey);setWorkspaceId(l.workspace_id);}}>연결 갱신</button>
      {l.publicKey&&<button className="btn" onClick={()=>setManage(l.id)}>허브 승인 관리</button>}
      <button className="btn" disabled={busy||!!l.pending} onClick={async()=>{if(busy)return;setBusy(true);try{await workspaceCall(`/${l.id}`,'DELETE');await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>연결 제거</button></div>
    </div>)}
    {outgoing.map(item=><p className="small" role="status" key={item.id}>{item.name} ·
      {({pending:' 관리자 승인 대기',approved:' 승인됨 · SSH 연결 확인 중',rejected:' 연결 요청 거절',expired:' 요청 만료',connected:' SSH 연결 완료'})[item.status]}</p>)}
    <form className="form" onSubmit={async e=>{e.preventDefault();if(requesting&&ssh){await sendRequest();return;}if(busy)return;setBusy(true);setError('');try{await workspaceCall(edit?`/${edit}`:'',edit?'PUT':'POST',{name,url,...(ssh?{publicKey,workspaceId}:{token})});resetForm();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>
      <label>작업공간 이름<input className="input" required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>공유 러너 주소<input className="input" required placeholder="http://127.0.0.1:15321" value={url} onChange={e=>setUrl(e.target.value)}/></label>
      <label>인증 방식<select className="input" value={ssh?'ssh':'token'} onChange={e=>{setSsh(e.target.value==='ssh');setRequesting(false);}}><option value="ssh">SSH 공개키</option><option value="token">기존 연결 토큰</option></select></label>
      {ssh ? <>
        <label>설치 시 확인한 작업공간 ID<input className="input" required value={workspaceId} onChange={e=>setWorkspaceId(e.target.value)}/></label>
        {keys.length>0&&<label>ssh-agent 키<select className="input" value={keys.some(k=>k.key===publicKey)?publicKey:''} onChange={e=>setPublicKey(e.target.value)}>
          <option value="">공개키 선택</option>
          {keys.map(k=><option key={k.fingerprint} value={k.key}>{k.comment ? k.comment+' · ' : ''}{k.fingerprint}</option>)}
        </select></label>}
        {requesting ? <>
          <label>요청할 허브 이름<input className="input" required value={hubName} onChange={e=>setHubName(e.target.value)}/></label>
          <label>소유자 표시 이름<input className="input" required value={ownerName} onChange={e=>setOwnerName(e.target.value)}/></label>
          {!keys.length&&!loadingKeys&&<p className="small">허브 실행 계정의 ssh-agent에 키를 등록한 뒤 이 화면을 다시 여세요.</p>}
        </> : <label>이 허브의 SSH 공개키<textarea className="input" required value={publicKey} onChange={e=>setPublicKey(e.target.value)} placeholder="ssh-ed25519 … 또는 ssh-rsa …"/></label>}
        <button className="btn" type="button" onClick={()=>setRequesting(v=>!v)}>{requesting?'이미 승인된 키로 직접 연결':'관리자에게 연결 요청'}</button>
      </> : <label>이 허브의 연결 토큰<input className="input" required type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>}
      <button className="btn" disabled={busy || requesting&&ssh&&!keys.some(k=>k.key===publicKey)}>{requesting&&ssh?'연결 요청 보내기':edit?'연결 갱신':'공유 러너 연결'}</button>
    </form>
    <p className="small muted">기존 원격 러너와 공유 러너는 실행 방식이 다릅니다. 공유 러너를 먼저 설치하고 SSH 터널 또는 HTTPS 연결을 준비하세요. 최초 관리자는 러너 머신에서 등록하며, 이후 허브는 관리자가 승인합니다.</p>
    {manage&&<SshPeers workspaceId={manage} onClose={()=>setManage(undefined)}/>}
    {error&&<p className="error">{error}</p>}
  </section>;
}

export function SshPeers({workspaceId,onClose,requestsView}:{workspaceId:string;onClose:()=>void;
  requestsView?:ReturnType<typeof useWorkspaceRequests>}) {
  const [peers,setPeers]=useState<SshPeerView[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [name,setName]=useState(''),[ownerName,setOwnerName]=useState(''),[publicKey,setPublicKey]=useState('');
  const base=`/${workspaceId}/ssh-peers`;
  const ownRequests=useWorkspaceRequests(!requestsView);
  const incoming=requestsView??ownRequests;
  const requests=incoming.requests.filter(request=>request.linkId===workspaceId);
  const decide=(id:string,approve:boolean)=>workspaceCall(`/${workspaceId}/ssh-requests/${id}`,'POST',{approve});

  const refresh=()=>workspaceCall<SshPeerView[]>(base).then(setPeers);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[workspaceId]);
  const perform=async(work:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await work();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <Modal title="공유 러너 허브 승인" onClose={onClose}><div className="form">
    <p className="small">첫 관리자 허브에서만 승인할 수 있습니다. 연결 권한을 취소하면 해당 허브가 요청한 실행을 중단하고 대기 입력을 취소합니다.</p>
    {requests.map(request=><div key={request.id} className="field-group">
      <strong>연결 요청 · {request.name} · {request.ownerName}</strong><p className="small">{request.fingerprint}</p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={()=>void perform(async()=>{await decide(request.id,true);await incoming.refresh();})}>승인</button>
        <button className="btn" disabled={busy} onClick={()=>void perform(async()=>{await decide(request.id,false);await incoming.refresh();})}>거절</button>
      </div>
    </div>)}
    {peers.map(p=><div className="field-group" key={p.peerId}><strong>{p.name} · {p.ownerName}</strong><p className="small">{p.admin?'관리자':p.revoked?'연결 취소됨':'승인됨'} · {p.fingerprint}</p>
      {!p.admin&&!p.revoked&&<button className="btn" disabled={busy} onClick={()=>{if(window.confirm(`${p.name}의 실행과 대기 입력을 중단하고 연결 권한을 취소할까요?`))void perform(()=>workspaceCall(`${base}/${p.peerId}`,'DELETE'));}}>연결 권한 취소</button>}
    </div>)}
    <form className="form" onSubmit={e=>{e.preventDefault();void perform(async()=>{await workspaceCall(base,'POST',{name,ownerName,publicKey});setName('');setOwnerName('');setPublicKey('');});}}>
      <label>허브 이름<input className="input" required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>소유자 표시 이름<input className="input" required value={ownerName} onChange={e=>setOwnerName(e.target.value)}/></label>
      <label>새 허브의 SSH 공개키<textarea className="input" required value={publicKey} onChange={e=>setPublicKey(e.target.value)}/></label>
      <button className="btn" disabled={busy}>허브 연결 승인</button>
    </form>
    {error&&<p className="error">{error}</p>}
  </div></Modal>;
}
