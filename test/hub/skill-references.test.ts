import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DESK_INSTRUCTIONS, deskInstructions } from '../../hub/src/runner/instructions.ts';
import { parseCompose } from '../../shared/compose.ts';
import { steeringSkillText } from '../../hub/src/runner/skill-input.ts';

test('sessions without a desk skills root retain the existing instructions', () => {
  assert.equal(deskInstructions(), DESK_INSTRUCTIONS);
});

for (const scenario of [
  { name: 'selected skill and message', source: '문서 작성에는 #parent 를 써주세요.', skills: ['parent'] },
  { name: 'multiple skills without a message', source: '#parent #eli5', skills: ['parent', 'eli5'] },
  { name: 'plain message', source: '계속해 주세요.', skills: [] },
  { name: 'rejected steer falls back to a normal turn', source: '#parent 계속해 주세요.', skills: ['parent'], reject: true },
  { name: 'a hub-wrapped message is not wrapped twice', source: '#parent 이어서 진행', skills: ['parent'], wrapped: true },
]) test(`Codex steer: ${scenario.name}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-skill-steer-'));
  try {
    const home = join(dir, 'plugin with spaces');
    const capture = join(dir, 'requests.jsonl');
    const cli = join(dir, 'fake-codex');
    const parsed = parseCompose(scenario.source, ['parent', 'eli5']);
    const sentText = scenario.wrapped ? steeringSkillText(parsed.body, parsed.skills, home) : parsed.body;
    assert.deepEqual(parsed.skills, scenario.skills);
    writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const write = message => process.stdout.write(JSON.stringify(message) + '\\n');
const completed = () => write({ method: 'turn/completed', params: {
  threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' },
} });
let starts = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.REF_CAPTURE, JSON.stringify(request) + '\\n');
  if (request.id == null) continue;
  if (request.method === 'turn/steer' && ${!!scenario.reject}) {
    write({ id: request.id, error: { code: -32600, message: 'turn ended' } });
    setTimeout(completed, 5);
    continue;
  }
  const result = request.method.startsWith('thread/') ? { thread: { id: 'fixture-thread' } }
    : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } }
    : request.method === 'turn/steer' ? { turnId: 'fixture-turn' } : {};
  write({ id: request.id, result });
  if (request.method === 'turn/start') {
    if (++starts === 1) setTimeout(() => write({ method: 'item/completed', params: {
      threadId: 'fixture-thread', item: { type: 'agentMessage', text: 'READY' },
    } }), 5);
    else setTimeout(completed, 5);
  } else if (request.method === 'turn/steer') setTimeout(completed, 5);
}
`, { mode: 0o755 });
    const adapter = pathToFileURL(resolve(import.meta.dirname, '../../hub/src/runner/codex.ts')).href;
    const driver = `
import { startCodex } from ${JSON.stringify(adapter)};
await new Promise((done, fail) => {
  let completed = 0;
  const timer = setTimeout(() => { engine.close(); fail(Error('adapter timeout')); }, 4000);
  const engine = startCodex({ sessionId: 'fixture', cwd: ${JSON.stringify(dir)}, prompt: '첫 메시지',
    skillsHome: ${JSON.stringify(home)}, permissionMode: 'default',
    emit(message) {
      if (message.type === 'event' && message.event.kind === 'assistant' && message.event.text === 'READY') {
        engine.send(${JSON.stringify(sentText)}, ${JSON.stringify(parsed.skills)}, true);
      } else if (message.type === 'event' && message.event.kind === 'status' && message.event.state === 'turn_done') {
        if (++completed === ${scenario.reject ? 2 : 1}) { clearTimeout(timer); engine.close(); done(); }
      } else if (message.type === 'closed' && message.error) {
        clearTimeout(timer); fail(Error(message.error));
      }
    },
  });
});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: dir, env: { ...process.env, CODEX_BIN: cli, REF_CAPTURE: capture }, encoding: 'utf8', timeout: 6000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const steer = requests.find((r) => r.method === 'turn/steer');
    const skills = scenario.skills.map((name) => ({ type: 'skill', name, path: join(home, 'skills', name, 'SKILL.md') }));
    assert.equal(steer.params.expectedTurnId, 'fixture-turn');
    assert.deepEqual(steer.params.input.filter((item: any) => item.type === 'skill'), skills);
    const text = steer.params.input.find((item: any) => item.type === 'text').text;
    if (skills.length) {
      assert.equal(text.split('[데스크 스킬]').length - 1, 1);
      assert.ok(text.includes('먼저 다음 스킬 파일을 읽고 그 지침을 따르세요'));
      for (const skill of skills) assert.ok(text.includes(`#${skill.name}: ${JSON.stringify(skill.path)}`));
      assert.ok(text.endsWith(parsed.body || '(추가 지시 없음)'));
    } else assert.equal(text, parsed.body);
    const starts = requests.filter((r) => r.method === 'turn/start');
    assert.equal(starts.length, scenario.reject ? 2 : 1);
    if (scenario.reject) assert.deepEqual(starts[1].params.input, [
      ...skills, { type: 'text', text: parsed.body, text_elements: [] },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agy resume receives current instructions once, not again on a follow-up turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-agy-ref-'));
  try {
    const home = join(dir, 'plugin with spaces');
    const capture = join(dir, 'requests.jsonl');
    const cli = join(dir, 'fake-agy');
    writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv[2] === 'models') { console.log('gemini-3.8-flash-medium'); process.exit(0); }
appendFileSync(process.env.REF_CAPTURE, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(process.env.REF_CAPTURE, line + '\\n');
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
}
`, { mode: 0o755 });
    const adapter = pathToFileURL(resolve(import.meta.dirname, '../../hub/src/runner/agy.ts')).href;
    const driver = `
import { startAgy } from ${JSON.stringify(adapter)};
await new Promise((done, fail) => {
  let turns = 0;
  const timer = setTimeout(() => { engine.close(); fail(Error('adapter timeout')); }, 4000);
  const engine = startAgy({ sessionId: 'fixture', cwd: ${JSON.stringify(dir)}, prompt: '짧게 설명해 주세요',
    skillsHome: ${JSON.stringify(home)}, resume: 'existing-conversation', permissionMode: 'default',
    emit(message) {
      if (message.type === 'event' && message.event.kind === 'status' && message.event.state === 'turn_done') {
        if (++turns === 1) engine.send('계속');
        else { clearTimeout(timer); engine.close(); done(); }
      } else if (message.type === 'closed' && message.error) {
        clearTimeout(timer); fail(Error(message.error));
      }
    },
  });
});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: dir, env: { ...process.env, AGY_BIN: cli, REF_CAPTURE: capture }, encoding: 'utf8', timeout: 6000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(requests[0].args.includes('existing-conversation'));
    const turns = requests.filter((r) => r.event === 'user');
    assert.equal(turns.length, 2);
    assert.ok(turns[0].message.content.includes(DESK_INSTRUCTIONS));
    assert.ok(turns[0].message.content.includes(JSON.stringify(join(home, 'skills'))));
    assert.equal(turns[1].message.content, '계속');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Exercise the actual adapter against a local JSON-RPC peer; no real CLI or model is invoked.
for (const resume of [false, true]) test(`Codex ${resume ? 'resume' : 'start'} receives the skill root without eagerly loading children or changing approval mode`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-skill-ref-'));
  try {
    const home = join(dir, 'plugin with spaces');
    const project = join(dir, 'other project');
    const parent = join(home, 'skills', 'parent', 'SKILL.md');
    const child = join(home, 'skills', 'eli5', 'SKILL.md');
    mkdirSync(join(home, 'skills', 'parent'), { recursive: true });
    mkdirSync(join(home, 'skills', 'eli5'), { recursive: true });
    mkdirSync(project);
    const source = '---\nname: parent\ndescription: fixture\n---\n쉬운 설명이 필요하면 #eli5 를 읽는다.\n예시: #auto #now\n';
    writeFileSync(parent, source);
    writeFileSync(child, 'CHILD_BODY_MUST_NOT_BE_PRELOADED');
    const capture = join(dir, 'requests.jsonl');
    const cli = join(dir, 'fake-codex');
    writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const write = message => process.stdout.write(JSON.stringify(message) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.REF_CAPTURE, JSON.stringify(request) + '\\n');
  if (request.id == null) continue;
  const result = request.method.startsWith('thread/') ? { thread: { id: 'fixture-thread' } }
    : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } } : {};
  write({ id: request.id, result });
  if (request.method === 'turn/start') setTimeout(() => write({ method: 'turn/completed', params: {
    threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' },
  } }), 5);
}
`, { mode: 0o755 });
    const adapter = pathToFileURL(resolve(import.meta.dirname, '../../hub/src/runner/codex.ts')).href;
    const driver = `
import { startCodex } from ${JSON.stringify(adapter)};
await new Promise((done, fail) => {
  const timer = setTimeout(() => { engine.close(); fail(Error('adapter timeout')); }, 4000);
  const engine = startCodex({ sessionId: 'fixture', cwd: ${JSON.stringify(project)}, prompt: '짧게 설명해 주세요',
    skillsHome: ${JSON.stringify(home)}, skills: ['parent'], permissionMode: 'default',
    ${resume ? "resume: 'fixture-thread'," : ''}
    emit(message) {
      if (message.type === 'event' && message.event.kind === 'status' && message.event.state === 'turn_done') {
        clearTimeout(timer); engine.close(); done();
      } else if (message.type === 'closed' && message.error) {
        clearTimeout(timer); fail(Error(message.error));
      }
    },
  });
});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: project, env: { ...process.env, CODEX_BIN: cli, REF_CAPTURE: capture }, encoding: 'utf8', timeout: 6000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const thread = requests.find((r) => r.method === (resume ? 'thread/resume' : 'thread/start'));
    assert.ok(thread.params.developerInstructions.startsWith(DESK_INSTRUCTIONS));
    assert.ok(thread.params.developerInstructions.includes(JSON.stringify(join(home, 'skills'))));
    assert.equal(thread.params.approvalPolicy, 'untrusted');
    const turn = requests.find((r) => r.method === 'turn/start');
    assert.equal(turn.params.approvalPolicy, 'untrusted');
    assert.deepEqual(turn.params.input, [
      { type: 'skill', name: 'parent', path: parent },
      { type: 'text', text: '짧게 설명해 주세요', text_elements: [] },
    ]);
    assert.ok(!JSON.stringify(requests).includes('CHILD_BODY_MUST_NOT_BE_PRELOADED'));
    assert.equal(readFileSync(parent, 'utf8'), source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
