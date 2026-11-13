import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDocumentLink } from '../../web/src/documentLinks.ts';
import { readReferences, toggleReference } from '../../web/src/threadReferences.ts';

test('document dispatch recognizes local files and leaves websites and other files alone',()=>{
 for(const href of ['/tmp/report.html','~/docs/a.md','file:///tmp/a%20b.HTML','report.markdown#L3','./doc.htm:12'])assert.equal(isDocumentLink(href),true,href);
 for(const href of ['https://site/a.html','lectern:report.md','image.png','broken%ZZ.md'])assert.equal(isDocumentLink(href),false,href);
});
test('document-only references reopen and coexist with selected posts',()=>{
 const state=readReferences(JSON.stringify({task:{ids:[],files:['/tmp/a.md','/tmp/a.md'],open:true}}));
 assert.equal(state.task.open,true);assert.deepEqual(state.task.files,['/tmp/a.md']);
 const added=toggleReference(state,'task',9);assert.deepEqual(added.task.files,['/tmp/a.md']);
 const removed=toggleReference(added,'task',9);assert.deepEqual(removed.task.ids,[]);assert.equal(removed.task.open,true);
 assert.equal(readReferences(JSON.stringify({task:{ids:[],files:[],open:true}})).task.open,false);
});
