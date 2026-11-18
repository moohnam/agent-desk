import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { UpdateView } from '../../shared/update.ts';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const status = (changes: Partial<UpdateView> = {}): UpdateView => ({
  configured: true, current: a, latest: b, available: b, phase: 'ready', checking: false,
  targets: ['hub', 'daemon'], summary: {commits: [{sha: b, subject: '설정 버전 정보 추가'}], files: 3, hub: true, runner: true},
  canApply: true, reason: null, approval: null, error: null, discoveryError: null, ...changes,
});
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  const context = {exports: {}, require: (name: string) => {assert.ok(name in imports, `missing ${name}`); return imports[name];}, ...globals};
  runInNewContext(code, context); return context.exports;
}
function hooks() {
  const slots: any[] = []; let cursor = 0, effects: (() => void)[] = [];
  return {
    react: {
      useState(initial: any) {const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: any) => {slots[i] = v;}];},
      useRef(initial: any) {const i = cursor++; return slots[i] ??= {current: initial};},
      useCallback(fn: any) {return fn;},
      useEffect(fn: () => any, deps: any[]) {const i = cursor++; if (!slots[i]) effects.push(() => {slots[i] = {cleanup: fn(), deps};});},
    },
    render<T>(fn: () => T) {cursor = 0; const result = fn(); const pending = effects; effects = []; pending.forEach(f => f()); return result;},
    unmount() {slots.forEach(slot => slot?.cleanup?.());},
  };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const h = hooks(), calls: any[][] = [];
  const requests: {signal: AbortSignal; resolve: (v: UpdateView) => void}[] = [];
  const timers = new Map<number, {callback: () => void; delay: number}>(); let seq = 0;
  const listeners = new Map<string, () => void>();
  const document = {hidden: false, addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), removeEventListener: (event: string) => listeners.delete(event)};
  let approved = status({approval: {commit: b, mode: 'when-idle'}, phase: 'waiting'}), fail = '', hang = false;
  const api = {
    updates: (signal: AbortSignal) => {calls.push(['get']); return new Promise<UpdateView>(resolve => requests.push({signal, resolve}));},
    checkUpdates: async () => {calls.push(['check']); return status({checking: true, phase: 'checking'});},
    approveUpdate: async (commit: string, mode: string, signal: AbortSignal) => {calls.push(['approve', commit, mode]); if (hang) return new Promise<UpdateView>((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), {once: true})); if (fail) throw Error(fail); return approved;},
    cancelUpdate: async (commit: string) => {calls.push(['cancel', commit]); return status();},
  };
  const mod = load('useUpdates.ts', {react: h.react, './api.ts': {api}}, {
    document, AbortController, Date,
    setTimeout: (callback: () => void, delay: number) => {const id = ++seq; timers.set(id, {callback, delay}); return id;},
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {h, calls, requests, timers, listeners, document,
    render: () => h.render(() => mod.useUpdates()),
    run(delay: number) {const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `timer ${delay}`); timers.delete(entry[0]); entry[1].callback();},
    fail(message: string) {fail = message;}, approved(value: UpdateView) {approved = value;},
    hang() {hang = true;},
  };
}

test('badge status polling never checks or approves; hidden/unmounted readers abort and discard late responses', async () => {
  const x = harness(); x.render(); assert.deepEqual(x.calls, [['get']]);
  x.document.hidden = true; x.listeners.get('visibilitychange')!();
  assert.equal(x.requests[0].signal.aborted, true);
  x.requests[0].resolve(status()); await settle();
  assert.equal(x.render().view, null); assert.equal(x.timers.size, 0);
  x.document.hidden = false; x.listeners.get('visibilitychange')!();
  x.requests[1].resolve(status()); await settle();
  assert.equal(x.render().view.available, b);
  x.run(60_000); assert.deepEqual(x.calls, [['get'], ['get'], ['get']]);
  x.h.unmount(); assert.equal(x.requests[2].signal.aborted, true);
  x.requests[2].resolve(status({available: c})); await settle();
  assert.equal(x.timers.size, 0); assert.equal(x.listeners.size, 0);
});

test('approval pins the rendered commit; busy failures never become an automatic idle reservation', async () => {
  const x = harness(); x.render(); x.requests[0].resolve(status()); await settle();
  await x.render().approve(c, 'immediate'); assert.deepEqual(x.calls, [['get']]);
  assert.match(x.render().error, /대상 버전/);
  x.fail('진행 중인 작업이 있습니다');
  await x.render().approve(b, 'immediate');
  assert.deepEqual(x.calls, [['get'], ['approve', b, 'immediate']]);
  x.run(0); x.requests[1].resolve(status()); await settle();
  assert.match(x.render().error, /진행 중인 작업/);
  assert.equal(x.calls.some(call => call[2] === 'when-idle'), false);
  x.fail(''); await x.render().approve(b, 'when-idle');
  assert.equal(x.render().view.approval.commit, b);
  await x.render().cancel(c); assert.equal(x.calls.filter(call => call[0] === 'cancel').length, 0);
  await x.render().cancel(b); assert.equal(x.calls.at(-1)?.[0], 'cancel'); assert.equal(x.calls.at(-1)?.[1], b);
  x.h.unmount();
});

