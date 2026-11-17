import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from '../../hub/src/skills.ts';

test('a draft is validated before creation, preserves its complete text, and cannot overwrite an existing skill',()=>{
 const dir=mkdtempSync(join(tmpdir(),'desk-skill-draft-'));
 try{
  const store=new SkillStore(dir);
  for(const content of [null, '', '---\nname: ""\ndescription: ""\n---', '---\nname: now\ndescription: test\n---', '---\nname: ../outside\ndescription: test\n---', '---\nname: test\ndescription: "   "\n---']){
   assert.throws(()=>store.createFromContent(content));assert.deepEqual(store.names(),[]);
  }
  const content='---\nname: test-draft\ndescription: "테스트용 설명"\n---\n\n# 제목\n\n**지침**과 #eli5 참조\n';
  assert.equal(store.createFromContent(content).name,'test-draft');
  assert.equal(store.readFile('test-draft','SKILL.md').content,content);
  assert.throws(()=>store.createFromContent(content.replace('**지침**','다른 내용')),{status:409});
  assert.equal(store.readFile('test-draft','SKILL.md').content,content);
  assert.throws(()=>store.createFromContent('x'.repeat(1024*1024+1)),{status:413});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
