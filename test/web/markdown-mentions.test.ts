import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Root,Element} from 'hast';
import {rehypeMentions} from '../../web/src/markdownMentions.ts';
const el=(tagName:string,value:string,properties:Element['properties']={}):Element=>({type:'element',tagName,properties,children:[{type:'text',value}]});
test('mentions decorate prose but leave code, links and formula content intact',()=>{
 const protectedNodes=[el('code','#now @task'),el('pre','#now @task'),el('a','#skill',{href:'https://example.com'}),el('span','#skill',{className:['katex']})];
 const root:Root={type:'root',children:[el('p','본문 #eli5 그리고 @task#1'),...protectedNodes,el('strong','#review')]};
 const before=structuredClone(protectedNodes);rehypeMentions()(root);
 const p=root.children[0] as Element;
 assert.deepEqual(p.children.map(n=>n.type),['text','element','text','element']);
 assert.deepEqual(p.children.filter(n=>n.type==='element').map(n=>n.properties.className),[['mention'],['mention']]);
 assert.deepEqual(protectedNodes,before);
 const once=structuredClone(root);rehypeMentions()(root);assert.deepEqual(root,once);
});
