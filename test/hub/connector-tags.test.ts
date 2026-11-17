import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectorTags,connectorInputScopes} from '../../shared/connector-tags.ts';
import {parseCompose,RESERVED_TAGS} from '../../shared/compose.ts';

test('explicit service tags preserve readable service names and leading project routing',()=>{
  assert.deepEqual(connectorTags('지금 #slack 에서 확인하고 #JIRA 와 #confluence 도 찾아줘 #slack'),{
    scopes:['slack','jira','confluence'],body:'지금 Slack 에서 확인하고 Jira 와 Confluence 도 찾아줘 Slack',
  });
  const parsed=parseCompose('#slack @project#2 조회',['slack']);
  assert.equal(parsed.mention?.name,'project');assert.equal(parsed.mention?.no,2);
  assert.deepEqual(parsed.skills,[]);assert.match(parsed.body,/Slack/);
  for(const tag of ['slack','jira','confluence'])assert.ok(RESERVED_TAGS.includes(tag));
});

test('code, quotes, references, HTML, escapes and channel names do not grant permissions',()=>{
  for(const text of ['`#slack`','```md\n#slack\n```','~~~\n#jira\n~~~','> #slack',
    '    #jira','"#slack"',"'example\n#jira\n'",'`example\n#slack\n`','<!--\n#jira\n-->',
    '[#slack](https://example.com)','[label]( #slack )','[ref]: #jira','<div>\n#slack\n</div>',
    '\\#slack','#slack-channel','/#jira','https://example.com/#slack','#slack에']) {
    assert.deepEqual(connectorTags(text),{scopes:[],body:text},text);
  }
  for(const text of ['```text\n```not-a-close\n#slack\n```','> 인용한 내용\n#jira','[설명\n#confluence\n](https://example.com)','$$\n#slack\n$$'])
    assert.deepEqual(connectorTags(text),{scopes:[],body:text},text);
  assert.deepEqual(connectorTags('```html\n<div>\n```\n#slack').scopes,['slack']);
  for(const text of ['예시 <code> #slack </code> 입니다','<span title="</span>"> #jira </span>',"'don't #slack'",'~~#slack~~',
    '예시 <code><!-- </code> --> #slack </code>','예시 <code><?x </code> ?> #slack </code>',
    '예시 <code><![CDATA[ </code> ]]> #slack </code>', '예시 <code><textarea> </code> #slack </textarea></code>',
    '예시 <code><script> </code> #slack </script></code>', '예시 <code/> #slack </code>'])
    assert.deepEqual(connectorTags(text).scopes,[],text);
  assert.deepEqual(connectorTags('```\n"\n```\n\n#slack 조회').scopes,['slack']);
});

test('only the direct user input selects services, never approval answers or quoted attachments',()=>{
  assert.deepEqual(connectorInputScopes('POST','/tasks/id/messages',{text:'#slack 읽어줘',quoted:'#jira'}),['slack']);
  assert.deepEqual(connectorInputScopes('POST','/channels/id/messages',{text:'#confluence 확인'}),['confluence']);
  for(const path of ['/approvals/id','/tasks/id/handoff','/tasks/id/reset'])
    assert.deepEqual(connectorInputScopes('POST',path,{text:'#jira',answers:{q:'#slack'}}),[]);
});
