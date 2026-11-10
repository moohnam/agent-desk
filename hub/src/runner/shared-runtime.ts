import { join } from 'node:path';
import { Hub } from '../hub.ts';
import { Store } from '../db.ts';
import { SkillStore } from '../skills.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { RemoteAgent } from './remote-agent.ts';
import { RemoteJournal } from './remote-journal.ts';
import type { StartEngine } from './engine.ts';

/** Owns both the authoritative task store and one durable engine runner on this machine. */
export class SharedRuntime {
  readonly hub:Hub;
  readonly workspace:SharedWorkspace;
  readonly journal:RemoteJournal;
  readonly agent:RemoteAgent;
  private timer:NodeJS.Timeout;
  private runnerId:string;
  private engines:string[];
  private exchangedAt=0;
  private snapshot='';
  private stopped=false;
  constructor(dir:string,address:string,opts:{start?:StartEngine;engines?:string[]}={}) {
    this.engines=opts.engines??['claude'];
    this.journal=new RemoteJournal(join(dir,'delivery.db'));
    try {this.journal.claim();} catch(e) {this.journal.close();throw e;}
    let store:Store|undefined,hub:Hub|undefined,agent:RemoteAgent|undefined;
    try {
      store=new Store(join(dir,'workspace.db'));
      this.hub=hub=new Hub(store,{skills:new SkillStore(join(dir,'desk-plugin')),runner:()=>({connected:true,id:'shared-local-disabled',engines:new Set(),has:()=>false,handle:()=>{throw new Error('공유 러너 주소를 프로젝트 경로에 지정하세요');}})});
      this.workspace=new SharedWorkspace(this.hub);
      const peers=this.hub.remotes.list();
      if(peers.length&&peers[0].address!==address)throw new Error('기존 공유 작업공간의 러너 주소를 바꿀 수 없습니다');
      this.runnerId=peers[0]?.id??this.hub.remotes.register(address).runner.id;
      this.journal.bind('workspace:'+this.workspace.id,this.runnerId);
      this.agent=agent=new RemoteAgent(this.journal,this.runnerId,join(dir,'engine-skills'),opts.start);
      this.exchange();
      this.timer=setInterval(()=>this.exchange(),250);this.timer.unref();
    }catch(error){
      for(const s of agent?.runner.snapshot()??[])try{agent!.runner.handle({type:'close',sessionId:s.sessionId});}catch{/* Preserve the startup error while releasing the remaining resources. */}
      hub?.remotes.close();hub?.channels.stop();store?.database.close();this.journal.close();
      throw error;
    }
  }
  exchange() {
    if(this.stopped)return;
    const snapshot=JSON.stringify(this.agent.runner.snapshot());
    if(this.journal.lastEvent===this.journal.eventAck && !this.hub.remotes.list()[0].pending
      && snapshot===this.snapshot && Date.now()-this.exchangedAt<5000)return;
    for(let batch=0;batch<16;batch++) {
      const events=this.journal.events();
      const reply=this.hub.atomic(()=>this.hub.remotes.exchange(this.runnerId,{version:1,journalId:this.journal.id,commandAck:this.journal.commandAck,events,
        more:this.journal.lastEvent>(events.at(-1)?.seq??this.journal.eventAck),sessions:this.agent.runner.snapshot(),engines:this.engines}));
      this.journal.acknowledge(reply.eventAck,events.at(-1)?.seq??this.journal.eventAck);
      this.journal.receive(reply.commands);this.agent.pump();
      this.exchangedAt=Date.now();this.snapshot=JSON.stringify(this.agent.runner.snapshot());
      if(!reply.commands.length&&this.journal.lastEvent===this.journal.eventAck)break;
    }
  }
  close() {
    if(this.stopped)return;
    this.stopped=true;
    clearInterval(this.timer);
    this.agent.runner.shutdown();
    // Closing events are already durable in the journal. Deliver them on restart;
    // exchanging here would also dispatch pending commands and start new engines.
    this.hub.remotes.close();this.hub.channels.stop();this.journal.close();this.hub.store.database.close();
  }
}
