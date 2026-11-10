import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.ts';
import { Store } from '../db.ts';
import { SharedWorkspace } from '../shared-workspace.ts';
import { SharedRuntime } from './shared-runtime.ts';

const dir=resolve(config.shared.directory);
mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const [command,name,file]=process.argv.slice(2);
if(command==='grant'||command==='revoke'||command==='peers') {
  const store=new Store(join(dir,'workspace.db'));
  const workspace=new SharedWorkspace(undefined,store);
  try {
    if(command==='grant') {
      if(!name||!file)throw new Error('grant 허브이름 토큰파일_절대경로 형식으로 실행하세요');
      const receipt=workspace.grant(name);
      try {writeFileSync(resolve(file),receipt.token+'\n',{mode:0o600,flag:'wx'});}catch(e){workspace.revoke(receipt.id);throw e;}
      console.log(JSON.stringify({peer_id:receipt.id,workspace_id:receipt.workspace_id,token_file:resolve(file)}));
    }else if(command==='revoke'){if(!name)throw new Error('허브 ID가 필요합니다');workspace.revoke(name);console.log('허브 연결 권한을 취소했습니다');}
    else console.log(JSON.stringify(workspace.peers()));
  }finally{store.database.close();}
}else {
  if(command)throw new Error('지원하지 않는 공유 러너 명령입니다');
  if(!config.shared.address)throw new Error('AGENT_DESK_SHARED_ADDRESS에 사용자@호스트 표기를 지정하세요');
  const runtime=new SharedRuntime(dir,config.shared.address);
  const server=runtime.workspace.server();
  server.listen(config.shared.port,'127.0.0.1',()=>console.log(`공유 러너: http://127.0.0.1:${config.shared.port} (workspace ${runtime.workspace.id})`));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;server.closeAllConnections();server.close(()=>{runtime.close();});};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
