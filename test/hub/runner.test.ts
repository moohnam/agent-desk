import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineAdapter, HubToRunner, RunnerToHub } from '../../shared/protocol.ts';
import { Runner } from '../../hub/src/runner/runner.ts';

type Start = NonNullable<ConstructorParameters<typeof Runner>[2]>['start'];

const start = (sessionId: string, engine = 'claude'): HubToRunner =>
  ({ type: 'start', sessionId, engine: engine as 'claude', cwd: '/tmp', prompt: 'hi', permissionMode: 'default' });

/** A runner whose sessions run `adapter`; `emit` is what the adapter can send. */
function setup(adapter: Partial<EngineAdapter> = {}, idleMs = 60_000) {
  const out: RunnerToHub[] = [];
  let emit!: Parameters<NonNullable<Start>>[0]['emit'];
  const fake: Start = (o) => {
    emit = o.emit;
    return {
      send() {}, interrupt: async () => {}, setMode: async () => {}, setModel: async () => {}, resolveApproval() {}, close() {},
      ...adapter,
    };
  };
  const runner = new Runner('test', (m) => out.push(m), { idleMs, start: fake });
  return { runner, out, emit: (m: RunnerToHub) => emit(m) };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('an engine the runner does not know closes the session instead of running another engine', () => {
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m));
  runner.handle(start('s1', 'gemini'));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'closed');
  assert.match((out[0] as { error?: string }).error ?? '', /gemini/);
  assert.deepEqual(runner.snapshot(), []);
});

test('an adapter that throws on start closes its session', () => {
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m), { start: () => { throw new Error('boom'); } });
  runner.handle(start('s1'));
  assert.deepEqual(out, [{ type: 'closed', sessionId: 's1', busy: false, error: 'boom' }]);
  assert.deepEqual(runner.snapshot(), []);
});

test('the runner passes only its managed MCP connection into engine start options', () => {
  const mcp = { url: 'http://127.0.0.1:4321/v1/mcp', workspaceId: 'fixture', token: 'fixture-token' };
  let received: unknown;
  const runner = new Runner('test', () => {}, { mcp, start: options => {
    received = options.mcp;
    return { send() {}, interrupt: async () => {}, setMode: async () => {}, setModel: async () => {}, resolveApproval() {}, close() {} };
  } });
  runner.handle(start('mcp-session'));
  assert.equal(received, mcp);
});

test('a rejected interrupt becomes a warning on the session, not an unhandled rejection', async () => {
  const { runner, out } = setup({ interrupt: () => Promise.reject(new Error('turn ended')) });
  runner.handle(start('s1'));
  runner.handle({ type: 'interrupt', sessionId: 's1' });
  await tick();
  assert.deepEqual(out, [{
    type: 'event', sessionId: 's1', event: { kind: 'status', state: 'warning', detail: { message: '중단 실패: turn ended' } },
  }]);
});

