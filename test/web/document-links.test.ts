import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentHref, documentPath, isDocumentLink } from '../../web/src/documentLinks.ts';
import { readReferences, toggleReference } from '../../web/src/threadReferences.ts';

test('document dispatch recognizes local files and leaves websites and other files alone',()=>{
 for(const href of ['/tmp/report.html','~/docs/a.md','file:///tmp/a%20b.HTML','report.markdown#L3','./doc.htm:12'])assert.equal(isDocumentLink(href),true,href);
 for(const href of ['https://site/a.html','lectern:report.md','image.png','broken%ZZ.md'])assert.equal(isDocumentLink(href),false,href);
});
test('document-only references retain choices without reopening and coexist with selected posts',()=>{
 const state=readReferences(JSON.stringify({task:{ids:[],files:['/tmp/a.md','/tmp/a.md'],open:true}}));
 assert.equal(state.task.open,false);assert.deepEqual(state.task.files,['/tmp/a.md']);
 const added=toggleReference(state,'task',9);assert.deepEqual(added.task.files,['/tmp/a.md']);
 const removed=toggleReference(added,'task',9);assert.deepEqual(removed.task.ids,[]);assert.equal(removed.task.open,true);
 assert.equal(readReferences(JSON.stringify({task:{ids:[],files:[],open:true}})).task.open,false);
});

test('copied document links preserve source task and encoded file path instead of navigating to filesystem URLs',()=>{
 const task='w:runner-id:task-id',path='/home/user/memory/한 글.md#L3';
 const url=new URL(documentHref(task,path),'http://127.0.0.1:4317');
 assert.equal(url.pathname,'/');
 assert.equal(url.searchParams.get('documentTask'),task);
 assert.equal(url.searchParams.get('documentPath'),path);
 assert.equal(documentPath('sibling.md','/home/user/memory/MEMORY.md'),'/home/user/memory/sibling.md');
 assert.equal(documentPath('/home/other.md','/home/user/memory/MEMORY.md'),'/home/other.md');
 assert.equal(documentPath('https://example.com/a.md','/home/user/MEMORY.md'),'https://example.com/a.md');
});
