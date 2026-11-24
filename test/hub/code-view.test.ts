import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCodeView } from '../../hub/src/code-view.ts';
import { diffLines } from '../../shared/code-view.ts';
async function repo(run:(root:string,git:(...args:string[])=>void)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'desk-code-test-'));
 const git=(...args:string[])=>{execFileSync('git',['-C',root,...args],{stdio:'pipe'});};
 try {git('init');git('config','user.name','Test');git('config','user.email','test@example.com');await run(root,git);}
 finally {await rm(root,{recursive:true,force:true});}
}
test('code view reads staged and unstaged changes against HEAD and untracked text',async()=>repo(async(root,git)=>{
 await writeFile(join(root,'a.ts'),'const a = 1;\n');git('add','.');git('commit','-m','base');
 await writeFile(join(root,'a.ts'),'const a = 2;\n');git('add','.');
 await writeFile(join(root,'a.ts'),'const a = 3;\n');
 await writeFile(join(root,'새 파일.ts'),'export const value = "hello";\n');
 const list=await readCodeView(root);assert.equal(list.files.length,2);assert.ok(list.head);
 const changed=await readCodeView(root,'a.ts');assert.match(changed.diff!,/-const a = 1;/);assert.match(changed.diff!,/\+const a = 3;/);
 const added=await readCodeView(root,'새 파일.ts');assert.match(added.diff!,/\+export const value/);
 await assert.rejects(readCodeView(root,'../outside'),/폴더 밖/);
}));
test('code view handles unborn repositories, binary files and rejects untracked symlinks',async()=>repo(async(root)=>{
 await writeFile(join(root,'new.txt'),'new\n');assert.equal((await readCodeView(root)).head,null);
 await writeFile(join(root,'binary'),Buffer.from([0,1]));assert.equal((await readCodeView(root,'binary')).binary,true);
 await symlink(join(root,'new.txt'),join(root,'link'));await assert.rejects(readCodeView(root,'link'),/심볼릭 링크/);
}));
test('a project subdirectory cannot enumerate sibling changes',async()=>repo(async(root,git)=>{
 await mkdir(join(root,'sub'));await writeFile(join(root,'sub','a.ts'),'one\n');await writeFile(join(root,'outside'),'outside\n');git('add','.');git('commit','-m','base');
 await writeFile(join(root,'sub','a.ts'),'two\n');await writeFile(join(root,'outside'),'secret\n');
 const result=await readCodeView(join(root,'sub'));assert.deepEqual(result.files.map(file=>file.path),['a.ts']);
 assert.match((await readCodeView(join(root,'sub'),'a.ts')).diff!,/\+two/);
}));
test('diff line numbers preserve before and after positions across hunks',()=>{
 const rows=diffLines('--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +4,2 @@\n-old\n+new\n same\n@@ -20,0 +21,1 @@\n+later\n');
 assert.deepEqual(rows.filter(row=>row.kind==='add').map(row=>[row.text,row.next]),[['new',4],['later',21]]);
 assert.deepEqual(rows.find(row=>row.kind==='delete')?.old,4);
});

test('read-only Git inspection disables repository fsmonitor and clean filters',async()=>repo(async(root,git)=>{
 await writeFile(join(root,'a.ts'),'const a = 1;\n');git('add','.');git('commit','-m','base');
 const marker=join(root,'EXECUTED');
 await writeFile(join(root,'hook.sh'),`#!/bin/sh\ntouch '${marker}'\ncat\n`);await chmod(join(root,'hook.sh'),0o755);
 git('config','core.fsmonitor',join(root,'hook.sh'));
 git('config','filter.unsafe.clean',join(root,'hook.sh'));git('config','filter.unsafe.required','true');
 await writeFile(join(root,'.gitattributes'),'*.ts filter=unsafe\n');
 await writeFile(join(root,'a.ts'),'const a = 2;\n');
 assert.match((await readCodeView(root,'a.ts')).diff!,/const a = 2/);
 await assert.rejects(access(marker));
}));


test('index-only removal has independently selectable deletion and untracked diffs',async()=>repo(async(root,git)=>{
 await writeFile(join(root,'a.ts'),'const before = 1;\n');git('add','.');git('commit','-m','base');
 git('rm','--cached','a.ts');await writeFile(join(root,'a.ts'),'const after = 2;\n');
 const list=await readCodeView(root);
 assert.deepEqual(list.files,[{path:'a.ts',status:'deleted'},{path:'a.ts',status:'untracked'}]);
 const deleted=await readCodeView(root,'a.ts','tracked');
 assert.match(deleted.diff!,/-const before = 1;/);assert.doesNotMatch(deleted.diff!,/const after/);
 const added=await readCodeView(root,'a.ts','untracked');
 assert.match(added.diff!,/\+const after = 2;/);assert.doesNotMatch(added.diff!,/const before/);
}));
for(const format of ['sha1','sha256'])test(`unborn ${format} repositories open staged and untracked files`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'desk-code-format-'));
 try{
  execFileSync('git',['init',`--object-format=${format}`,root],{stdio:'pipe'});
  await writeFile(join(root,'staged.ts'),'const staged = true;\n');
  execFileSync('git',['-C',root,'add','staged.ts']);
  await writeFile(join(root,'new.ts'),'const fresh = true;\n');
  const list=await readCodeView(root);assert.equal(list.head,null);assert.equal(list.files.length,2);
  assert.match((await readCodeView(root,'staged.ts','tracked')).diff!,/\+const staged/);
  assert.match((await readCodeView(root,'new.ts','untracked')).diff!,/\+const fresh/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('file detail inspects only the selected path and does not enumerate the full change list',async()=>repo(async(root)=>{
 for(let i=0;i<1001;i++)await writeFile(join(root,`file-${i}.ts`),'const value = 1;\n');
 await assert.rejects(readCodeView(root),/1,000/);
 const selected=await readCodeView(root,'file-3.ts','untracked');
 assert.equal(selected.files.length,1);assert.match(selected.diff!,/const value/);
}));