test('approvals are tracked for a reconnecting hub until answered', () => {
  const answered: string[] = [];
  const { runner, emit } = setup({ resolveApproval: (id) => { answered.push(id); } });
  runner.handle(start('s1'));
  emit({ type: 'busy', sessionId: 's1', busy: true });
  emit({ type: 'approval_request', sessionId: 's1', approvalId: 'a1', toolName: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(runner.snapshot(), [{
    sessionId: 's1', busy: true, approvals: [{ approvalId: 'a1', toolName: 'Bash', input: { command: 'ls' } }],
  }]);
  runner.handle({ type: 'approval_result', sessionId: 's1', approvalId: 'a1', allow: true });
  assert.deepEqual(answered, ['a1']);
  assert.deepEqual(runner.snapshot()[0].approvals, []);
});

test('an idle session is closed after the idle time; a busy one is not', async () => {
  const { runner, out, emit } = setup({}, 20);
  runner.handle(start('idle'));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(out, [{ type: 'closed', sessionId: 'idle', busy: false, reason: 'idle' }]);

  out.length = 0;
  runner.handle(start('busy'));
  emit({ type: 'busy', sessionId: 'busy', busy: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(out.filter((m) => m.type === 'closed'), []);
});

test('closed reports whether the session ended mid-turn', () => {
  const { runner, out, emit } = setup();
  runner.handle(start('s1'));
  emit({ type: 'busy', sessionId: 's1', busy: true });
  emit({ type: 'closed', sessionId: 's1' });
  assert.deepEqual(out.at(-1), { type: 'closed', sessionId: 's1', busy: true });
  assert.deepEqual(runner.snapshot(), []);
});

test('a replaced session\'s later messages are dropped', () => {
  const emits: ((m: RunnerToHub) => void)[] = [];
  const out: RunnerToHub[] = [];
  const runner = new Runner('test', (m) => out.push(m), { start: (o) => {
    emits.push(o.emit);
    return { send() {}, interrupt: async () => {}, setMode: async () => {}, setModel: async () => {}, resolveApproval() {}, close() {} };
  } });
  runner.handle(start('s1'));
  runner.handle(start('s1'));
  emits[0]({ type: 'busy', sessionId: 's1', busy: true });
  assert.deepEqual(out, []);
  emits[1]({ type: 'busy', sessionId: 's1', busy: true });
  assert.deepEqual(out, [{ type: 'busy', sessionId: 's1', busy: true }]);
});

for (const engine of ['claude','codex','agy']) test(`${engine}: model changes finish before the following send; a failed change blocks old-model execution`,async()=>{
  const delivered:string[]=[];
  let finish!:()=>void,fail!:(error:Error)=>void;
  const {runner,out}=setup({send:text=>{delivered.push(text);},setModel:()=>new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;})});
  runner.handle(start('s',engine));
  runner.handle({type:'set_model',sessionId:'s',effort:'high'});
  runner.handle({type:'send',sessionId:'s',text:'after success'});
  await tick();assert.deepEqual(delivered,[]);
  finish();await tick();assert.deepEqual(delivered,['after success']);
  runner.handle({type:'set_model',sessionId:'s',effort:'max'});
  runner.handle({type:'send',sessionId:'s',text:'must not use old model'});
  await tick();fail(new Error('model disappeared'));await tick();
  assert.deepEqual(delivered,['after success']);
  assert.ok(out.some(m=>m.type==='event'&&m.event.kind==='status'&&m.event.state==='error'));
  runner.handle({type:'set_model',sessionId:'s',effort:'medium'});
  runner.handle({type:'send',sessionId:'s',text:'after recovery'});
  await tick();finish();await tick();assert.deepEqual(delivered,['after success','after recovery']);
  runner.shutdown();
});

test('a model gate never sends delayed input into a closed or replacement adapter',async()=>{
  let finish!:()=>void;
  const delivered:string[]=[];
  const {runner}=setup({send:text=>{delivered.push(text);},setModel:()=>new Promise<void>(resolve=>{finish=resolve;})});
  runner.handle(start('s'));
  runner.handle({type:'set_model',sessionId:'s',effort:'high'});
  runner.handle({type:'send',sessionId:'s',text:'stale'});
  await tick();runner.handle({type:'close',sessionId:'s'});runner.handle(start('s'));
  finish();await tick();assert.deepEqual(delivered,[]);runner.shutdown();
});

for (const engine of ['claude','codex','agy']) test(`${engine}: interrupt cancels gate-waiting input before a delayed model change resolves`,async()=>{
  let finish!:()=>void;const called:string[]=[];
  const {runner}=setup({send:text=>{called.push(text);},interrupt:async()=>{called.push('interrupt');},setModel:()=>new Promise<void>(resolve=>{finish=resolve;})});
  runner.handle(start('s',engine));runner.handle({type:'set_model',sessionId:'s',effort:'high'});
  runner.handle({type:'send',sessionId:'s',text:'cancelled'});await tick();
  runner.handle({type:'interrupt',sessionId:'s'});finish();await tick();
  assert.deepEqual(called,['interrupt']);runner.handle({type:'send',sessionId:'s',text:'fresh input'});
  assert.deepEqual(called,['interrupt','fresh input']);runner.shutdown();
});

test('gate-waiting input stays busy through adapter busy:false and cannot be lost to idle eviction',async()=>{
  let finish!:()=>void;const delivered:string[]=[];
  const {runner,emit,out}=setup({send:text=>{delivered.push(text);},setModel:()=>new Promise<void>(resolve=>{finish=resolve;})},15);
  runner.handle(start('s'));runner.handle({type:'set_model',sessionId:'s',effort:'high'});
  runner.handle({type:'send',sessionId:'s',text:'wait for model'});await tick();
  emit({type:'busy',sessionId:'s',busy:false});
  assert.equal(runner.snapshot()[0]?.busy,true);
  assert.deepEqual(out.at(-1),{type:'busy',sessionId:'s',busy:true});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(runner.snapshot().length,1,'pending input protects the idle timer');
  finish();await tick();assert.deepEqual(delivered,['wait for model']);runner.shutdown();
});

test('a runner receipt survives restart without starting the same follow-up twice', async () => {
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'desk-resume-receipt-'));
  const events:RunnerToHub[]=[];
  let starts=0;
  const makeRunner=()=>new Runner('receipt-test',m=>events.push(m),{receiptPath:join(dir,'receipt.db'),start:o=>{
    starts++;
    o.emit({type:'busy',sessionId:o.sessionId,busy:true});
    assert.equal(events.filter(m=>m.type==='event' && m.event.kind==='status' && m.event.detail?.phase==='started').length,0);
    o.onRequestStarted!(o.requestInputId!);
    return {send(){},interrupt:async()=>{},setMode:async()=>{},setModel:async()=>{},resolveApproval(){},close(){}};
  }});
  const cmd={...start('session'),requestInputId:'aaaa-bbbb-cccc-dddd'} as HubToRunner;
  let runner=makeRunner();
  try {
    runner.handle(cmd); runner.shutdown();
    runner=makeRunner();
    runner.handle({type:'request_probe',sessionId:'session',requestInputId:'aaaa-bbbb-cccc-dddd'});
    runner.handle(cmd);
    assert.equal(starts,1);
    const phases=events.flatMap(m=>m.type==='event' && m.event.kind==='status' && m.event.state==='request_receipt' ? [m.event.detail?.phase]:[]);
    assert.deepEqual(phases,['received','started','started','started']);
  } finally {runner.shutdown();rmSync(dir,{recursive:true,force:true});}
});
