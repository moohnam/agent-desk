import { splitId } from './federation.ts';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { promptTemplates } from './promptTemplates.ts';
import { PromptTemplates } from './PromptTemplates.tsx';
import { codePrompt, type PromptTemplate } from '../../shared/prompt-templates.ts';
import type { CodeSendResult } from './codeSend.ts';
export function CodeActions({taskId,quote,onQuote,onSend}:{taskId:string;quote?:string;onQuote:(text:string)=>void;onSend:(text:string)=>Promise<CodeSendResult|undefined>}) {
  const [source]=splitId(taskId);
  const [items,setItems]=useState<PromptTemplate[]>([]);
  const [selected,setSelected]=useState('');
  const [manage,setManage]=useState(false);
  const [reload,setReload]=useState(0);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  const [delivered,setDelivered]=useState<string>();
  const [pending,setPending]=useState<string>();
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void promptTemplates(undefined,controller.signal,source).then(data=>{
      if(controller.signal.aborted)return;setItems(data.items);setSelected(old=>data.items.some(item=>item.id===old)?old:'');
    },e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload,source]);
  const template=items.find(item=>item.id===selected);
  const message=quote?codePrompt(template?.text??'',quote):'';
  const disabled=busy||loading||!message;
  const send=async()=>{
    if(disabled||lock.current||delivered===message)return;
    const submitted=message;lock.current=true;setBusy(true);setError('');setNotice('');
    try {
      const result = await onSend(submitted);
      if (result?.shared_pending) setPending(submitted);
      else {setPending(undefined);setDelivered(submitted);}
      setNotice(result?.shared_pending ? '공유 러너 전달 대기열에 접수했습니다. 연결이 돌아오면 전송 결과를 확인해 주세요.'
        : result?.queued_id ? '메시지 대기열에 넣었습니다. 보낼 수 있을 때 전달합니다.'
        : '전송했습니다. 기존 답글 초안은 유지됩니다.');
    } catch (e) {setPending(undefined);setError(e instanceof Error?e.message:String(e));}
    finally{lock.current=false;setBusy(false);}
  };
  return <div className="code-actions">
    <div className="row"><label>프롬프트 템플릿 <select aria-label="코드 프롬프트 템플릿" value={selected} disabled={busy||loading} onChange={e=>{setSelected(e.target.value);setNotice('');}}>
      <option value="">템플릿 없이 인용</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label><button disabled={busy} onClick={()=>setManage(true)}>템플릿 관리</button><button disabled={busy||loading} onClick={()=>setReload(n=>n+1)}>템플릿 새로고침</button></div>
    {message&&<details><summary>전송 내용 미리보기</summary><pre aria-label="코드 전송 내용">{message}</pre></details>}
    <div className="row" hidden={!message}><button className="quote-code" disabled={disabled} onClick={()=>{onQuote(message);setNotice('답글 초안에 넣었습니다.');}}>선택한 줄 답글에 넣기</button><button disabled={disabled||delivered===message} onClick={()=>void send()}>{pending===message?'전송 결과 확인':'바로 전송'}</button></div>
    {loading&&<span>템플릿을 불러오는 중…</span>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {manage&&createPortal(<PromptTemplates source={source} onClose={()=>setManage(false)} onSaved={()=>setReload(n=>n+1)}/>,document.body)}
  </div>;
}
