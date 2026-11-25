import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { subagentTracker } from '../../hub/src/runner/claude.ts';
import { checkHubToRunner, checkRunnerToHub, type RunnerToHub } from '../../shared/protocol.ts';

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

test('the Claude tracker follows a subagent from its start through a follow-up to its end', () => {
  const out: RunnerToHub[] = [];
  const track = subagentTracker('s', (m) => out.push(m));
  // A subagent's message can come before the task_started that names it; it waits for it.
  assert.equal(track(sdk({ type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '보겠습니다' }] } })), true);
  assert.equal(out.length, 0);
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'call', description: '조사', task_type: 'local_agent', subagent_type: 'general-purpose', is_backgrounded: true, prompt: '찾아 줘' }));
  track(sdk({ type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }));
  track(sdk({ type: 'user', parent_tool_use_id: 'call', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } }));
  track(sdk({ type: 'system', subtype: 'task_progress', task_id: 'a1', description: '조사', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 }, last_tool_name: 'Bash' }));
  track(sdk({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: '두 개', output_file: '' }));
  // SendMessage resumes it: task_started again, the message as its prompt; its messages keep the first call's id.
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'send', description: '조사', prompt: '하나 더' }));
  track(sdk({ type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'text', text: '했습니다' }] } }));
  assert.equal(track(sdk({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } })), false, 'the main conversation is not its');
  const steps = out.filter((m) => m.type === 'subagent_event').map((m) => m.type === 'subagent_event' && `${m.subagentId}:${m.event.kind}`);
  assert.deepEqual(steps, ['a1:user', 'a1:assistant', 'a1:tool', 'a1:tool_result', 'a1:user', 'a1:assistant']);
  const reports = out.filter((m) => m.type === 'subagent').map((m) => m.type === 'subagent' && m.subagent);
  assert.deepEqual(reports.map((r) => r && r.status), ['running', 'completed', 'running']);
  assert.equal(reports[1] && reports[1].summary, '두 개');
  assert.deepEqual(reports[1] && reports[1].usage, { tokens: 10, toolUses: 1, durationMs: 5 });
  assert.equal(reports[2] && reports[2].agent, 'general-purpose', 'a follow-up keeps what was known');
  assert.equal(reports[2] && reports[2].toolUseId, 'call', 'the call that started it, not the follow-up');
  for (const m of out) assert.equal(typeof checkRunnerToHub(m), 'object');
});

test('ambient tasks are not tracked', () => {
  const out: RunnerToHub[] = [];
  const track = subagentTracker('s', (m) => out.push(m));
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'w', description: 'watch', ambient: true }));
  assert.equal(out.length, 0);
});

test('subagent messages are checked like the rest', () => {
  assert.equal(typeof checkRunnerToHub({ type: 'subagent', sessionId: 's', subagent: { id: 'a', type: 't', description: 'd', status: 'odd' } }), 'string');
  assert.equal(typeof checkRunnerToHub({ type: 'subagent_event', sessionId: 's', subagentId: 'a', event: { kind: 'status' } }), 'string');
  assert.equal(typeof checkRunnerToHub({ type: 'subagent_event', sessionId: 's', subagentId: '', event: { kind: 'user', text: 'x' } }), 'string');
  const start = { type: 'start', sessionId: 's', engine: 'claude', cwd: '/x', prompt: 'p', permissionMode: 'auto' };
  assert.equal(typeof checkHubToRunner({ ...start, subagents: true }), 'object');
  assert.equal(typeof checkHubToRunner({ ...start, subagents: 'yes' }), 'string');
});

test('frames of an earlier run come late and are dropped; a huge input is cut', () => {
  const out: RunnerToHub[] = [];
  const track = subagentTracker('s', (m) => out.push(m));
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', run_id: 'r1', tool_use_id: 'call', description: 'd' }));
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'a1', run_id: 'r2', tool_use_id: 'send', description: 'd' }));
  track(sdk({ type: 'system', subtype: 'task_notification', task_id: 'a1', run_id: 'r1', status: 'completed', summary: 'old', output_file: '' }));
  const last = out.filter((m) => m.type === 'subagent').at(-1);
  assert.equal(last?.type === 'subagent' && last.subagent.status, 'running');
  track(sdk({ type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'x'.repeat(200_000) } }] } }));
  const step = out.at(-1);
  assert.ok(step?.type === 'subagent_event' && JSON.stringify(step).length < 70_000);
});

test('a command the turn waits for is recorded only once it moves to the background', () => {
  const out: RunnerToHub[] = [];
  const track = subagentTracker('s', (m) => out.push(m));
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't1', description: 'ls', task_type: 'local_bash', is_backgrounded: false }));
  track(sdk({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: '', output_file: '' }));
  assert.equal(out.length, 0);
  track(sdk({ type: 'system', subtype: 'task_started', task_id: 'b2', tool_use_id: 't2', description: 'npm test', task_type: 'local_bash', is_backgrounded: false }));
  track(sdk({ type: 'system', subtype: 'task_updated', task_id: 'b2', patch: { is_backgrounded: true } }));
  const last = out.at(-1);
  assert.ok(last?.type === 'subagent' && last.subagent.id === 'b2' && last.subagent.background === true);
});
