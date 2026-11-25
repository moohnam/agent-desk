import { useSyncExternalStore } from 'react';
const key='agent-desk.diff-wrap';
let enabled=true;
try{enabled=localStorage.getItem(key)!=='off';}catch{}
const listeners=new Set<()=>void>();
const update=(value:boolean)=>{enabled=value;listeners.forEach(listener=>listener());};
window.addEventListener('storage',event=>{if(event.key===key||event.key===null)update(event.newValue!=='off');});
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const useDiffWrap=()=>useSyncExternalStore(subscribe,()=>enabled);
export function setDiffWrap(value:boolean){try{localStorage.setItem(key,value?'on':'off');}catch{}update(value);}
