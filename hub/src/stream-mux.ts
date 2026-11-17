import type { ServerResponse } from 'node:http';
import type { HubMessage } from '../../shared/api.ts';

interface Source { id: string; linkId: string; view_index: number }
/** One browser connection carries independent source streams; reconnects still trigger snapshots. */
export function multiplexStream(res: ServerResponse, options: {
  sources: () => Source[];
  stream: (id: string, signal: AbortSignal, opened: () => void, receive: (message: HubMessage) => void) => Promise<void>;
  local?: (receive: (message: HubMessage) => void) => () => void;
  allowed: () => boolean;
  access: (receive: (message: HubMessage) => void) => () => void;
}) {
  let closed = false;
  const peers = new Map<string, { controller: AbortController; timer?: NodeJS.Timeout }>();
  let tick: NodeJS.Timeout | undefined, ping: NodeJS.Timeout | undefined;
  let leaveAccess = () => {}, leaveLocal = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(tick); clearInterval(ping); leaveAccess(); leaveLocal();
    for (const peer of peers.values()) { peer.controller.abort(); clearTimeout(peer.timer); }
    peers.clear();
  };
  const disconnect = () => { close(); res.destroy(); };
  res.once('close', close);
  const raw = (frame: string) => {
    if(closed)return;
    if(!options.allowed()){disconnect();return;}
    // Disconnect a slow consumer; its reconnect snapshot recovers missed state from durable storage.
    if(res.writableLength+Buffer.byteLength(frame)>8*1024*1024){disconnect();return;}
    res.write(frame);
  };
  const write = (value: unknown) => raw(`data: ${JSON.stringify(value)}\n\n`);
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
  raw(': connected\n\n');
  if (closed) return close;
  leaveAccess=options.access(message=>write({source:'',view_index:0,message}));
  leaveLocal=options.local?.(message=>write({source:'',view_index:0,message})) ?? (() => {});
  if(options.local)write({source:'',view_index:0,connected:true});
  if (closed) { leaveAccess(); leaveLocal(); return close; }
  const reconcile=()=>{
    if(closed)return;
    if(!options.allowed()){disconnect();return;}
    const sources=options.sources();
    for(const [id,peer] of peers)if(!sources.some(s=>s.id===id)){
      peers.delete(id);peer.controller.abort();clearTimeout(peer.timer);
      write({source:id,connected:false});
    }
    for(const source of sources){
      if(closed)return;
      if(peers.has(source.id))continue;
      const peer={controller:new AbortController(),timer:undefined as NodeJS.Timeout|undefined};
      peers.set(source.id,peer);
      let retry=1000;
      const run=async()=>{
        if(closed||peers.get(source.id)!==peer)return;
        peer.controller=new AbortController();
        try{
          await options.stream(source.linkId,peer.controller.signal,
            ()=>{if(peers.get(source.id)!==peer||peer.controller.signal.aborted)return;retry=1000;write({source:source.id,view_index:source.view_index,connected:true});},
            message=>{if(peers.get(source.id)===peer&&!peer.controller.signal.aborted)write({source:source.id,view_index:source.view_index,message});});
        }catch{/* Report source connectivity, never upstream credentials or error bodies. */}
        if(closed||peers.get(source.id)!==peer)return;
        write({source:source.id,view_index:source.view_index,connected:false});
        if(closed)return;
        peer.timer=setTimeout(()=>{void run();},retry);retry=Math.min(retry*2,30_000);
      };
      void run();
    }
  };
  tick=setInterval(reconcile,1000);ping=setInterval(()=>{raw(': ping\n\n');},25_000);
  reconcile();
  return close;
}
