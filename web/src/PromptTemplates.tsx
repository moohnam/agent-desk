import { useEffect, useRef, useState } from 'react';
import { SettingsEditor, useSettingsPanel } from './settingsPanel.tsx';
import { promptTemplates } from './promptTemplates.ts';
import { workspaceOperationId } from './api.ts';
import type { PromptTemplates as Templates } from '../../shared/prompt-templates.ts';
export function PromptTemplates({onClose,onSaved,source=''}:{source?:string;onClose:()=>void;onSaved?:()=>void}) {
  const [saved,setSaved]=useState<Templates>();
  const [items,setItems]=useState<Templates['items']>([]);
  const [selected,setSelected]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  const [reload,setReload]=useState(0);
  const dirty=!!saved&&JSON.stringify(saved.items)!==JSON.stringify(items);
  useSettingsPanel(dirty,busy);
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);setError('');
    void promptTemplates(undefined,controller.signal,source).then(data=>{
      if(controller.signal.aborted)return;setSaved(data);setItems(data.items);setSelected(data.items[0]?.id??'');
    },e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[reload,source]);
  const current=items.find(item=>item.id===selected);
  const change=(key:'name'|'text',value:string)=>{setItems(items.map(item=>item.id===selected?{...item,[key]:value}:item));setNotice('');};
  const close=()=>{if(!busy&&(!dirty||confirm('저장하지 않은 템플릿 변경을 버릴까요?')))onClose();};
  const save=async()=>{
    if(!saved||busy||lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{const data=await promptTemplates({revision:saved.revision,items},undefined,source);setSaved(data);setItems(data.items);setNotice('템플릿을 저장했습니다.');onSaved?.();}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{lock.current=false;setBusy(false);}
  };
  return <SettingsEditor title="프롬프트 템플릿" onClose={close} wide>
    <div className="form">
      <p className="muted small">{source?'이 원격 작업공간':'로컬 작업공간'}에 저장하며 연결한 기기와 에이전트가 함께 사용합니다. 선택한 코드와 경로·줄 번호는 템플릿 내용 뒤에 붙습니다. 에이전트의 기본 지침은 변경하지 않습니다.</p>
      {error&&<p role="alert" className="error">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
      <label>템플릿 목록<select aria-label="관리할 템플릿" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}>
        <option value="">템플릿 선택</option>{items.map(item=><option key={item.id} value={item.id}>{item.name||'새 템플릿'}</option>)}
      </select></label>
      <button disabled={busy||!saved||items.length>=100} onClick={()=>{const id=workspaceOperationId();setItems([...items,{id,name:'새 템플릿',text:''}]);setSelected(id);}}>템플릿 추가</button>
      {current&&<>
        <label>이름<input aria-label="템플릿 이름" className="input" maxLength={100} value={current.name} disabled={busy} onChange={e=>change('name',e.target.value)}/></label>
        <label>내용<textarea aria-label="템플릿 내용" className="input" rows={10} maxLength={16000} value={current.text} disabled={busy} onChange={e=>change('text',e.target.value)}/></label>
        <button disabled={busy} onClick={()=>{if(confirm('이 템플릿을 삭제할까요?')){setItems(items.filter(item=>item.id!==selected));setSelected('');}}}>템플릿 삭제</button>
      </>}
      <div className="row"><button disabled={busy||!dirty} onClick={()=>void save()}>템플릿 저장</button><button disabled={busy} onClick={()=>{if(!dirty||confirm('저장하지 않은 변경을 버리고 다시 불러올까요?'))setReload(n=>n+1);}}>최신 목록 다시 불러오기</button></div>
    </div>
  </SettingsEditor>;
}
