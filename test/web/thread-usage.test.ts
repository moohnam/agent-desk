import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadUsageTarget, threadWindows } from '../../web/src/threadUsage.ts';
import { claudeWindows, codexWindows, agyWindows } from '../../hub/src/usage.ts';
import type { EngineUsage } from '../../shared/api.ts';

test('thread meters use only known limits applicable to the actual model', () => {
  const value: EngineUsage = {engine:'claude',plan:null,fetchedAt:new Date().toISOString(),windows:claudeWindows({
    five_hour:{utilization:10},seven_day:{utilization:20},seven_day_opus:{utilization:90},seven_day_sonnet:{utilization:40},
  })};
  assert.deepEqual(threadWindows(value,'claude-sonnet-4-6').map(w=>w.usedPercent),[10,20,40]);
  assert.equal(Math.min(...threadWindows(value,'claude-opus-4-6').map(w=>100-w.usedPercent!)),10);
  assert.equal(threadWindows(value,undefined).length,0);
  assert.equal(threadWindows({...value,windows:[{label:'5시간',usedPercent:5,resetsAt:null}]},'claude-opus-4-6').length,0);
  assert.equal(threadWindows({...value,engine:'agy',windows:agyWindows({groups:[{name:'unknown',buckets:[{remaining_fraction:.1}]}]})},'gemini').length,0);
});

test('single custom Codex meter is not mistaken for a global limit', () => {
  const windows=codexWindows({rateLimitsByLimitId:{special:{limitId:'special-model',primary:{usedPercent:99,windowDurationMins:300}},codex:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300}}}});
  const value: EngineUsage={engine:'codex',plan:null,fetchedAt:new Date().toISOString(),windows};
  assert.deepEqual(threadWindows(value,'gpt-5').map(w=>w.usedPercent),[20]);
});

test('runner matching requires exact identity and source, never local/default fallback', () => {
  const targets=[{id:'local',runnerId:'mac',label:'Mac'},{id:'remote',runnerId:'remote',label:'server',source:'s'}];
  assert.equal(threadUsageTarget(targets,'','mac')?.id,'local');
  assert.equal(threadUsageTarget(targets,'s','remote')?.id,'remote');
  assert.equal(threadUsageTarget(targets,'','remote'),undefined);
  assert.equal(threadUsageTarget(targets,'','missing'),undefined);
  assert.equal(threadUsageTarget([{id:'local',label:'old'}],'','mac'),undefined);
  assert.equal(threadUsageTarget([...targets,targets[0]],'','mac'),undefined);
});
