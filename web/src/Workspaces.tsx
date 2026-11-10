import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SharedWorkspaceView, WorkspaceDelivery } from '../../shared/workspace.ts';
import { Modal } from './Modal.tsx';
import { legacyWorkspaceId } from './workspace.ts';
import { discoverSources, getSources, splitId, subscribeSources } from './federation.ts';
import { api } from './api.ts';
import type { TaskView } from './types.ts';
import type { RemoteRunnerView } from '../../shared/remote.ts';

export const useSources=()=>useSyncExternalStore(subscribeSources,getSources);
export function initialLocation(){try{if(legacyWorkspaceId){history.replaceState(history.state,'','/'+location.search);localStorage.setItem('agent-desk.location',`workspace:${legacyWorkspaceId}`);return `workspace:${legacyWorkspaceId}`;}return localStorage.getItem('agent-desk.location')??'';}catch{return '';}}
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
export function WorkspaceSwitcher({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  const links=useSources();
  const [runners,setRunners]=useState<RemoteRunnerView[]>([]);
  const [open,setOpen]=useState<string>();
  useEffect(()=>{let alive=true;const refresh=()=>api.runners().then(v=>{if(alive)setRunners(v);},()=>{});void refresh();const t=setInterval(refresh,5000);return()=>{alive=false;clearInterval(t);};},[]);
  const options=[{id:'local',name:'이 기기'},...runners.map(r=>({id:`runner:${r.id}`,name:r.address})),...links.map(l=>({id:`workspace:${l.id}`,name:`${l.name} · 공유${l.connected===false?' · 연결 끊김':''}`}))];
  return <>
    <select className="workspace-select" aria-label="실행 위치 필터" value={value} onChange={e=>onChange(e.target.value)}>
      <option value="">모든 실행 위치</option>
      {value&&!options.some(o=>o.id===value)&&<option value={value}>연결되지 않은 실행 위치</option>}
      {options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
    {links.map(l=><button key={l.id} className="btn" onClick={()=>setOpen(l.id)} title={`${l.name} 전달 내역`}>{l.name} · 전달{l.pending?` 대기 ${l.pending}`:''}</button>)}
    {open&&<Deliveries workspaceId={open} onClose={()=>setOpen(undefined)}/>}
  </>;
}
function Deliveries({workspaceId,onClose}:{workspaceId:string;onClose:()=>void}) {
  const [items,setItems]=useState<WorkspaceDelivery[]>([]),[error,setError]=useState('');
  useEffect(()=>{let alive=true;const refresh=()=>workspaceCall<WorkspaceDelivery[]>(`/${workspaceId}/deliveries`).then(v=>{if(alive){setItems(v);setError('');}},e=>{if(alive)setError(e.message);});void refresh();const t=setInterval(refresh,2000);return()=>{alive=false;clearInterval(t);};},[workspaceId]);
  return <Modal title="공유 러너 전달 내역" onClose={onClose}><div className="form">
    <p className="muted small">아직 전달하지 못했거나 처리에 실패한 최근 100건입니다. 연결이 복구되면 대기 입력을 순서대로 전달합니다.</p>
    {!items.length&&<p>미전달·실패한 요청이 없습니다.</p>}
    {items.map(i=><div key={i.id} className="field-group"><strong>{i.status===null?'연결 대기':'처리 실패'}</strong><p className="small">{i.path.includes('/messages')?'답글':i.path==='/compose'?'새 지시':i.path.includes('/approvals/')?'승인·질문 답변':'작업 조작'} · {i.id.slice(0,8)}</p>{i.error&&<p className="error">{i.error}</p>}{i.text&&<button className="btn" onClick={()=>{void navigator.clipboard.writeText(i.text!).catch(()=>setError('본문을 복사하지 못했습니다'));}}>실패한 입력 복사</button>}</div>)}
    {error&&<p className="error">{error}</p>}
  </div></Modal>;
}
export function WorkspaceConnections() {
  const [links,setLinks]=useState<SharedWorkspaceView[]>([]);
  const [name,setName]=useState(''),[url,setUrl]=useState(''),[token,setToken]=useState(''),[edit,setEdit]=useState<string>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=()=>workspaceCall<SharedWorkspaceView[]>('').then(v=>{setLinks(v);void discoverSources(true);});
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[]);
  return <section className="form">
    <h3>같은 작업을 여러 허브에서 공유</h3>
    <p className="small">공유 모드로 실행한 러너의 주소와 이 허브용 토큰을 등록합니다. 연결하면 기존 컬럼에 함께 표시되며, 다른 허브와 같은 대화·대기열·승인 상태를 보고 조작합니다. 상단 실행 위치 필터로 좁혀 볼 수 있습니다.</p>
    {links.map(l=><div key={l.id} className="field-group"><strong>{l.name}</strong> · 미전달 {l.pending}개
      <div className="row">
      <button className="btn" onClick={()=>{setEdit(l.id);setName(l.name);setUrl(l.url);setToken('');}}>연결 갱신</button>
      <button className="btn" disabled={!!l.pending} onClick={()=>{void workspaceCall(`/${l.id}`,'DELETE').then(refresh).catch(e=>setError(e.message));}}>연결 제거</button></div>
    </div>)}
    <form className="form" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{await workspaceCall(edit?`/${edit}`:'',edit?'PUT':'POST',{name,url,token});setName('');setUrl('');setToken('');setEdit(undefined);await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>
      <label>작업공간 이름<input className="input" required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>공유 러너 주소<input className="input" required placeholder="http://127.0.0.1:15321" value={url} onChange={e=>setUrl(e.target.value)}/></label>
      <label>이 허브의 연결 토큰<input className="input" required type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>
      <button className="btn" disabled={busy}>{edit?'연결 갱신':'공유 러너 연결'}</button>
    </form>
    <p className="small muted">기존 원격 러너와 공유 러너는 실행 방식이 다릅니다. 공유 러너를 먼저 설치하고 SSH 터널 또는 HTTPS 연결을 준비하세요. 각 허브에는 별도의 토큰을 발급합니다.</p>
    {error&&<p className="error">{error}</p>}
  </section>;
}