test('a poll started before approval cannot overwrite its result; accepted transitions receive a quick follow-up', async () => {
  const x = harness(); x.render(); x.requests[0].resolve(status()); await settle();
  x.run(60_000); const stale = x.requests[1];
  await x.render().approve(b, 'when-idle'); assert.equal(stale.signal.aborted, true);
  stale.resolve(status({available: c})); await settle();
  assert.equal(x.render().view.available, b); assert.equal(x.render().view.phase, 'waiting');
  x.run(0); x.requests[2].resolve(status({phase: 'ready'})); await settle();
  assert.ok([...x.timers.values()].some(timer => timer.delay === 2000)); x.h.unmount();
});

test('an unconfirmed approval times out, releases the settings guard and only reloads status', async () => {
  const x = harness(); x.render(); x.requests[0].resolve(status()); await settle(); x.hang();
  const pending = x.render().approve(b, 'immediate'); assert.equal(x.render().busy, true);
  x.run(15_000); await pending;
  assert.equal(x.render().busy, false); assert.match(x.render().error, /반영되었을 수/);
  x.run(0); x.requests[1].resolve(status({approval: {commit: b, mode: 'immediate'}})); await settle();
  assert.equal(x.render().view.approval.commit, b);
  assert.deepEqual(x.calls, [['get'], ['approve', b, 'immediate'], ['get']]);
  x.h.unmount(); assert.equal(x.timers.size, 0);
});

const jsx = (type: any, props: any) => ({type, props});
const ui = load('Updates.tsx', {
  'react/jsx-runtime': {jsx, jsxs: jsx}, './settingsPanel.tsx': {useSettingsPanel() {}}, 'lucide-react': {Settings: 'Settings'},
});
const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
const text = (node: any): string => !node ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
const button = (tree: any, label: string) => all(tree).find(node => node.type === 'button' && text(node) === label);

test('isolated settings fixture shows real commits, summary, managed-runtime restriction and the version badge', () => {
  const view = status({canApply: false, reason: '허브가 관리형 업데이트 서비스로 실행 중이 아닙니다.'});
  const state = {view, busy: false, error: '', unavailable: false, check() {}, approve() {}, cancel() {}};
  const tree = ui.Updates({state, local: true});
  assert.ok(text(tree).includes(a)); assert.ok(text(tree).includes(b));
  assert.match(text(tree), /설정 버전 정보 추가/); assert.match(text(tree), /러너 데몬/);
  assert.match(text(tree), /관리형 업데이트 서비스/);
  assert.equal(button(tree, '지금 적용').props.disabled, true);
  assert.equal(button(tree, '작업 종료 후 적용').props.disabled, true);
  const badge = ui.UpdateSettingsButton({available: true, open: false, onOpen() {}});
  assert.equal(badge.props['aria-label'], '설정: 새 버전 있음');
  assert.ok(all(badge).some(node => node.props?.className === 'settings-update-badge'));
  assert.equal(all(ui.UpdateSettingsButton({available: false, open: false, onOpen() {}})).some(node => node.props?.className === 'settings-update-badge'), false);
});

test('only explicit controls approve/cancel a specific prepared SHA; discovered versions require preparation', () => {
  const calls: any[] = [], state = {view: status(), busy: false, error: '', unavailable: false,
    check: () => calls.push('check'), approve: (commit: string, mode: string) => calls.push([commit, mode]), cancel: (commit: string) => calls.push(['cancel', commit])};
  let tree = ui.Updates({state, local: true}); button(tree, '지금 적용').props.onClick(); button(tree, '작업 종료 후 적용').props.onClick();
  assert.deepEqual(calls, [[b, 'immediate'], [b, 'when-idle']]);
  state.view = status({approval: {commit: b, mode: 'when-idle'}, phase: 'waiting'});
  tree = ui.Updates({state, local: true}); button(tree, '예약 취소').props.onClick(); assert.deepEqual(calls.at(-1), ['cancel', b]);
  state.view = status({available: null, summary: null}); tree = ui.Updates({state, local: true});
  assert.ok(text(tree).includes(b)); assert.equal(button(tree, '지금 적용'), undefined); assert.ok(button(tree, '새 버전 준비'));
  state.view = status({latest: c}); tree = ui.Updates({state, local: true});
  assert.match(text(tree), /발견한 버전과 준비된 버전이 다릅니다/);
  assert.ok(button(tree, '새 버전 준비'));
  button(tree, '지금 적용').props.onClick(); assert.deepEqual(calls.at(-1), [b, 'immediate']);
  state.view = status(); tree = ui.Updates({state, local: false}); assert.equal(button(tree, '지금 적용').props.disabled, true);
});

test('waiting without approval never claims a reservation; current and unknown revisions are described honestly', () => {
  const state = {view: status({phase: 'waiting', approval: null}), busy: false, error: '', unavailable: false, check() {}, approve() {}, cancel() {}};
  let tree = ui.Updates({state, local: true});
  assert.match(text(tree), /적용하지 못했습니다/); assert.equal(button(tree, '예약 취소'), undefined);
  state.view = status({current: b}); tree = ui.Updates({state, local: true}); assert.match(text(tree), /현재 최신 버전/);
  state.view = status({current: null, discoveryError: '원격 서버 응답 없음'}); tree = ui.Updates({state, local: true});
  assert.match(text(tree), /비교할 수 없습니다/); assert.match(text(tree), /원격 서버 응답 없음/);
});
