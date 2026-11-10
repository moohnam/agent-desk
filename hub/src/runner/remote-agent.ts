import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HubToRunner, RunnerToHub } from '../../../shared/protocol.ts';
import { checkHubToRunner } from '../../../shared/protocol.ts';
import { Runner } from './runner.ts';
import { RemoteJournal } from './remote-journal.ts';
import type { StartEngine } from './engine.ts';
import { createHash } from 'node:crypto';
import { SkillStore } from '../skills.ts';

/** The connection never owns the engine process: disconnecting just leaves more output on disk. */
export class RemoteAgent {
  readonly runner: Runner;
  readonly journal: RemoteJournal;
  private skillsHome: string;
  constructor(journal: RemoteJournal, id: string, skillsHome: string, start?: StartEngine) {
    this.journal=journal; this.skillsHome=skillsHome;
    this.runner = new Runner(id, m => journal.emit(m), { start });
    journal.recoverAmbiguous();
  }
  pump() {
    for (let item; (item = this.journal.next());) {
      this.journal.dispatching(item.seq);
      const raw = item.value;
      try {
        let cmd: HubToRunner = raw;
        const home = cmd.type !== 'auth' ? join(this.skillsHome, 'remote-sessions', createHash('sha256').update(cmd.sessionId).digest('hex')) : this.skillsHome;
        if ((cmd.type === 'start' || cmd.type === 'send') && cmd.skillFiles) {
          if (!Array.isArray(cmd.skillFiles) || cmd.skillFiles.length > 1000 || Buffer.byteLength(JSON.stringify(cmd.skillFiles)) > 4*1024*1024) throw new Error('스킬 전송 크기가 한도를 넘었습니다');
          const skills = new SkillStore(home);
          const incoming = new Set(cmd.skillFiles.map(f => f.name));
          const paths = new Set(cmd.skillFiles.map(f => `${f.name}/${f.path}`));
          for (const name of incoming) {
            SkillStore.validName(name);
            if (!paths.has(`${name}/SKILL.md`)) throw new Error('스킬 본문이 빠진 전송입니다');
          }
          for (const skill of skills.list()) {
            if (!incoming.has(skill.name)) skills.remove(skill.name);
            else for (const file of skill.files) if (!paths.has(`${skill.name}/${file.path}`)) skills.deleteFile(skill.name, file.path);
          }
          const names = new Set(skills.names());
          for (const file of cmd.skillFiles) {
            SkillStore.validName(file.name);
            if (!names.has(file.name)) { skills.create(file.name); names.add(file.name); }
            skills.writeFile(file.name, file.path, file.content, file.executable);
          }
        }
        if (cmd.type === 'start') {
          const cwd = cmd.cwd.startsWith('~/') ? join(homedir(), cmd.cwd.slice(2)) : cmd.cwd;
          if (!cwd.startsWith('/') || !statSync(cwd).isDirectory()) throw new Error('원격 프로젝트 디렉터리가 없습니다');
          new SkillStore(home);
          cmd = { ...cmd, cwd: resolve(cwd), skillsHome: realpathSync(home) };
        }
        const checked = checkHubToRunner(cmd);
        if (typeof checked === 'string' || checked.type === 'auth') throw new Error(typeof checked === 'string' ? checked : 'invalid auth');
        const live = this.runner.snapshot().find(s=>s.sessionId===checked.sessionId);
        // A restored hub may not yet know that this session survived. Never replace its process.
        if (checked.type === 'start' && live) {
          this.runner.handle({type:'send',sessionId:checked.sessionId,text:checked.prompt,skills:checked.skills});
        } else {
          if (checked.type === 'close' && !live) { this.journal.dispatched(item.seq); continue; }
          if (checked.type !== 'start' && !live) throw new Error('대상 세션이 종료되어 명령을 적용하지 못했습니다');
          if (checked.type === 'approval_result' && !live?.approvals.some(a=>a.approvalId===checked.approvalId)) throw new Error('이미 끝난 승인 요청이라 적용하지 않았습니다');
          this.runner.handle(checked);
        }
      } catch(e) {
        if (raw.type !== 'auth') this.journal.emit({type:'event',sessionId:raw.sessionId,event:{kind:'status',state:raw.type === 'start' || raw.type === 'send' ? 'error' : 'warning',detail:{message:`원격 명령 ${item.seq} 실패: ${e instanceof Error ? e.message : String(e)}`,command_id:item.seq}}});
      }
      this.journal.dispatched(item.seq);
    }
  }
  emit(message: RunnerToHub) { this.journal.emit(message); }
}
