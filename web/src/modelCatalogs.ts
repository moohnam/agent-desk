import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import { checkModelCatalogs, type RunnerModelCatalog } from '../../shared/model-catalog.ts';

type State = {runners:RunnerModelCatalog[];loading:boolean;error:string};
type Entry = {state:State;at:number;waitingFor?:number;baseline?:Record<string,string>;flight?:Promise<void>;listeners:Set<(state:State)=>void>;cleanup?:ReturnType<typeof setTimeout>};
const entries=new Map<string,Entry>();
const entryFor=(source:string) => {
  let entry=entries.get(source);
  if(!entry){
    if(entries.size>=32){const oldest=[...entries].find(([,candidate])=>!candidate.listeners.size) ?? [...entries][0];if(oldest){if(oldest[1].cleanup)clearTimeout(oldest[1].cleanup);entries.delete(oldest[0]);}}
    entry={state:{runners:[],loading:true,error:''},at:0,listeners:new Set()};entries.set(source,entry);}
  return entry;
};
function refresh(source:string,force=false,entry=entryFor(source)) {
  if(entry.flight || (!force && Date.now()-entry.at<60_000)) return;
  if(force) {
    entry.waitingFor=Date.now();
    entry.baseline=Object.fromEntries(entry.state.runners.flatMap(r=>Object.entries(r.catalogs).map(([engine,c])=>[`${r.runnerId}/${engine}`,c!.checkedAt])));
  }
  const publish=(state:State)=>{entry.state=state;entry.listeners.forEach(listener=>listener(state));};
  publish({...entry.state,loading:true});
  entry.flight=Promise.resolve().then(()=>api.modelCatalogs(source,force,AbortSignal.timeout(35_000))).then(runners=>{
    if(!Array.isArray(runners)||runners.some(r=>!r||typeof r.runnerId!=='string'||typeof r.label!=='string'
      ||typeof r.connected!=='boolean'||(r.supported!==undefined&&typeof r.supported!=='boolean')||!checkModelCatalogs(r.catalogs)))throw new Error('모델 목록 응답을 확인하지 못했습니다');
    // Runner replies immediately with the last snapshot; collect the requested refresh as it arrives.
    const waiting = entry.waitingFor && Date.now()-entry.waitingFor<35_000
      && runners.some(r=>r.supported!==false && (Object.keys(r.catalogs).length<3 || Object.entries(r.catalogs).some(([engine,c])=>entry.baseline?.[`${r.runnerId}/${engine}`]===c!.checkedAt)));
    const initial = !entry.waitingFor && runners.some(r=>r.supported===true && Object.keys(r.catalogs).length<3);
    const pending = !!(waiting || initial);
    if (!pending) {entry.waitingFor=undefined;entry.baseline=undefined;}
    publish({runners,loading:pending,error:''});
    entry.at=pending?Date.now()-58_000:Date.now();
  }).catch(error=>{
    entry.at=Date.now();entry.waitingFor=undefined;entry.baseline=undefined;publish({...entry.state,loading:false,error:error instanceof Error?error.message:String(error)});
  }).finally(()=>{entry.flight=undefined;});
}
/** Shares reads across compose fields and the existing model dialog; old servers keep static tags. */
export function useModelCatalogs(source='') {
  const entry=useMemo(()=>entryFor(source),[source]);
  const [state,setState]=useState(()=>entry.state);
  useEffect(()=>{
    if(entry.cleanup){clearTimeout(entry.cleanup);entry.cleanup=undefined;}setState(entry.state);entry.listeners.add(setState);refresh(source,false,entry);
    const timer=setInterval(()=>refresh(source,false,entry),2000);
    return()=>{entry.listeners.delete(setState);clearInterval(timer);if(!entry.listeners.size){entry.cleanup=setTimeout(()=>{if(!entry.listeners.size&&entries.get(source)===entry)entries.delete(source);},60_000);}};
  },[source,entry]);
  const reload=useCallback(()=>refresh(source,true,entry),[source,entry]);
  return {...state,refresh:reload};
}
