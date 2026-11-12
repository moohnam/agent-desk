import { join } from 'node:path';
import { Hub } from '../hub.ts';
import { Store } from '../db.ts';
import { SkillStore } from '../skills.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { RemoteAgent } from './remote-agent.ts';
import { RemoteJournal } from './remote-journal.ts';
import type { StartEngine } from './engine.ts';
import { sharedRunnerMcp } from './managed-mcp.ts';
import { config } from '../config.ts';

/** Owns both the authoritative task store and one durable engine runner on this machine. */
export class SharedRuntime {
  readonly hub:Hub;
  readonly workspace:SharedWorkspace;
  readonly journal:RemoteJournal;
  readonly agent:RemoteAgent;
  private timer:NodeJS.Timeout|undefined;
  private runnerId:string;
  private exchangedAt=0;
  private snapshot='';
  private stopped=false;
  constructor(dir:string,address:string,opts:{start?:StartEngine;skills?:SkillStore;autoStart?:boolean;
    migration?:{runnerId:string;journalPath:string;skillsHome:string}}={}) {
    this.journal=new RemoteJournal(opts.migration?.journalPath??join(dir,'delivery.db'));
    try {this.journal.claim();} catch(e) {this.journal.close();throw e;}
    let store:Store|undefined,hub:Hub|undefined,agent:RemoteAgent|undefined;
    try {
      store=new Store(join(dir,'workspace.db'));
      if(store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_merge'").get()
        &&store.database.prepare('SELECT 1 FROM remote_merge WHERE activated_at IS NULL AND aborted_at IS NULL LIMIT 1').get())
        throw new Error('기존 공유 러너에 통합한 원격 프로젝트가 아직 활성화되지 않았습니다');
      this.hub=hub=new Hub(store,{pathAddress:address,skills:opts.skills??new SkillStore(join(dir,'desk-plugin')),runner:()=>({connected:true,id:'shared-local-disabled',engines:new Set(),has:()=>false,handle:()=>{throw new Error('공유 러너 주소를 프로젝트 경로에 지정하세요');}})});
      this.workspace=new SharedWorkspace(this.hub);
      const peers=this.hub.remotes.list();
      if(peers.length&&(peers.length!==1||peers[0].address!==address))throw new Error('기존 공유 작업공간의 러너 주소를 바꿀 수 없습니다');
      if(opts.migration){
        const imported=store.database.prepare('SELECT runner_id,activated_at FROM remote_import WHERE runner_id=?').get(opts.migration.runnerId) as {runner_id:string;activated_at:string|null}|undefined;
        if(!imported?.activated_at)throw new Error('원격 작업공간 이관이 아직 활성화되지 않았습니다');
        if(peers[0]?.id!==opts.migration.runnerId)throw new Error('기존 러너 ID가 이관된 작업공간과 다릅니다');
        this.journal.assertRunner(opts.migration.runnerId);
        const peer=this.hub.remotes.peer(opts.migration.runnerId)!;
        if(peer.journal_id&&peer.journal_id!==this.journal.id)throw new Error('이관한 전달 DB의 ID가 기존 러너와 다릅니다');
      }
      this.runnerId=opts.migration?.runnerId??peers[0]?.id??this.hub.remotes.register(address).runner.id;
      if(!opts.migration)this.journal.bind('workspace:'+this.workspace.id,this.runnerId);
      const mcp = sharedRunnerMcp(this.workspace, dir, config.shared.port);
      this.agent=agent=new RemoteAgent(this.journal,this.runnerId,opts.migration?.skillsHome??join(dir,'engine-skills'),opts.start,mcp);
      if(opts.autoStart!==false)this.start();
    }catch(error){
      for(const s of agent?.runner.snapshot()??[])try{agent!.runner.handle({type:'close',sessionId:s.sessionId});}catch{/* Preserve the startup error while releasing the remaining resources. */}
      hub?.dispose();store?.database.close();this.journal.close();
      throw error;
    }
  }
  /** The production server calls this only after the loopback MCP listener is ready. */
  start() {
    if(this.stopped||this.timer)return;
    this.exchange();
    this.timer=setInterval(()=>this.exchange(),250);this.timer.unref();
  }
  exchange() {
    if(this.stopped)return;
    const snapshot=JSON.stringify(this.agent.runner.snapshot());
    if(this.journal.lastEvent===this.journal.eventAck && !this.hub.remotes.list()[0].pending
      && snapshot===this.snapshot && Date.now()-this.exchangedAt<5000)return;
    for(let batch=0;batch<16;batch++) {
      const events=this.journal.events();
      const reply=this.hub.atomic(()=>this.hub.remotes.exchange(this.runnerId,{version:1,journalId:this.journal.id,commandAck:this.journal.commandAck,events,
        more:this.journal.lastEvent>(events.at(-1)?.seq??this.journal.eventAck),sessions:this.agent.runner.snapshot(),engines:this.agent.runner.capabilities.engines,
        skillSnapshot:this.agent.runner.capabilities.skillSnapshot}));
      this.journal.acknowledge(reply.eventAck,events.at(-1)?.seq??this.journal.eventAck);
      this.journal.receive(reply.commands);this.agent.pump();
      this.exchangedAt=Date.now();this.snapshot=JSON.stringify(this.agent.runner.snapshot());
      if(!reply.commands.length&&this.journal.lastEvent===this.journal.eventAck)break;
    }
  }
  close() {
    if(this.stopped)return;
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);
    this.agent.runner.shutdown();
    // Closing events are already durable in the journal. Deliver them on restart;
    // exchanging here would also dispatch pending commands and start new engines.
    this.hub.dispose();this.journal.close();this.hub.store.database.close();
  }
}
