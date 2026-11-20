import { chmodSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.ts';
import { hubBlockers, registerHttpRuntimeControl, sessionBlockers } from '../runtime-control.ts';
import { Store } from '../db.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { SharedRuntime } from './shared-runtime.ts';
import { configuredPort, recordPortDefaults, sharedPortDefaults } from '../ports.ts';

const dir=resolve(config.shared.directory);
mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const defaults = sharedPortDefaults(dir);
const port = configuredPort(process.env.AGENT_DESK_SHARED_PORT, defaults.workspace);
const [command,name,file]=process.argv.slice(2);
if(command==='grant'||command==='revoke'||command==='peers'||command==='init-ssh'||command==='rotate-ssh') {
  recordPortDefaults(dir, defaults);
  const store=new Store(join(dir,'workspace.db'));
  const workspace=new SharedWorkspace(undefined,store);
  try {
    if(command==='init-ssh') {
      const publicFile=process.argv[5];
      if(!name||!file||!publicFile)throw new Error('init-ssh 허브이름 소유자이름 공개키파일 [기존허브ID] 형식으로 실행하세요');
      const peer=await workspace.ssh.register({name,ownerName:file,publicKey:readFileSync(resolve(publicFile),'utf8')},undefined,process.argv[6]);
      console.log(JSON.stringify({workspace_id:workspace.id,peer}));
    }else if(command==='rotate-ssh') {
      if(!name||!file)throw new Error('rotate-ssh 허브ID 공개키파일 형식으로 실행하세요');
      console.log(JSON.stringify({workspace_id:workspace.id,peer:await workspace.ssh.rotate(name,readFileSync(resolve(file),'utf8'))}));
    }else if(command==='grant') {
      if(!name||!file)throw new Error('grant 허브이름 토큰파일_절대경로 형식으로 실행하세요');
      const receipt=workspace.grant(name);
      try {writeFileSync(resolve(file),receipt.token+'\n',{mode:0o600,flag:'wx'});}catch(e){workspace.revoke(receipt.id);throw e;}
      console.log(JSON.stringify({peer_id:receipt.id,workspace_id:receipt.workspace_id,token_file:resolve(file)}));
    }else if(command==='revoke'){if(!name)throw new Error('허브 ID가 필요합니다');workspace.revoke(name);console.log('허브 연결 권한을 취소했습니다');}
    else console.log(JSON.stringify(workspace.ssh.enabled?workspace.ssh.peers():workspace.peers()));
  }finally{store.database.close();}
}else {
  if(command)throw new Error('지원하지 않는 공유 러너 명령입니다');
  if(!config.shared.address)throw new Error('AGENT_DESK_SHARED_ADDRESS에 사용자@호스트 표기를 지정하세요');
  recordPortDefaults(dir, defaults);
  const runtime=new SharedRuntime(dir,config.shared.address,config.shared.migrationRunnerId?{
    migration:{runnerId:config.shared.migrationRunnerId,journalPath:config.remote.dbPath,skillsHome:config.skillsHome},
    autoStart:false,
  }:{autoStart:false});
  const server=runtime.workspace.server();
  server.listen(port,'127.0.0.1',()=>{
    runtime.start();
    console.log(`공유 러너: http://127.0.0.1:${port} (workspace ${runtime.workspace.id})`);
  });
  await registerHttpRuntimeControl(server, { role: 'shared', ready: () => server.listening,
    blockers: () => [...hubBlockers(runtime.hub), ...sessionBlockers(runtime.agent.runner.snapshot()),
      ...(runtime.journal.hasUndeliveredCommands ? ['미실행 명령'] : []),
      ...(runtime.journal.lastEvent > runtime.journal.eventAck ? ['미확인 이벤트'] : [])],
    stop: () => { runtime.close(); process.exit(process.exitCode ?? 0); } });
}
