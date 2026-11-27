import { splitId } from './federation.ts';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Copy, Quote, Settings2, X } from 'lucide-react';
import { promptTemplates } from './promptTemplates.ts';
import { PromptTemplates } from './PromptTemplates.tsx';
import { codePrompt, type PromptTemplate } from '../../shared/prompt-templates.ts';
import type { CodeSendResult } from './codeSend.ts';
/** The bar under the diff while lines are picked: what to do with them (quote, send with a template, copy).
 * Stays mounted without a pick (quote undefined) so the chosen template and the sent state carry over. */
export function CodeActions({taskId,quote,anchor,count,range,onQuote,onSend,onCopy,onClear}:{taskId:string;quote?:string;anchor?:number;count:number;range:string;
  onQuote:(text:string)=>void;onSend:(text:string)=>Promise<CodeSendResult|undefined>;onCopy:(control:HTMLElement)=>Promise<boolean>;onClear:()=>void}) {
  const [source]=splitId(taskId);
  const [items,setItems]=useState<PromptTemplate[]>([]);
  const [selected,setSelected]=useState('');
  const [manage,setManage]=useState(false);
  const [reload,setReload]=useState(0);
  const [error,setError]=useState('');
  const [loadError,setLoadError]=useState('');
  const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  const bar=useRef<HTMLDivElement>(null);
  const sentFromBar=useRef(false);
  const [delivered,setDelivered]=useState<string>();
  const [pending,setPending]=useState<string>();
  // Templates load when the panel opens and after the manager saves.
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setLoadError('');
    void promptTemplates(undefined,controller.signal,source).then(data=>{
      if(controller.signal.aborted)return;setItems(data.items);setSelected(old=>data.items.some(item=>item.id===old)?old:'');
    },e=>{if(!controller.signal.aborted)setLoadError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload,source]);
  // A new pick has not been sent: the last result belongs to the lines before it.
  useEffect(()=>{setNotice('');setError('');},[quote]);
  // A failed template load is tried again on each new pick (a new anchor), not on every line a drag crosses.
  useEffect(()=>{if(quote&&loadError&&!loading)setReload(n=>n+1);},[anchor]);
  // The send button disables itself once sent; right after that render, keep focus in the bar so Escape still lets the pick go first.
  // Only when the send started from the bar: focus the user moved elsewhere meanwhile stays where they put it.
  useEffect(()=>{if(busy)return;if(sentFromBar.current&&document.activeElement===document.body)bar.current?.focus();sentFromBar.current=false;},[busy]);
  const template=items.find(item=>item.id===selected);
  const message=quote?codePrompt(template?.text??'',quote):'';
  // Quoting without a template need not wait for the template list to load.
  const disabled=busy||(loading&&!!selected)||!message;
  const send=async()=>{
    if(disabled||lock.current||delivered===message)return;
    const submitted=message;lock.current=true;sentFromBar.current=!!bar.current?.contains(document.activeElement);setBusy(true);setError('');setNotice('');
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
  const dialog=manage&&createPortal(<PromptTemplates source={source} onClose={()=>setManage(false)} onSaved={()=>setReload(n=>n+1)}/>,document.body);
  if(!quote)return dialog||null;
  return <div className="code-actions" role="region" aria-label="선택한 줄" tabIndex={-1} ref={bar}>
    <div className="row">
      <Quote size={14} aria-hidden/><b>{count}줄 선택</b><span className="code-range" title={range}>{range}</span><span className="spacer"/>
      <select aria-label="코드 프롬프트 템플릿" value={selected} disabled={busy||loading} onChange={e=>{setSelected(e.target.value);setNotice('');}}>
        <option value="">{loading&&!items.length?'템플릿 불러오는 중…':'템플릿 없이 인용'}</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button className="icon" aria-label="템플릿 관리" title="템플릿 관리" disabled={busy} onClick={()=>setManage(true)}><Settings2 size={14}/></button>
      <button className="quote-code" disabled={disabled} onClick={()=>onQuote(message)}>답글에 인용</button>
      <button className="send-code" disabled={disabled||delivered===message} onClick={()=>void send()}>{pending===message?'전송 결과 확인':'바로 전송'}</button>
      {delivered===message&&<button disabled={busy} onClick={()=>{setDelivered(undefined);setNotice('새 요청을 준비했습니다. 바로 전송을 누르면 같은 코드를 다시 보냅니다.');}}>같은 코드로 새 요청</button>}
      <button className="icon" aria-label="선택한 줄 복사" title="선택한 줄 복사" onClick={e=>{const control=e.currentTarget;void onCopy(control).then(ok=>setNotice(ok?'선택한 줄을 복사했습니다.':'복사하지 못했습니다.'));}}><Copy size={14}/></button>
      <button className="icon" aria-label="선택 해제" title="선택 해제 (Esc)" onClick={onClear}><X size={14}/></button>
    </div>
    {message&&<details><summary>전송 내용 미리보기</summary><pre aria-label="코드 전송 내용">{message}</pre></details>}
    {/* Loading shows in the template box, not as its own line, so the buttons do not move under the pointer. */}
    {loadError&&<p role="alert">템플릿을 불러오지 못했습니다: {loadError}</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {dialog}
  </div>;
}
