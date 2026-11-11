import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedMissingTask, keepTaskDraft } from '../../web/src/draftRetention.ts';

const remote = 'w:remote-runner:task';
const draft = {taskId:remote,value:'unsent',at:1};
const state = (overrides:Record<string,unknown>={}) => ({
  tasks:new Map<string,unknown>(),questions:new Map<string,unknown>(),approvals:new Map<string,unknown>(),
  gone:new Set<string>(),availableSources:new Set<string>(['']),...overrides,
});

test('cold-start remote outage retains every task draft until that source returns',()=>{
  const offline=state();
  for(const key of [`reply:${remote}`,`handoff:${remote}`,'question:w:remote-runner:question','ask:w:remote-runner:approval'])
    assert.equal(keepTaskDraft(key,draft,offline),true,key);
  const back=state({availableSources:new Set(['','remote-runner'])});
  for(const key of [`reply:${remote}`,`handoff:${remote}`,'question:w:remote-runner:question','ask:w:remote-runner:approval'])
    assert.equal(keepTaskDraft(key,draft,back),false,key);
});

test('link gap retains old plain drafts; explicit removal prunes them',()=>{
  const old={...draft,taskId:'old-task'};
  const gap=state();
  for(const key of ['reply:old-task','handoff:old-task','question:old-question','ask:old-approval'])
    assert.equal(keepTaskDraft(key,old,gap),true,key);
  const removed=state({gone:new Set(['old-task'])});
  assert.equal(keepTaskDraft('reply:old-task',old,removed),false);
  assert.equal(keepTaskDraft('handoff:old-task',old,removed),false);
  assert.equal(confirmedMissingTask('old-task',false,new Set([''])),false);
  assert.equal(confirmedMissingTask(remote,false,new Set([''])),false);
  assert.equal(confirmedMissingTask(remote,false,new Set(['remote-runner'])),true);
});

test('a successful source preserves active drafts and clears answered questions or deleted tasks',()=>{
  const active=state({tasks:new Map([[remote,{}]]),availableSources:new Set(['','remote-runner'])});
  assert.equal(keepTaskDraft(`reply:${remote}`,draft,active),true);
  assert.equal(keepTaskDraft('question:w:remote-runner:question',draft,active),false);
  assert.equal(keepTaskDraft('ask:w:remote-runner:approval',draft,active),false);
  const waiting=state({...active,questions:new Map([['w:remote-runner:question',{}]])});
  assert.equal(keepTaskDraft('question:w:remote-runner:question',draft,waiting),true);
  const offline=state({tasks:new Map([[remote,{}]])});
  assert.equal(keepTaskDraft('question:w:remote-runner:question',draft,offline),true);
});
