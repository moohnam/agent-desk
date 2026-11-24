import assert from 'node:assert/strict';
import * as federation from '../../web/src/federation.ts';
import * as draftRetention from '../../web/src/draftRetention.ts';
import * as posts from '../../web/src/posts.ts';
import * as feedCache from '../../web/src/feedCache.ts';
import * as noteEvents from '../../web/src/noteEvents.ts';
import * as keys from '../../web/src/keys.ts';
import * as editorIndent from '../../web/src/editorIndent.ts';
import * as emacsKeys from '../../web/src/emacsKeys.ts';
import * as slackEmoji from '../../web/src/slackEmoji.ts';
import * as documentLinks from '../../web/src/documentLinks.ts';
import type { HubEvent } from '../../web/src/types.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as compose from '../../shared/compose.ts';
import * as modelCatalog from '../../shared/model-catalog.ts';
import * as scheduledReply from '../../shared/scheduled-reply.ts';
import * as runnerUsage from '../../shared/runner-usage.ts';
import * as questionInput from '../../shared/question-input.ts';

// Execute the real browser modules with deterministic hooks and browser boundaries.
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = ''): any {
  const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8') + extra;
  imports={ './modelCatalogs.ts':{useModelCatalogs:()=>({runners:[],loading:false,error:'',refresh(){}})},'../../shared/model-catalog.ts':modelCatalog,'../../shared/scheduled-reply.ts':scheduledReply,'./sourceStream.ts':{openSourceStream:()=>new (globals.EventSource as any)()},'./answerComposer.tsx':{useAnswerTarget:()=>undefined,AnswerDestination:()=>null},'./federation.ts':federation,'./draftRetention.ts':draftRetention,'./Workspaces.tsx':{useSources:()=>[]},'./noteEvents.ts':noteEvents,'./NotePreview.tsx':{NotePreview:()=>null},...imports};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = { window: { addEventListener() {}, removeEventListener() {} }, exports: {}, require: (name: string) => {
    if (name === './keys.ts') return keys;
    if (name === './slackEmoji.ts') return slackEmoji;
    if (name === './EditorInput.tsx' && !(name in imports)) return { EditorInput: () => null, editorText: (text: string) => text, inputElement: (input: any) => input?.element ?? input };
    assert.ok(name in imports, `missing mock: ${name}`);
    return imports[name];
  }, ...globals };
  runInNewContext(code, context);
  return context.exports;
}

function hooks() {
  const slots: any[] = [];
  let cursor = 0, effects: (() => void)[] = [];
  const react = {
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
    useReducer(reduce: (state: number) => number, initial: number) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], () => { slots[i] = reduce(slots[i]); }];
    },
    useMemo(fn: () => any) { return fn(); },
    useCallback(fn:any,deps:any[]) {const i=cursor++,old=slots[i];if(!old||!deps.every((v,j)=>Object.is(v,old.deps[j])))slots[i]={deps,fn};return slots[i].fn;},
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++, old = slots[i];
      if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return;
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    },
  };
  return { react, render<T>(fn: () => T): T {
    cursor = 0; const value = fn(); const pending = effects; effects = []; pending.forEach(f => f()); return value;
  }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}

function workspace(id: string) {
  return { workspaceId: id, workspaceKey: (key: string) => id ? `${key}.workspace.${id}` : key };
}

test('clearing the reference pane closes it, resets the document focus and preserves another thread', () => {
  const h = hooks(), saved = new Map<string, string>(), gone = new Set<string>();
  const { useThreadReferences } = load('threadReferences.ts', { react: h.react, './workspace.ts': workspace(''), './documentLinks.ts': documentLinks }, {
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
  });
  const render = (task: string) => h.render(() => useThreadReferences(task, gone));
  render('other').toggle(10);
  const first = render('current');
  first.toggle(20);
  first.addFile('current', '/preview.md');
  const open = render('current');
  assert.equal(open.open, true);
  assert.equal(open.fileFocus?.href, '/preview.md');
  open.clear();
  const cleared = render('current');
  assert.equal(cleared.open, false);
  assert.equal(cleared.ids.length, 0);
  assert.equal(cleared.files, undefined);
  assert.equal(cleared.fileFocus, undefined);
  assert.equal(render('other').ids[0], 10);
});

const askOptions = [{ label: '표준' }];
function askCardHarness(questions: { question: string; options?: typeof askOptions; multiSelect?: boolean; secret?: boolean }[], stored = new Map<string, string>()) {
  const h = hooks();
  const react = { ...h.react, useSyncExternalStore<T>(_subscribe: unknown, snapshot: () => T) { return snapshot(); } };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx } };
  let flush = () => {};
  const drafts = load('drafts.ts', { ...imports, './workspace.ts': workspace('') }, {
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    addEventListener: (name: string, listener: () => void) => { if (name === 'pagehide') flush = listener; },
    setTimeout: () => 1, clearTimeout() {},
  });
  const composer = load('answerComposer.tsx', { ...imports, './drafts.ts': drafts }, {
    window: { dispatchEvent() {} }, CustomEvent,
  });
  const answers: Record<string, string>[] = [];
  const module = load('AskCard.tsx', {
    ...imports, './drafts.ts': drafts, './answerComposer.tsx': composer, '../../shared/protocol.ts': {},
    '../../shared/question-input.ts': questionInput,
    './api.ts': { api: { resolve: async (_id: string, _allow: boolean, _message: string, answer: Record<string, string>) => { answers.push({ ...answer }); } } },
  });
  const taskId = 'task', approval = { id: 'approval' };
  const post = { taskId, event: { payload: { approvalId: approval.id, input: { questions } } } };
  const render = () => h.render(() => ({
    card: module.AskCard({ post, approval }), target: composer.useAnswerTarget(taskId),
  }));
  const option = (index: number, choice: number) => render().card.props.children[1][index].props.children[1].props.children.flat()[choice].props;
  return {
    option, answers,
    target: () => render().target?.title,
    ready: () => !render().card.props.children[2].props.children.at(-1).props.disabled,
    field: (index: number) => render().card.props.children[1][index].props.children[3],
    write: () => render().card.props.children[1][0].props.children[3].props.children[0].props.onClick(),
    send: async () => { render().card.props.children[2].props.children.at(-1).props.onClick(); await new Promise<void>(resolve => setImmediate(resolve)); },
    submit: (text: string) => composer.submitAnswer(render().target, text),
    reload() { flush(); h.unmount(); return askCardHarness(questions, stored); },
  };
}

test('AskCard keeps Other in the card, restores its draft and sends it explicitly', async () => {
  const x = askCardHarness([{ question: '첫 질문', options: askOptions }]);
  x.option(0, 0).onClick();
  x.option(0, 1).onClick();
  assert.equal(x.option(0, 0)['aria-checked'], false);
  assert.equal(x.option(0, 1)['aria-checked'], true);
  assert.equal(x.target(), undefined);
  assert.equal(x.ready(), false);
  assert.equal(x.field(0).type, 'textarea');
  x.field(0).props.onChange({ target: { value: '직접 입력' } });
  const reloaded = x.reload();
  assert.equal(reloaded.field(0).props.value, '직접 입력');
  assert.equal(reloaded.target(), undefined);
  assert.deepEqual(reloaded.answers, []);
  await reloaded.send();
  assert.deepEqual(reloaded.answers, [{ '첫 질문': '직접 입력' }]);
});

test('AskCard keeps a batch in the card and collects every answer', async () => {
  const x = askCardHarness([{ question: '첫 질문', options: askOptions, multiSelect: true }, { question: '둘째 질문' }]);
  x.option(0, 0).onClick();
  x.option(0, 1).onClick();
  x.field(0).props.onChange({ target: { value: '첫 번째 입력' } });
  assert.equal(x.option(0, 0)['aria-checked'], true);
  assert.equal(x.target(), undefined);
  assert.equal(x.ready(), false);
  x.field(1).props.onChange({ target: { value: '두 번째 입력' } });
  await x.send();
  assert.deepEqual(x.answers, [{ '첫 질문': '표준, 첫 번째 입력', '둘째 질문': '두 번째 입력' }]);
});

test('AskCard routes only a single non-secret open question to the reply composer', async () => {
  const stored = new Map([['agent-desk.drafts.v1', JSON.stringify({
    'answer-target:task': { taskId: 'task', value: { key: 'task:approval:approval', taskId: 'task', title: '이전 대상', index: 0 }, at: Date.now() },
  })]]);
  const x = askCardHarness([{ question: '열린 질문' }], stored);
  assert.equal(x.target(), undefined);
  x.write();
  assert.equal(x.target(), '열린 질문');
  await x.submit('답변');
  assert.deepEqual(x.answers, [{ '열린 질문': '답변' }]);
  const secret = askCardHarness([{ question: '비밀 질문', secret: true }]);
  assert.equal(secret.field(0).props.type, 'password');
  assert.equal(secret.target(), undefined);
});

function threadTitleHarness() {
  const h = hooks();
  const requests: { id: string; title: string; resolve: (task: any) => void; reject: (error: Error) => void }[] = [];
  const renamed: { id: string; title: string; revision: number }[] = [], notices: string[] = [];
  class SharedPending extends Error {}
  const jsx = (type: any, props: any) => ({ type, props });
  const module = load('ThreadHead.tsx', {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {},
    '../../shared/compose.ts': compose,
    './projects.ts': { modelShort: (s: string) => s, projectColor: () => '#123456' },
    './badges.tsx': { DraftBadge: 'DraftBadge', StatusBadge: 'StatusBadge', TerminalBadge: 'TerminalBadge' },
    './api.ts': { api: { renameTask: (id: string, title: string) => new Promise((resolve, reject) => requests.push({ id, title, resolve, reject })) } },
    './workspace.ts': { SharedPending },
  });
  const task = (id: string) => ({ id, title: `기존 ${id}`, project_id: 'project', project_name: 'project', seq: 1,
    status: 'done', engine: 'codex', source: 'app', live: false, runner_connected: true });
  const render = (current: any) => h.render(() => module.ThreadHead({ task: current, project: undefined, model: undefined,
    events: [], now: 0, draft: false, handoff: null, onClose() {}, onPin() {}, onHandoff() {}, onMenu() {},
    onNotice: (message: string) => notices.push(message), onRenamed: (id: string, title: string, revision: number) => renamed.push({ id, title, revision }) }));
  const find = (node: any, match: (node: any) => boolean): any => {
    if (!node || typeof node !== 'object') return undefined;
    if (match(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, match); if (found) return found; }
  };
  const titleButton = (tree: any) => find(tree, node => node.type === 'button' && node.props?.title === '제목 바꾸기');
  const input = (tree: any) => find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '작업 제목');
  const alert = (tree: any) => find(tree, node => node.props?.role === 'alert');
  const key = (name: string, composing = false) => ({ key: name, nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() {} });
  return { h, requests, renamed, notices, SharedPending, task, render, titleButton, input, alert, key };
}
const settleTitle = () => new Promise<void>(resolve => setImmediate(resolve));

test('thread title Enter and blur save once; Escape, IME Enter and empty input do not save', async () => {
  const x = threadTitleHarness(), task = x.task('one');
  x.titleButton(x.render(task)).props.onClick();
  let input = x.input(x.render(task));
  input.props.onChange({ target: { value: '  새 제목  ' } });
  input = x.input(x.render(task));
  input.props.onKeyDown(x.key('Enter', true));
  assert.equal(x.requests.length, 0, 'IME confirmation does not submit');
  input.props.onKeyDown(x.key('Enter'));
  input.props.onBlur();
  assert.deepEqual(x.requests.map(r => [r.id, r.title]), [['one', '새 제목']]);
  x.requests[0].resolve({ ...task, title: '새 제목', title_revision: 1 });
  await settleTitle();
  assert.equal(x.input(x.render({ ...task, title: '새 제목' })), undefined);
  assert.deepEqual(x.renamed, [{ id: 'one', title: '새 제목', revision: 1 }]);

  x.titleButton(x.render(task)).props.onClick();
  input = x.input(x.render(task));
  input.props.onChange({ target: { value: '취소' } });
  input = x.input(x.render(task));
  input.props.onKeyDown(x.key('Escape'));
  input.props.onBlur();
  assert.equal(x.requests.length, 1, 'Escape suppresses the following blur');
  assert.equal(x.input(x.render(task)), undefined);

  x.titleButton(x.render(task)).props.onClick();
  input = x.input(x.render(task));
  input.props.onChange({ target: { value: '  ' } });
  x.input(x.render(task)).props.onBlur();
  assert.equal(x.requests.length, 1);
  assert.match(x.alert(x.render(task)).props.children, /제목을 입력/);
});

test('thread title failures stay editable, durable pending closes, and old completions preserve the next task draft', async () => {
  const x = threadTitleHarness(), first = x.task('first'), next = x.task('next');
  x.titleButton(x.render(first)).props.onClick();
  x.input(x.render(first)).props.onChange({ target: { value: '실패 제목' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.requests[0].reject(new Error('저장 실패'));
  await settleTitle();
  assert.match(x.alert(x.render(first)).props.children, /저장 실패/);
  x.input(x.render(first)).props.onChange({ target: { value: '보관 제목' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.requests[1].reject(new x.SharedPending('전달 대기'));
  await settleTitle();
  assert.equal(x.input(x.render(first)), undefined);
  assert.deepEqual(x.notices, ['전달 대기']);

  x.titleButton(x.render(first)).props.onClick();
  x.input(x.render(first)).props.onChange({ target: { value: '첫 작업 제목' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.titleButton(x.render(next)).props.onClick();
  x.input(x.render(next)).props.onChange({ target: { value: '다음 작업 초안' } });
  x.requests[2].resolve({ ...first, title: '첫 작업 제목' });
  await settleTitle();
  assert.equal(x.input(x.render(next)).props.value, '다음 작업 초안');
  assert.deepEqual(x.renamed, [], 'a response for a left task does not change another draft');
});

test('late title responses from an earlier edit or unmounted head do not reverse a newer title', async () => {
  const x = threadTitleHarness(), first = x.task('first'), other = x.task('other');
  x.titleButton(x.render(first)).props.onClick();
  x.input(x.render(first)).props.onChange({ target: { value: '오래된 제목' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.render(other);
  x.titleButton(x.render(first)).props.onClick();
  x.input(x.render(first)).props.onChange({ target: { value: '최신 제목' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.requests[1].resolve({ ...first, title: '최신 제목', title_revision: 2 });
  await settleTitle();
  x.requests[0].resolve({ ...first, title: '오래된 제목' });
  await settleTitle();
  assert.deepEqual(x.renamed, [{ id: 'first', title: '최신 제목', revision: 2 }]);

  x.titleButton(x.render(first)).props.onClick();
  x.input(x.render(first)).props.onChange({ target: { value: '언마운트 뒤 응답' } });
  x.input(x.render(first)).props.onKeyDown(x.key('Enter'));
  x.h.unmount();
  x.requests[2].resolve({ ...first, title: '언마운트 뒤 응답' });
  await settleTitle();
  assert.deepEqual(x.renamed, [{ id: 'first', title: '최신 제목', revision: 2 }]);
});

test('a late rename response preserves SSE metadata and cannot reverse an ABA title change', async () => {
  const h = hooks(), streams: any[] = [], remembered: any[] = [];
  const task = { id: 'task', project_id: 'project', title: '기존 제목', title_revision: 0, status: 'running', updated_at: 'old', live: true };
  const module = load('useHub.ts', {
    react: h.react,
    './api.ts': { api: { state: async () => ({ projects: [{ id: 'project', name: 'project' }], tasks: [task],
      approvals: [], questions: [], channels: [], runner: { connected: true } }), feed: async () => [],
      remember: (_source: string, message: any) => remembered.push(message) }, FEED_PAGE: 1000 },
    './federation.ts': { ...federation, discoverSources: async () => {}, getSources: () => [], subscribeSources: () => () => {} },
    './posts.ts': { mergeEvents: (_a: any, b: any) => b }, './projects.ts': { assignProjectColors() {}, forgetProjectColors() {} },
    './feedCache.ts': {},
  }, { EventSource: class { onmessage: any; constructor() { streams.push(this); } close() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} });
  const render = () => h.render(() => module.useHub());
  await render().refresh();
  const latest = { ...task, status: 'waiting', updated_at: 'newer', pending_questions: 1 };
  streams[0].onmessage({ data: JSON.stringify({ type: 'task', task: latest }) });
  await new Promise(resolve => setTimeout(resolve, 70));
  render().updateTaskTitle('task', '바꾼 제목', 1);
  const updated = render().tasks.get('task');
  assert.equal(updated.title, '바꾼 제목');
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.pending_questions, 1);
  assert.equal(updated.updated_at, 'newer');
  assert.equal(remembered.at(-1).task.status, 'waiting');
  assert.equal(remembered.at(-1).task.title, '바꾼 제목');
  const otherHub = { ...latest, title: '기존 제목', title_revision: 2, updated_at: 'newest' };
  streams[0].onmessage({ data: JSON.stringify({ type: 'task', task: otherHub }) });
  await new Promise(resolve => setTimeout(resolve, 70));
  const cacheCount = remembered.length;
  render().updateTaskTitle('task', '바꾼 제목', 1);
  assert.equal(render().tasks.get('task').title, '기존 제목', 'the other hub restored the original title at revision 2');
  assert.equal(render().tasks.get('task').title_revision, 2);
  assert.equal(render().tasks.get('task').updated_at, 'newest');
  assert.equal(remembered.length, cacheCount, 'a stale response cannot replace the cached task');
  h.unmount();
});

test('different workspaces neither claim each other’s questions nor suppress background notifications', () => {
  const stored = new Map<string, string>();
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) };
  const tags: string[] = [], nativeIds: string[] = [];
  const window: any = { addEventListener() {} };
  const globals = { localStorage, window, document: { hasFocus: () => false }, Date,
    Notification: class { constructor(_title: string, options: { tag: string }) { tags.push(options.tag); } } };
  const make = (id: string) => load('notify.ts', { react: {}, './workspace.ts': workspace(id), '../../shared/protocol.ts': {} }, globals,
    '\nexport const review = { claim, deskInFront, deliver };').review;
  const local = make(''), shared = make('runner-a'), other = make('runner-b');
  assert.equal(local.claim('ask:42'), true);
  assert.equal(shared.claim('ask:42'), true);
  assert.equal(other.claim('ask:42'), true);
  assert.equal(shared.claim('ask:42'), false);
  stored.set('agent-desk.front', String(Date.now()));
  assert.equal(local.deskInFront(), true);
  assert.equal(shared.deskInFront(), false);
  stored.set('agent-desk.front.workspace.runner-a', String(Date.now()));
  assert.equal(shared.deskInFront(), true);
  assert.equal(other.deskInFront(), false);
  for (const item of [local, shared, other]) item.deliver({ id: 'ask:42', title: '', body: '' }, () => {});
  assert.equal(new Set(tags).size, 3);
  window.__TAURI__ = { core: { invoke: async (_cmd: string, args: { id: string }) => { nativeIds.push(args.id); } } };
  for (const item of [local, shared, other]) item.deliver({ id: 'ask:42', title: '', body: '' }, () => {});
  assert.equal(new Set(nativeIds).size, 3);
});

test('loading Vim keeps a focused draft intact and carries Escape into normal mode', async () => {
  const h = hooks();
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const VimInput = () => null;
  const native = { value: 'draft', selectionStart: 1, selectionEnd: 3 };
  const document = { activeElement: native as unknown };
  const { EditorInput } = load('EditorInput.tsx', {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    './editorMode.ts': { useEditorMode: () => 'vim' }, './VimInput.tsx': { VimInput },
    './editorIndent.ts': editorIndent, './emacsKeys.ts': emacsKeys,
  }, { document });
  const inputRef = { current: null };
  let edits = 0, exits = 0, sends = 0, blurs = 0;
  const render = () => h.render(() => EditorInput({
    inputRef, id: 'reply', rows: 2, value: native.value,
    onChange: () => { edits++; }, onKey: (e: KeyboardEvent) => { if (e.key === 'Enter') sends++; else exits++; },
  }));
  const textarea = render().props.children[0].props;
  assert.equal(textarea.readOnly, false);
  textarea.ref(native);
  assert.equal(inputRef.current, native);
  textarea.onChange({ target: { value: 'accidental edit', selectionStart: 2 } });
  assert.equal(edits, 1);
  textarea.onKeyDown({ key: 'Enter', metaKey: true, nativeEvent: { key: 'Enter', metaKey: true } });
  assert.equal(sends, 1);
  let blocked = 0;
  textarea.onKeyDown({
    key: 'Escape', nativeEvent: { isComposing: false },
    preventDefault() { blocked++; }, stopPropagation() { blocked++; },
  });
  assert.equal(blocked, 2);
  assert.equal(exits, 0);
  textarea.onKeyUp({ nativeEvent: { key: 'Escape', code: 'Escape', timeStamp: 1 } });
  const normal = render().props.children[0].props;
  assert.equal(normal.readOnly, true);
  normal.onChange({ target: { value: 'blocked', selectionStart: 2 } });
  assert.equal(edits, 1);
  normal.onKeyDown({ key: 'Escape', nativeEvent: { key: 'Escape' }, currentTarget: { blur() { blurs++; } },
    preventDefault() {}, stopPropagation() {} });
  assert.equal(blurs, 1);
  assert.equal(exits, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  const editor = render();
  assert.equal(editor.type, VimInput);
  assert.equal(editor.props.startInInsert, false);
  assert.equal(editor.props.value, 'draft');
  assert.equal(JSON.stringify(editor.props.handoff), JSON.stringify({ focused: true, start: 1, end: 3 }));
  document.activeElement = null;
  textarea.ref(null);
  assert.equal(editor.props.handoff.focused, false);
});

test('note forms keep IME Escape local and close once on the next plain Escape', () => {
  for (const name of ['NoteReply', 'NoteEditor']) {
    const h = hooks();
    const jsx = (type: unknown, props: unknown) => ({ type, props });
    const { [name]: component } = load('Note.tsx', {
      react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './api.ts': { api: {} },
      './Compose.tsx': { ResizableEditor: () => null },
      './drafts.ts': { getDraft: (key: string) => key.startsWith('reply:') ? { text: 'draft' } : undefined, setDraft() {}, useDraftSync() {} },
      './workspace.ts': {},
    });
    let closed = 0;
    const close = () => { closed++; };
    const form = h.render(() => component({
      task: { id: 'note' }, post: { event: { payload: { text: 'saved note' } } },
      inputRef: { current: null }, onEscape: close, onClose: close,
    }));
    for (const { composing, repeat, metaKey, expected } of [
      { composing: true, expected: 0 }, { metaKey: true, expected: 0 },
      { repeat: true, expected: 0 }, { expected: 1 },
    ]) {
      let prevented = false, stopped = false;
      form.props.onKeyDown({
        key: 'Escape', repeat, metaKey, nativeEvent: { isComposing: composing },
        preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
      });
      assert.equal(closed, expected, name);
      assert.equal(prevented, !composing && !metaKey, name);
      assert.equal(stopped, !composing && !metaKey, name);
    }
  }
});

test('native file drops remain local and explain why shared runner paths must be supplied separately', () => {
  for (const id of ['', 'runner-a']) {
    const h = hooks(), events: Record<string, (event: any) => void> = {};
    let inserted = '';
    const input = { selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} };
    const files = load('files.ts', { react: h.react, './api.ts': { api: {} }, './workspace.ts': workspace(id) }, {
      window: { addEventListener: (name: string, fn: (event: any) => void) => { events[name] = fn; } },
      document: { addEventListener() {}, querySelector: () => input, activeElement: input },
      requestAnimationFrame: (fn: () => void) => fn(),
    });
    const ref = { current: input };
    const render = () => h.render(() => files.useFileDrop(ref, '', (value: string) => { inserted = value; }, !!id));
    render(); events['desk-drop']({ detail: { paths: ['/local/report.txt'] } });
    const result = render();
    if (id) { assert.equal(inserted, ''); assert.match(result.error, /공유 러너에 먼저 옮긴 뒤 원격 경로/); }
    else { assert.equal(inserted, '`/local/report.txt` '); assert.equal(result.error, null); }
  }
});

test('a delayed file upload cannot insert into a different composer reusing the old ref', async () => {
  const h = hooks();
  let finish!: (value: { path: string }) => void;
  let inserted = false;
  const input = { selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {}, replaceRange() { inserted = true; } };
  const ref = { current: { ...input } };
  const files = load('files.ts', { react: h.react,
    './api.ts': { api: { upload: () => new Promise(resolve => { finish = resolve; }) } },
  }, {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, activeElement: null },
  });
  const upload = h.render(() => files.useFileDrop(ref, '첫 작업 초안', () => {})).upload([{ name: 'report.md' }]);
  h.unmount();
  ref.current = input;
  finish({ path: '/uploads/report.md' });
  await upload;
  assert.equal(inserted, false);
});

test('web drops prefer an address, fall back to a file, and explain unavailable addresses', async () => {
  for (const remote of [false, true]) {
    const h = hooks(), events: Record<string, (event: unknown) => void> = {};
    const uploaded: string[] = [];
    const photo = { name: 'photo.jpg' };
    let inserted = '';
    const input = { selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} };
    const files = load('files.ts', { react: h.react, './api.ts': { api: { upload: async (file: { name: string }) => {
      uploaded.push(file.name);
      return { path: '/uploads/photo.jpg' };
    } } } }, {
      URL,
      window: { addEventListener: (name: string, fn: (event: unknown) => void) => { events[name] = fn; } },
      document: {
        addEventListener() {}, querySelector: () => input, activeElement: input,
        createElement: (tag: string) => {
          assert.equal(tag, 'template');
          return { innerHTML: '', content: { querySelector: () => ({ getAttribute: () => 'https://example.invalid/photo.png' }) } };
        },
      },
      requestAnimationFrame: (fn: () => void) => fn(),
    });
    const ref = { current: input };
    const render = () => h.render(() => files.useFileDrop(ref, '', (value: string) => { inserted = value; }, remote));
    const drop = render();
    assert.equal(drop.fromWeb('# Source\nfile:///local/photo.png\nhttps://example.invalid/photo.jpg', null, [photo]), true);
    assert.equal(inserted, 'https://example.invalid/photo.jpg ');
    assert.deepEqual(uploaded, []);
    events['desk-drop']({ detail: { paths: [], html: '<img src="https://example.invalid/photo.png">', url: 'https://example.invalid/article' } });
    assert.equal(inserted, 'https://example.invalid/photo.png ');
    assert.equal(drop.fromWeb('data:image/png;base64,AA==', null), true);
    assert.match(render().error, /파일로 저장한 뒤 첨부하세요/);
    assert.equal(drop.fromWeb('https://name:password@example.invalid/image.png', null), true);
    assert.equal(inserted, 'https://example.invalid/photo.png ');
    assert.equal(drop.fromWeb('file:///local/photo.jpg', null, [photo]), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (remote) {
      assert.deepEqual(uploaded, []);
      assert.match(render().error, /공유 러너에 먼저 옮긴 뒤/);
    } else {
      assert.deepEqual(uploaded, ['photo.jpg']);
      assert.equal(inserted, '`/uploads/photo.jpg` ');
      assert.equal(render().error, null);
    }
  }
});

function findField(node: any): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type?.name === 'ComposeField') return node.props;
  for (const child of [node.props?.children].flat()) { const found = findField(child); if (found) return found; }
}

for (const pending of [false, true]) {
  for (const edit of ['none', 'same drawer', 'reopened drawer']) {
    test(`compose ${pending ? 'durable pending' : 'success'} preserves edits in ${edit}`, async () => {
      const h = hooks();
      const submitted = '@demo:/tmp/demo first instruction', revised = '@demo:/tmp/demo second instruction';
      let draft: string | undefined = submitted, sent = 0;
      let finish: (value: any) => void = () => {}, fail: (error: Error) => void = () => {};
      const response = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      class SharedPending extends Error {}
      const jsx = (type: any, props: any) => ({ type, props });
      const module = load('Compose.tsx', {
        react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {},
        '../../shared/compose.ts': compose, './api.ts': { api: { compose: () => response } }, './workspace.ts': { SharedPending },
        './drafts.ts': { getDraft: (key:string) => key==='drawer'?draft:undefined, setDraft: (key: string, value: string, options: { empty: boolean }) => { if(key==='drawer')draft = options.empty ? undefined : value; }, useDraftSync() {} },
        './files.ts': {}, './projects.ts': { rankProjects: () => [] }, './skills.ts': { useSkills: () => [] },
        './settings.ts': { useSettings: () => ({ claude: {}, codex: {}, agy: {} }) }, './Modal.tsx': {}, './queuedShortcut.ts': {},
      });
      const render = () => h.render(() => module.ComposeDrawer({ projects: [], tasks: [], inputRef: { current: null }, onClose() {}, onSent() { sent++; } }));
      let field = findField(render());
      const request = field.onSubmit();
      if (edit === 'same drawer') { field.onChange(revised); field = findField(render()); }
      if (edit === 'reopened drawer') { h.unmount(); draft = revised; }
      if (pending) fail(new SharedPending('보관됨')); else finish({ id: 'task-created' });
      await request;
      if (edit === 'none') { assert.equal(draft, undefined); assert.equal(sent, pending ? 0 : 1); }
      else { assert.equal(draft, revised); assert.equal(sent, 0); }
      if (edit === 'same drawer') assert.equal(findField(render()).value, revised);
    });
  }
}


test('a new shared project draft keeps its execution target after closing and reopening',async()=>{
 const saved=new Map<string,string>();const sent:{text:string;source:string}[]=[];
 const make=(sources=[{id:'shared-a',name:'srv19'}])=>{
   const h=hooks();const jsx=(type:any,props:any)=>({type,props});
   const module=load('Compose.tsx',{
     react:h.react,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{},'../../shared/compose.ts':compose,
     './Workspaces.tsx':{useSources:()=>sources},
     './api.ts':{api:{compose:async(text:string,source:string)=>{sent.push({text,source});return{id:'new'};}}},'./workspace.ts':{},
     './drafts.ts':{getDraft:(key:string)=>saved.get(key),setDraft:(key:string,value:string,opts:{empty:boolean})=>{if(opts.empty)saved.delete(key);else saved.set(key,value);},useDraftSync(){}},
     './files.ts':{},'./projects.ts':{rankProjects:()=>[]},'./skills.ts':{useSkills:()=>[]},'./settings.ts':{useSettings:()=>({claude:{},codex:{},agy:{}})},'./Modal.tsx':{},'./queuedShortcut.ts':{},
   });
   return {h,render:()=>h.render(()=>module.ComposeDrawer({projects:[],tasks:[],inputRef:{current:null},onClose(){},onSent(){}}))};
 };
 const find=(node:any):any=>node?.props?.['aria-label']==='새 지시의 실행 대상'?node:[node?.props?.children].flat().filter(Boolean).map(find).find(Boolean);
 const first=make();let tree=first.render();find(tree).props.onChange({target:{value:'shared-a'}});tree=first.render();findField(tree).onChange('@new:~/test-proj #claude do work');first.render();first.h.unmount();
 const reopened=make();tree=reopened.render();assert.equal(find(tree).props.value,'shared-a');await findField(tree).onSubmit();
 assert.deepEqual(sent,[{text:'@new:~/test-proj #claude do work',source:'shared-a'}]);reopened.h.unmount();
 const removed=make([]);tree=removed.render();assert.ok(find(tree));assert.equal(find(tree).props.value,'shared-a');find(tree).props.onChange({target:{value:'auto'}});assert.equal(find(removed.render()),undefined);removed.h.unmount();
});


test('approval and question SSE updates survive delayed workspace snapshots',async()=>{
 const h=hooks();const streams:any[]=[];let finish:(events:any[])=>void=()=>{};
 const feed=new Promise<any[]>(r=>{finish=r;});
 const request=(id:string,status:string)=>({id,task_id:'task',session_id:'session',status,created_at:'',text:'?',answer:null,answered_at:null,tool_name:'Bash',input:{}});
 const module=load('useHub.ts',{
   react:h.react,'./api.ts':{api:{state:async(progress:any)=>{const value={projects:[],tasks:[],approvals:[request('old','pending')],questions:[request('old','pending')],runner:{connected:true}};progress?.(value);await feed;return value;},feed:()=>{throw Error('global feed should not be fetched');},remember(){}},FEED_PAGE:1000},
   './federation.ts':{...federation,discoverSources:async()=>{},getSources:()=>[],subscribeSources:()=>()=>{}},
   './posts.ts':{mergeEvents:(_a:any,b:any)=>b},'./projects.ts':{assignProjectColors(){},forgetProjectColors(){}},'./feedCache.ts':{},
 },{
   EventSource:class {onopen:any;onmessage:any;constructor(){streams.push(this);}close(){}},
   setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},
 });
 h.render(()=>module.useHub());streams[0].onopen();await new Promise(r=>setTimeout(r,0));
 for(const [type,value] of [['approval',request('old','allowed')],['approval',request('new','pending')],['question',request('old','answered')],['question',request('new','pending')]] as const)streams[0].onmessage({data:JSON.stringify({type,[type]:value})});
 await new Promise(r=>setTimeout(r,65));let result=h.render(()=>module.useHub());assert.deepEqual([...result.approvals.keys()],['new']);assert.deepEqual([...result.questions.keys()],['new']);
 finish([]);await new Promise(r=>setTimeout(r,0));result=h.render(()=>module.useHub());assert.deepEqual([...result.approvals.keys()],['new']);assert.deepEqual([...result.questions.keys()],['new']);h.unmount();
});

test('an empty shared project deleted during a delayed workspace read does not reappear', async () => {
  const h = hooks(), streams: any[] = [];
  let finish: (events: any[]) => void = () => {};
  const feed = new Promise<any[]>(resolve => { finish = resolve; });
  const project = { id: federation.scopeId('shared-a', 'project'), name: 'shared-test' };
  const module = load('useHub.ts', {
    react: h.react,
    './api.ts': { api: { state: async (progress:any) => { const value={ projects: [project], tasks: [], approvals: [], questions: [] };progress?.(value);await feed;return value; }, feed: () => { throw Error('global feed should not be fetched'); }, remember() {} }, FEED_PAGE: 1000 },
    './federation.ts': { ...federation, discoverSources: async () => {}, getSources: () => [], subscribeSources: () => () => {} },
    './posts.ts': { mergeEvents: (_a: any, b: any) => b },
    './projects.ts': { assignProjectColors() {}, forgetProjectColors() {} }, './feedCache.ts': {},
  }, {
    EventSource: class { onopen: any; onmessage: any; constructor() { streams.push(this); } close() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  });
  try {
    h.render(() => module.useHub()); streams[0].onopen();
    await new Promise(resolve => setTimeout(resolve, 0));
    streams[0].onmessage({ data: JSON.stringify({ type: 'removed', taskIds: [], projectIds: [project.id] }) });
    await new Promise(resolve => setTimeout(resolve, 65));
    finish([]); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.render(() => module.useHub()).projects.length, 0);
    await h.render(() => module.useHub()).refresh();
    assert.equal(h.render(() => module.useHub()).projects.length, 0);
  } finally { h.unmount(); }
});

test('a project column receives the first event of a task created in the same SSE batch', async () => {
  const h = hooks(), streams: any[] = [];
  const batches: number[] = [];
  const project = { id: 'project', name: 'project' };
  const task = { id: 'new-task', project_id: project.id, title: 'new', status: 'running', title_revision: 0 };
  const event = { id: 13001, task_id: task.id, session_id: 'session', kind: 'user', ts: '2026-11-12T00:00:00Z', payload: { text: 'first' } };
  const defs = ['project-column', 'same-query'].map(id => ({ id, filter: { projectIds: [project.id] } }));
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      state: async () => ({ projects: [project], tasks: [], approvals: [], questions: [], channels: [] }),
      feed: async () => [], feedPage: async () => ({ events: [], complete: true }),
      feedCount: async () => ({ posts: 0, tasks: 0 }), remember() {},
    }, FEED_PAGE: 1000 },
    './federation.ts': { ...federation, discoverSources: async () => {}, getSources: () => [], subscribeSources: () => () => {} },
    './posts.ts': { ...posts, mergeEvents: (a: HubEvent[], b: HubEvent[], cap?: number) => {
      batches.push(b.length); return posts.mergeEvents(a, b, cap);
    } }, './projects.ts': { assignProjectColors() {}, forgetProjectColors() {} },
    './feedCache.ts': feedCache, './noteEvents.ts': noteEvents,
  }, { EventSource: class { onmessage: any; constructor() { streams.push(this); } close() {} },
    AbortController, window: { setTimeout }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} });
  const render = () => h.render(() => {
    const hub = module.useHub();
    const columns = module.useColumnFeeds(defs, () => defs, hub.tasks, hub.onEvent, hub.synced, hub.gone, hub.onEventBatch);
    return { hub, columns };
  });
  try {
    await render().hub.refresh();
    render();
    await Promise.resolve();
    batches.length = 0;
    streams[0].onmessage({ data: JSON.stringify({ type: 'event', event }) });
    const whole = { ...event, id: 13002, payload: { text: 'whole' } };
    streams[0].onmessage({ data: JSON.stringify({ type: 'event', event: { ...whole, payload: { text: 'cut', clipped: true } } }) });
    streams[0].onmessage({ data: JSON.stringify({ type: 'event', event: whole }) });
    streams[0].onmessage({ data: JSON.stringify({ type: 'task', task }) });
    await new Promise(resolve => setTimeout(resolve, 65));
    const result = render();
    assert.equal(result.hub.tasks.has(task.id), true);
    assert.equal(result.columns.feeds.get('project-column')?.events.map((e: any) => e.id).join(','), '13001,13002');
    assert.equal(result.columns.feeds.get('project-column')?.events[1].payload.text, 'whole');
    assert.deepEqual(batches, [3, 3], 'one global merge and one query merge, not one merge per event');
    assert.equal(result.columns.feeds.get('same-query'), result.columns.feeds.get('project-column'));
    const send = (message: unknown) => streams[0].onmessage({ data: JSON.stringify(message) });
    const note = { ...event, id: 13003, payload: { text: 'before', revision: 1 } };
    send({ type: 'event', event: note });
    send({ type: 'event_updated', event: { ...note, payload: { text: 'edited', revision: 2 } } });
    send({ type: 'event', event: { ...note, id: 13004 } });
    send({ type: 'event_removed', event_id: 13004, task_id: task.id });
    await new Promise(resolve => setTimeout(resolve, 65));
    const updated = render().columns.feeds.get('project-column').events;
    assert.equal(updated.find((e: any) => e.id === 13003)?.payload.text, 'edited');
    assert.equal(updated.some((e: any) => e.id === 13004), false);
    send({ type: 'event', event: { ...note, id: 13005 } });
    send({ type: 'removed', taskIds: [task.id], projectIds: [] });
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.equal(render().columns.feeds.get('project-column').events.length, 0);

  } finally { h.unmount(); }
});

test('an incomplete newest page preserves cached posts and retries until every source responds', async () => {
  const h = hooks();
  const events = [1, 2, 3].map(id => ({ id, task_id: 'task', session_id: 'session', kind: 'assistant',
    ts: `2026-11-12T00:00:0${id}Z`, payload: { text: String(id) } }));
  const pages = [
    { events: [events[0]], complete: true },
    { events: [events[1]], complete: false },
    { events: [events[1]], complete: false },
    { events, complete: true },
    { events: [], complete: false },
    { events, complete: true },
    { events: [], complete: false },
    { events, complete: true },
    { events: [], complete: false },
  ];
  let calls = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const setTimer = (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  const clearTimer = (id: number) => { timers.delete(id); };
  const defs: any[] = [{ id: 'column', filter: {} }];
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: { feed: async () => pages[calls++].events, feedPage: async () => pages[calls++],
      feedCount: async () => ({ posts: 3, tasks: 1 }) }, FEED_PAGE: 1000 },
    './federation.ts': federation, './posts.ts': posts, './feedCache.ts': feedCache,
    './projects.ts': {}, './draftRetention.ts': draftRetention,
  }, { AbortController, window: { setTimeout: setTimer }, setTimeout: setTimer, clearTimeout: clearTimer });
  let synced = 0;
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, new Map(), () => () => {}, synced));
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  try {
    render(); await settle();
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '1');
    synced = 1;
    render(); await settle();
    assert.equal(calls, 2);
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '1,2');
    assert.equal(render().feeds.get('column')?.loading, false);
    const retry = [...timers].find(([, timer]) => timer.ms >= 1000);
    assert.ok(retry, 'a failed source must schedule a bounded retry');
    assert.equal(retry[1].ms, 1000);
    timers.delete(retry[0]); retry[1].fn(); await settle();
    assert.equal(calls, 3);
    const secondRetry = [...timers].find(([, timer]) => timer.ms >= 1000);
    assert.equal(secondRetry?.[1].ms, 2000);
    timers.delete(secondRetry![0]); secondRetry![1].fn(); await settle();
    assert.equal(calls, 4);
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '1,2,3');
    assert.equal([...timers.values()].filter(timer => timer.ms >= 1000).length, 0);
    synced = 2;
    render(); await settle();
    const staleRetry = [...timers].find(([, timer]) => timer.ms >= 1000);
    assert.ok(staleRetry);
    synced = 3;
    render(); await settle();
    assert.equal(timers.has(staleRetry[0]), false, 'a new sync cancels the old retry');
    synced = 4;
    render(); await settle();
    const oldQueryRetry = [...timers].find(([, timer]) => timer.ms >= 1000);
    assert.ok(oldQueryRetry);
    defs[0] = { id: 'column', filter: { projectIds: ['other'] } };
    render(); await settle();
    assert.equal(timers.has(oldQueryRetry[0]), false, 'a query change cancels the old retry');
    synced = 5;
    render(); await settle();
    assert.ok([...timers.values()].some(timer => timer.ms >= 1000));
  } finally { h.unmount(); }
  assert.equal(timers.size, 0, 'unmount cancels every remaining timer');
});

test('a recovered full newest page paginates the gap before an older cached post', async () => {
  const h = hooks();
  const event = (id: number) => ({ id, task_id: 'task', session_id: 'session', kind: 'assistant',
    ts: String(id).padStart(4, '0'), payload: { text: String(id) } });
  const localOld = event(1);
  const newest = Array.from({ length: 1000 }, (_, i) => event(i + 1001));
  const middle = Array.from({ length: 100 }, (_, i) => event(i + 901));
  const pages = [{ events: [localOld], complete: false }, { events: newest, complete: true }];
  const cursors: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const setTimer = (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; };
  const clearTimer = (id: number) => { timers.delete(id); };
  const defs = [{ id: 'column', filter: {} }];
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      feedPage: async () => pages.shift(),
      feed: async (_limit: number, before: any) => { cursors.push(before.id); return middle; },
      feedCount: async () => ({ posts: 1101, tasks: 1 }),
    }, FEED_PAGE: 1000 },
    './federation.ts': federation, './posts.ts': posts, './feedCache.ts': feedCache,
    './projects.ts': {}, './draftRetention.ts': draftRetention,
  }, { AbortController, window: { setTimeout: setTimer }, setTimeout: setTimer, clearTimeout: clearTimer });
  let synced = 0;
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, new Map(), () => () => {}, synced));
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  try {
    render(); await settle();
    synced = 1;
    render(); await settle();
    let column = render().feeds.get('column');
    assert.equal(column?.events.length, 1001);
    assert.equal(column?.more, true, 'a full newest page still has earlier posts despite an older cached post');
    render().loadEarlier('column'); await settle();
    column = render().feeds.get('column');
    assert.equal(cursors.join(','), '1001', 'pagination must start at the recovered page, not the old local post');
    assert.equal(column?.events.length, 1101);
    assert.equal(column?.events[0].id, 1, 'the old cached post remains visible');
    assert.equal(column?.events.some((e: any) => e.id === 901), true, 'the missing middle was fetched');
    assert.equal(column?.more, false);
  } finally { h.unmount(); }
});

test('reconnecting keeps valid older notes and removes deleted or newly unmatched notes', async () => {
  const h = hooks();
  const make = (id: number): HubEvent => ({ id, task_id: 'notes', session_id: 'session', kind: 'user',
    ts: String(id), payload: { text: 'needle', revision: 0 } });
  const [deleted, unmatched, kept] = [12001, 12002, 12003].map(make);
  const changed = { ...kept, payload: { text: 'needle changed while offline', revision: 1 } };
  const newest = Array.from({ length: 200 }, (_, i): HubEvent => ({ ...make(12004 + i), task_id: 'work', kind: 'assistant' }));
  const rechecked: number[][] = [];
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      feedPage: async () => ({ events: newest, complete: true }),
      feed: async () => [deleted, unmatched, kept],
      events: async (_task: string, { ids }: { ids: number[] }) => {
        rechecked.push(ids);
        return { events: [{ ...unmatched, payload: { text: 'other text', revision: 1 } }, changed], more: false };
      },
      feedCount: async () => ({ posts: 203, tasks: 2 }),
    }, FEED_PAGE: 1000 },
    './posts.ts': posts, './feedCache.ts': feedCache, './projects.ts': {},
  }, { AbortController, window: { setTimeout: () => 1 }, setTimeout: () => 1, clearTimeout() {} });
  const defs = [{ id: 'search', filter: { query: 'needle' } }];
  const tasks = new Map([['notes', { title: 'Memo' }]]);
  const onEvent = () => () => {};
  let synced = 0;
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, tasks, onEvent, synced));
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  try {
    render(); await settle();
    render().loadEarlier('search'); await settle();
    assert.equal(render().feeds.get('search').events.length, 203);
    synced++;
    render(); await settle();
    assert.equal(rechecked.map(ids => ids.join(',')).join('/'), '12001,12002,12003');
    const recovered = render().feeds.get('search').events;
    assert.equal(recovered.length, 201);
    assert.equal(recovered[0], changed);
    noteEvents.reportNoteChange({ type: 'event_updated', event: { ...kept, payload: { text: 'live nonmatch', revision: 2 } } });
    assert.equal(render().feeds.get('search').events.length, 200);
  } finally { h.unmount(); }
});

test('pagination resumes at the oldest retained post after live compaction', async () => {
  const h = hooks(), listeners = new Set<(e: any) => void>();
  const event = (id: number) => ({ id, task_id: 'task', session_id: 'session', kind: 'assistant',
    ts: String(id).padStart(4, '0'), payload: { text: String(id) } });
  const cursors: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const setTimer = (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; };
  const clearTimer = (id: number) => { timers.delete(id); };
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      feedPage: async () => ({ events: [event(1), event(2)], complete: true }),
      feed: async (_limit: number, before: any) => { cursors.push(before.id); return [event(1)]; },
      feedCount: async () => ({ posts: 4, tasks: 1 }),
    }, FEED_PAGE: 2 },
    './federation.ts': federation, './posts.ts': posts, './feedCache.ts': { ...feedCache, LIVE_FEED_LIMIT: 3 },
    './projects.ts': {}, './draftRetention.ts': draftRetention,
  }, { AbortController, window: { setTimeout: setTimer }, setTimeout: setTimer, clearTimeout: clearTimer });
  const defs = [{ id: 'column', filter: {} }];
  const onEvent = (fn: (e: any) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, new Map(), () => () => {}, 0, new Set(), onEvent));
  try {
    render(); await Promise.resolve(); await Promise.resolve();
    for (const listener of listeners) listener([3, 4].map(id => ({ event: event(id) })));
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '2,3,4');
    render().loadEarlier('column');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cursors.join(','), '2', 'the evicted first page must be fetched again');
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '1,2,3,4');
  } finally { h.unmount(); }
});

test('a reconnect refreshes only its workspace and leaves the other workspaces available', async () => {
  const h=hooks(),streams:any[]=[],reads:{scope?:string;progress:(s:any)=>void;finish:(s:any)=>void}[]=[];
  const retries: (() => void)[] = [];
  const sources=[{id:'a'},{id:'b'}];
  const value={projects:[{id:'project'}],tasks:[{id:'local-task',project_id:'project'},{id:'w:a:task',project_id:'project'}],approvals:[],questions:[],availableSources:[''],unavailableSources:[]};
  const module=load('useHub.ts',{
    react:h.react,'./api.ts':{api:{state:(progress:any,scope?:string)=>new Promise(resolve=>reads.push({scope,progress,finish:resolve})),
      feed:()=>{throw Error('columns own feed requests');},remember(){}},FEED_PAGE:1000},
    './federation.ts':{...federation,discoverSources:async()=>{},getSources:()=>sources,subscribeSources:()=>()=>{},sourceConnected(){}},
    './posts.ts':posts,'./projects.ts':{assignProjectColors(){},forgetProjectColors(){}},'./feedCache.ts':{},
  },{EventSource:class{onopen:any;constructor(){streams.push(this);}close(){}},
    setTimeout:(fn:()=>void,ms:number) => ms === 1000 ? retries.push(fn) : setTimeout(fn,ms),
    clearTimeout,setInterval:()=>0,clearInterval(){}});
  const render=()=>h.render(()=>module.useHub());
  try {
    render();streams[0].onopen();
    reads[0].progress(value);
    assert.ok(render().tasks.has('local-task'),'the remote state is still pending');
    const other={id:'w:b:other',project_id:'w:b:p',title:'유지'};
    reads[0].finish({...value,tasks:[...value.tasks,other],availableSources:['','a','b']});
    await new Promise(r=>setTimeout(r,0));
    streams[1].onopen();
    assert.equal(reads.length,2);
    assert.equal(reads[1].scope,'a');
    reads[1].finish({...value,projects:[],tasks:[],availableSources:[],unavailableSources:['a']});
    await new Promise(r=>setTimeout(r,0));
    assert.equal(render().sourceSynced.size,0,'recover missed events only after the source is readable');
    assert.equal(retries.length,1);
    retries[0]();
    assert.equal(reads[2].scope,'a');
    reads[2].finish({...value,projects:[],tasks:[],availableSources:['a']});
    await new Promise(r=>setTimeout(r,0));
    const result=render();
    assert.equal(result.synced,1);
    assert.equal(result.sourceSynced.size,1);
    assert.equal(result.sourceSynced.get('a'),1);
    assert.equal(result.tasks.get(other.id),other);
    assert.equal(result.tasks.has('local-task'),true);
    assert.equal(result.tasks.has('w:a:task'),false);
    assert.deepEqual([...result.availableSources].sort(),['','a','b']);
  }finally{h.unmount();}
});

test('partial column pages remain visible and do not move the paging cursor before completion', async () => {
  const h=hooks();const requests:any[]=[],older:any[]=[];
  const event=(id:number)=>({id,task_id:'t',session_id:'s',ts:String(id).padStart(4,'0'),kind:'assistant',payload:{text:String(id)}});
  const defs:any[]=[{id:'column',filter:{}}];
  const module=load('useHub.ts',{
    react:h.react,'./api.ts':{api:{
      feedPage:(limit:number,_before:any,_q:any,signal:AbortSignal,progress:any)=>new Promise(resolve=>requests.push({limit,signal,progress,finish:resolve})),
      feed:async(limit:number,before:any)=>{older.push({limit,before});return[event(0)];},feedCount:async()=>({posts:500,tasks:1})},FEED_PAGE:1000},
    './posts.ts':posts,'./feedCache.ts':feedCache,'./projects.ts':{},
  },{AbortController,window:{setTimeout:()=>0},setTimeout:()=>0,clearTimeout(){}});
  const render=()=>h.render(()=>module.useColumnFeeds(defs,()=>defs,new Map(),()=>()=>{},0));
  try {
    render();assert.equal(requests[0].limit,200,'initial pages have a smaller transfer budget');
    requests[0].progress({events:[event(150)],complete:false});
    const partial=render();assert.equal(partial.feeds.get('column').events[0].id,150);
    assert.equal(partial.feeds.get('column').loading,true);
    partial.loadEarlier('column');assert.equal(older.length,0);
    defs.push({id:'other',filter:{projectIds:['other']}});render();
    assert.equal(requests[0].signal.aborted,false,'another workspace arriving must not restart this read');
    requests[0].finish({events:Array.from({length:200},(_,i)=>event(i+1)),complete:true});
    await new Promise(r=>setTimeout(r,0));
    const complete=render();assert.equal(complete.feeds.get('column').more,true);
    complete.loadEarlier('column');await new Promise(r=>setTimeout(r,0));
    assert.equal(older[0].before.id,1);
    assert.equal(render().feeds.get('column').events[0].id,0);
    h.unmount();requests[1].progress({events:[event(999)],complete:false});
    assert.equal(requests[1].signal.aborted,true);
    requests[1].finish({events:[],complete:true});await new Promise(r=>setTimeout(r,0));
  }finally{h.unmount();}
});

test('scoped feed recovery covers the gap even when a newer live event has already arrived', async () => {
  const h = hooks();
  const event = (id: number) => ({ id, task_id: 'w:a:t', session_id: 'w:a:s', ts: String(id).padStart(4, '0'), kind: 'assistant', payload: {} });
  const page = (first: number, length: number) => Array.from({ length }, (_, i) => event(first + i));
  const calls: Array<{ scope?: string; before?: number }> = [];
  let receive: (event: ReturnType<typeof page>[number]) => void = () => {};
  const onEvent = (fn: typeof receive) => { receive = fn; return () => {}; };
  const defs = [{ id: 'column', filter: {} }];
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      feedPage: async (_limit: number, before: { id: number } | undefined, _q: unknown, _signal: AbortSignal, _progress: unknown, scope?: string) => {
        calls.push({ scope, before: before?.id });
        return { complete: true, events: !scope ? [event(1)] : before ? page(1, 2) : page(3, 200) };
      }, feedCount: async () => ({ posts: 0, tasks: 0 }),
    }, FEED_PAGE: 1000 }, './posts.ts': posts, './feedCache.ts': feedCache, './federation.ts': federation, './projects.ts': {},
  }, { AbortController, window: { setTimeout: () => 0 }, setTimeout, clearTimeout });
  let epochs = new Map<string, number>();
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, new Map(), onEvent, 0, new Set(), undefined, epochs));
  try {
    render();
    await new Promise(resolve => setTimeout(resolve, 0));
    receive(event(203));
    epochs = new Map([['a', 1]]);
    render();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ scope: undefined, before: undefined }, { scope: 'a', before: undefined }, { scope: 'a', before: 3 }]);
    assert.equal(render().feeds.get('column').events.length, 203);
  } finally { h.unmount(); }
});

test('SSE connects after a snapshot starts always recovers changes missed before connection', async()=> {
 const h=hooks(), streams:any[]=[], reads:any[]=[];
 const source={id:'a',view_index:1};
 const stale={projects:[{id:'w:a:p'}],tasks:[{id:'w:a:t',project_id:'w:a:p',status:'running',queued:[{id:'old-queue'}]}],approvals:[],questions:[],availableSources:['','a'],unavailableSources:[]};
 const module=load('useHub.ts', {
  react:h.react,'./api.ts':{api:{state:(progress:any)=>new Promise(resolve=>reads.push({progress,finish:resolve})),remember(){}},FEED_PAGE:1000},
  './federation.ts':{...federation,discoverSources:async()=>{},getSources:()=>[source],subscribeSources:()=>()=>{},sourceConnected(){}},
  './posts.ts':posts,'./projects.ts':{assignProjectColors(){},forgetProjectColors(){}},'./feedCache.ts':{},
 }, {EventSource:class{onopen:any;onerror:any;constructor(){streams.push(this);}close(){}},setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){}});
 const render=()=>h.render(()=>module.useHub());
 try {
  render(); streams[0].onopen(); streams[1].onopen();
  // The server has already produced stale, but response delivery remains pending.
  // The remote SSE disconnects; task finishes/queue drains while disconnected.
  streams[1].onerror(); streams[1].onopen();
  reads[0].finish(stale); await new Promise(r=>setTimeout(r,0));
  assert.equal(reads.length,2,'late connections coalesce into one mandatory catch-up');
  assert.equal(render().tasks.get('w:a:t').status,'running');
  assert.equal(render().tasks.get('w:a:t').queued[0].id,'old-queue');
  reads[1].finish({...stale,tasks:[{...stale.tasks[0],status:'done',queued:[]}]});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(render().tasks.get('w:a:t').status,'done');
  assert.equal(render().tasks.get('w:a:t').queued.length,0);
 } finally { h.unmount(); }
});


test('editing a durably pending queue deletion preserves text and drafts after leaving the thread', async()=>{
 const h=hooks();let draft:any={text:'existing draft',pick:null};let reject!:(e:Error)=>void;
 class SharedPending extends Error {}
 const jsx=(type:any,props:any)=>({type,props});
 const module=load('Compose.tsx',{
  react:{...h.react,Fragment:'fragment'},'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{},
  '../../shared/compose.ts':compose,'./api.ts':{api:{cancelQueued:()=>new Promise((_resolve,r)=>{reject=r;})}},
  './workspace.ts':{SharedPending},'./drafts.ts':{getDraft:()=>draft,setDraft:(_key:string,value:any)=>{draft=value;},useDraftSync(){}},
  './files.ts':{},'./projects.ts':{},'./settings.ts':{},'./skills.ts':{useSkills:()=>[]},'./Modal.tsx':{},
  './queuedShortcut.ts':{QueuedShortcut:class{reset(){}}},
 },{requestAnimationFrame(){}});
 const task={id:'task',engine:'claude',status:'running',queued:[{id:'q',text:'queued original'}]};
 const render=()=>h.render(()=>module.ReplyBox({task,projects:[],tasks:[],inputRef:{current:null},onError(){}}));
 const find=(node:any):any=>{
  if(!node||typeof node!=='object')return;
  if(node.props?.title==='대기열에서 빼서 입력창에서 고치기')return node;
  for(const child of [node.props?.children].flat(Infinity)){const result=find(child);if(result)return result;}
 };
 try {
  find(render()).props.onClick();
  assert.equal(draft.text,'queued original\nexisting draft','original is saved before DELETE responds');
  draft={text:draft.text+'\nnewer draft',pick:'now'};h.unmount();
  reject(new SharedPending());await new Promise(r=>setTimeout(r,0));
  assert.equal(draft.text,'queued original\nexisting draft\nnewer draft');assert.equal(draft.pick,'now');
 } finally {h.unmount();}
});


test('dynamic model autocomplete and compose preview share the checked Fable reference',()=>{
  const jsx=(type:any,props:any)=>({type,props});
  const module=load('Compose.tsx',{
    react:hooks().react,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{},'../../shared/compose.ts':compose,
    './api.ts':{},'./workspace.ts':{},'./drafts.ts':{},'./files.ts':{},'./projects.ts':{},'./skills.ts':{},'./settings.ts':{},'./Modal.tsx':{},'./queuedShortcut.ts':{},
  },{},'\nexport {suggest,interpretNew};');
  const catalog={engine:'claude' as const,checkedAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',
    models:[{id:'claude-fable-5-1[1m]',resolvedId:'claude-fable-5-1',label:'Fable',efforts:['high' as const,'max' as const]}]};
  const runners=[{runnerId:'local-test',label:'local',connected:true,catalogs:{claude:catalog}}];
  const tags=modelCatalog.catalogModelTags(runners.map(r=>r.catalogs));
  const suggestions=module.suggest('#fa',3,[],[],'route',[],tags);
  assert.ok(suggestions.items.some((item:any)=>item.insert==='fable'));
  const settings={claude:{model:null,effort:null},codex:{model:null,effort:null},agy:{model:null,effort:null}};
  const preview=module.interpretNew('@demo:/tmp/demo #fable 검토',[],[],[],settings,runners);
  assert.equal(preview.ok,true);
  assert.ok(preview.rows.some((row:any)=>row.label==='모델'&&row.value.includes('claude-fable-5-1[1m]')));
  assert.ok(preview.rows.some((row:any)=>row.label==='할 일'&&row.value==='검토'));
});

test('existing model dialog selects actual models and supported effort while retaining a disappeared selection',async()=>{
  const h=hooks(),jsx=(type:any,props:any)=>({type,props});
  let runners:any[]=[{runnerId:'local-test',label:'local',connected:true,catalogs:{
    claude:{engine:'claude',checkedAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',models:[{id:'claude-fable-5-1[1m]',resolvedId:'claude-fable-5-1',label:'Fable',efforts:['low','medium','high','xhigh','max']}]},
    agy:{engine:'agy',checkedAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z',models:[{id:'gemini-4-hydrogen-xhigh',label:'Hydrogen XHigh',efforts:['xhigh']}]},
  }}];
  const saved:any[]=[];
  const settings={claude:{model:null,effort:'high'},codex:{model:null,effort:null},agy:{model:null,effort:'high'}};
  const module=load('ModelDialog.tsx',{
    react:h.react,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{},'../../shared/compose.ts':compose,
    './modelCatalogs.ts':{useModelCatalogs:()=>({runners,loading:false,error:'',refresh(){}})},
    './workspace.ts':{workspaceId:''},'./settingsPanel.tsx':{SettingsEditor:'SettingsEditor',useSettingsPanel:()=>({active:false,embedded:true})},
    './settings.ts':{saveSettings:async(value:any)=>{saved.push(value);}},'./format.ts':{},'./model-dialog.css':{},
    '../../shared/runner-usage.ts':runnerUsage,
  },{AbortController,AbortSignal,fetch:async()=>({ok:true,json:async()=>settings})});
  const render=()=>h.render(()=>module.ModelDialog({onClose(){}}));
  const all=(node:any,match:(node:any)=>boolean):any[]=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(child=>all(child,match)):[...(match(node)?[node]:[]),...all(node.props?.children,match)];
  render();await new Promise(resolve=>setImmediate(resolve));
  let tree=render();
  const select=(name:string)=>all(tree,node=>node.type==='select'&&node.props['aria-label']===name)[0];
  const fable=compose.catalogModelName('claude','claude-fable-5-1[1m]');
  assert.ok(all(select('Claude 기본 모델'),node=>node.type==='option').some(node=>node.props.value===fable));
  select('Claude 기본 모델').props.onChange({target:{value:fable}});tree=render();
  const hydrogen=compose.catalogModelName('agy','gemini-4-hydrogen-xhigh');
  select('Antigravity 기본 모델').props.onChange({target:{value:hydrogen}});tree=render();
  const effort=all(tree,node=>node.props?.role==='radiogroup'&&node.props['aria-label']==='Antigravity effort')[0];
  assert.deepEqual(all(effort,node=>node.type==='input').map(node=>node.props.value),['','xhigh']);
  assert.equal(all(effort,node=>node.type==='input'&&node.props.value==='')[0].props.checked,true,'changing a variant clears an incompatible old effort');
  runners=[{...runners[0],catalogs:{...runners[0].catalogs,claude:{...runners[0].catalogs.claude,models:[],error:'offline'}}}];
  tree=render();
  assert.equal(select('Claude 기본 모델').props.value,fable);
  assert.ok(all(select('Claude 기본 모델'),node=>node.type==='option').some(node=>node.props.value===fable&&node.props.disabled));
  const form=all(tree,node=>node.type==='form')[0];await form.props.onSubmit({preventDefault(){}});
  assert.equal(saved[0].claude.model,fable);assert.equal(saved[0].agy.model,hydrogen);
  h.unmount();
});

test('model usage switches runners without letting the former response overwrite the selected runner', async () => {
  const h = hooks();
  const jsx = (type: any, props: any) => ({ type, props });
  const settings = Object.fromEntries(compose.ENGINES.map(engine => [engine, { model: null, effort: null }]));
  const local = { id: 'local', label: '이 Mac' };
  const remote = { id: 'default', label: 'srv19', source: 'shared-source' };
  const requests: { params: URLSearchParams; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const module = load('ModelDialog.tsx', {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../../shared/compose.ts': compose,
    './settingsPanel.tsx': { SettingsEditor: 'SettingsEditor', useSettingsPanel: () => ({ active: true, embedded: true }) },
    './settings.ts': {}, './format.ts': {}, './model-dialog.css': {}, '../../shared/runner-usage.ts': runnerUsage,
  }, {
    AbortController, AbortSignal, URLSearchParams,
    fetch: (path: string, { signal }: { signal: AbortSignal }) => {
      if (path === '/api/settings') return Promise.resolve(Response.json(settings));
      if (path === '/api/runner-usage') return Promise.resolve(Response.json([local, remote]));
      const { searchParams } = new URL(path, 'http://desk');
      return new Promise<Response>(resolve => requests.push({ params: searchParams, signal, resolve }));
    },
  });
  const render = () => h.render(() => module.ModelDialog({ onClose() {} }));
  function find(node: any, matches: (node: any) => boolean): any {
    if (!node || typeof node !== 'object') return;
    if (matches(node)) return node;
    const children = Array.isArray(node) ? node : [node.props?.children];
    for (const child of children) {
      const hit = find(child, matches);
      if (hit) return hit;
    }
  }
  render();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  const selector = find(tree, node => node.type === 'select' && node.props.value === '/local');
  assert.ok(selector);
  assert.equal(requests.length, 3);
  selector.props.onChange({ target: { value: 'shared-source/default' } });
  tree = render();
  assert.ok(requests.slice(0, 3).every(request => request.signal.aborted));
  assert.ok(requests.slice(3).every(request => request.params.get('source') === remote.source));
  assert.equal(requests.length, 6);
  const reply = (request: typeof requests[number], usedPercent: number, status: string) => request.resolve(Response.json({
    status, value: { engine: request.params.get('engine'), plan: null, fetchedAt: '2026-11-19T03:00:00Z',
      windows: [{ label: '5시간', usedPercent, resetsAt: null }] },
  }));
  requests.slice(3).forEach(request => reply(request, 60, 'offline'));
  requests.slice(0, 3).forEach(request => reply(request, 9, 'ready'));
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  const row = find(tree, node => node.type?.name === 'UsageRows' && node.props.reading?.value?.engine === 'codex');
  assert.equal(row.props.reading.status, 'offline');
  assert.equal(row.props.reading.value.windows[0].usedPercent, 60);
  h.unmount();
});


for (const remoteAt of ['1900-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z']) test(`manual model refresh compares changed snapshots across remote clock skew ${remoteAt.slice(0,4)}`,async()=>{
  const h=hooks();let now=Date.parse('2026-11-17T00:00:00Z'),poll=()=>{};
  const calls:boolean[]=[];
  const make=(checkedAt:string)=>[{runnerId:'remote-clock',label:'remote',connected:true,supported:true,catalogs:Object.fromEntries(['claude','codex','agy'].map(engine=>[engine,{engine,checkedAt,updatedAt:checkedAt,models:[{id:'fixture-model',label:'fixture',efforts:null}]}]))}];
  let response=make(remoteAt);
  const module=load('modelCatalogs.ts',{
    react:h.react,'./api.ts':{api:{modelCatalogs:async(_source:string,force:boolean)=>{calls.push(force);return response;}}},
  },{Date:{now:()=>now},AbortSignal:{timeout:()=>new AbortController().signal},setInterval:(callback:()=>void)=>{poll=callback;return 1;},clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
  const render=()=>h.render(()=>module.useModelCatalogs());
  render();await new Promise(resolve=>setImmediate(resolve));let state=render();assert.equal(state.loading,false);
  now+=1000;state.refresh();await new Promise(resolve=>setImmediate(resolve));state=render();
  assert.equal(state.loading,true,'an unchanged snapshot cannot complete a refresh even if its remote clock is in the future');
  response=make(new Date(Date.parse(remoteAt)+1000).toISOString());now+=2001;poll();await new Promise(resolve=>setImmediate(resolve));state=render();
  assert.equal(state.loading,false,'a changed snapshot completes even if its timestamp is behind the browser clock');
  assert.deepEqual(calls,[false,true,false]);h.unmount();
});


test('grouped history stays readable with bounded SSE and releases on same-query ungrouping', async () => {
  const h = hooks();
  const event = (id: number) => ({id, task_id: `task-${Math.floor(id / 1000)}`, session_id:'s', kind:'assistant',
    ts: String(id).padStart(8, '0'), payload:{text:String(id)}});
  const timers = new Map<number, () => void>();
  let timer = 0, receive: (batch: any[]) => void = () => {}, reads = 0;
  const setTimer = (fn: () => void) => {timers.set(++timer, fn); return timer;};
  const defs: any[] = [{id:'column', filter:{}, byTask:true}];
  const module = load('useHub.ts', {
    react:h.react, './api.ts':{api:{
      feedPage:async()=>({events:Array.from({length:200}, (_,i)=>event(11801+i)),complete:true}),
      feed:async()=>{ reads++; return Array.from({length:11800}, (_,i)=>event(i+1)); },
      feedCount:async()=>({posts:60000,tasks:60}),
    }, FEED_PAGE:1000},
    './federation.ts':federation, './posts.ts':posts, './feedCache.ts':feedCache,
    './projects.ts':{}, './draftRetention.ts':draftRetention,
  }, {AbortController, window:{setTimeout:setTimer},setTimeout:setTimer,clearTimeout:(id:number)=>timers.delete(id)});
  const subscribe = (fn: (batch:any[])=>void) => {receive=fn; return ()=>{};};
  const render = () => h.render(()=>module.useColumnFeeds(defs,()=>defs,new Map(),()=>()=>{},0,new Set(),subscribe));
  const settle = async () => {await Promise.resolve();await Promise.resolve();};
  try {
    render(); await settle();
    render().loadEarlier('column'); await settle();
    assert.equal(render().feeds.get('column').events.length,12000);
    render().setReading('column',true);
    render().setReading('column',false);
    for(let batch=0;batch<3;batch++) {
      receive(Array.from({length:12000},(_,i)=>({event:event(12001+batch*12000+i)})));
      const result=render();
      assert.equal(result.feeds.get('column').events.length,15000);
      assert.equal(result.feeds.get('column').events[0].id,1);
      result.setReading('column',true); result.setReading('column',false);
      assert.equal(reads,1,'revisiting retained cards does not refetch history');
    }
    defs[0]={...defs[0],byTask:false}; render();
    assert.equal(render().feeds.get('column').events.length,3000,'same ID and filter must not preserve grouping protection');
    receive(Array.from({length:12000},(_,i)=>({event:event(48001+i)})));
    assert.equal(render().feeds.get('column').events.length,3000);
    assert.equal(reads,1);
  } finally {h.unmount();}
});

for (const edited of [false, true]) test(`retained middle gaps recover through real API cursors (edited=${edited})`, async () => {
  const {api, FEED_PAGE} = await import('../../web/src/api.ts');
  const originalFetch = globalThis.fetch;
  const h = hooks();
  const event = (id:number): any => ({id,task_id:id===500?'gap-only':'task',session_id:'s',kind:'assistant',
    ts:String(id).padStart(8,'0'),payload:{text:String(id)}});
  const make = (id:number) => edited && id===1301 ? {...event(50),edited_at:'00001301'} : event(id);
  let data = Array.from({length:200},(_,i)=>make(i+101));
  const requests: {id:number;ts:string}[]=[];
  let fail=false, receive:(batch:any[])=>void=()=>{};
  const timers=new Map<number,()=>void>();let timer=0;
  const setTimer=(fn:()=>void)=>{timers.set(++timer,fn);return timer;};
  globalThis.fetch=async input=>{
    const url=new URL(String(input),'http://desk');
    if(url.pathname==='/api/workspaces') return Response.json([]);
    if(url.pathname==='/api/feed/count') return Response.json({posts:data.length,tasks:2});
    assert.equal(url.pathname,'/api/feed');
    const id=Number(url.searchParams.get('cursor_id')),ts=url.searchParams.get('before_ts')!;
    if(id!==Number.MAX_SAFE_INTEGER) requests.push({id,ts});
    if(fail && id!==Number.MAX_SAFE_INTEGER) {fail=false;return new Response('{}',{status:503});}
    assert.equal(url.searchParams.get('edited_order'),'1');
    const before={id,ts};
    return Response.json(data.filter(e=>federation.compareEvents(e,before)<0)
      .sort(federation.compareEvents).slice(-Number(url.searchParams.get('limit'))));
  };
  const defs=[{id:'column',filter:{},byTask:true}];
  const module=load('useHub.ts',{
    react:h.react,'./api.ts':{api,FEED_PAGE},'./federation.ts':federation,'./posts.ts':posts,'./feedCache.ts':feedCache,
    './projects.ts':{},'./draftRetention.ts':draftRetention,
  },{AbortController,window:{setTimeout:setTimer},setTimeout:setTimer,clearTimeout:(id:number)=>timers.delete(id)});
  const subscribe=(fn:(batch:any[])=>void)=>{receive=fn;return()=>{};};
  const render=()=>h.render(()=>module.useColumnFeeds(defs,()=>defs,new Map(),()=>()=>{},0,new Set(),subscribe));
  const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  try {
    await federation.discoverSources(true);
    render();await settle();render().loadEarlier('column');await settle();
    assert.equal(render().feeds.get('column').events.length,200);
    data=Array.from({length:4200},(_,i)=>make(i+101));
    receive(data.filter(e=>Number(e.edited_at??e.ts)>300).map(event=>({event})));
    let feed=render().feeds.get('column');
    assert.equal(feed.events.length,3200);
    assert.equal(feed.events.some((e:any)=>e.task_id==='gap-only'),false);
    assert.equal(feedCache.feedCursor(feed)!.id,edited?50:1301);
    fail=true;render().loadEarlier('column');await settle();
    assert.equal(feedCache.feedCursor(render().feeds.get('column'))!.id,edited?50:1301,'failed response preserves recovery cursor');
    for(let i=0;i<5 && render().feeds.get('column').more;i++) {render().loadEarlier('column');await settle();}
    feed=render().feeds.get('column');
    assert.equal(feed.more,false);
    assert.ok(feed.events.some((e:any)=>e.task_id==='gap-only'),'unique task inside evicted range is reachable');
    assert.equal(feed.events.length,4200);
    assert.equal(new Set(feed.events.map((e:any)=>e.id)).size,4200);
    assert.deepEqual(requests.map(r=>r.id),[101,edited?50:1301,edited?50:1301,301]);
    assert.equal(requests[1].ts,'00001301','edited_at is the exclusive boundary, not original ts');
    render().loadEarlier('column');await settle();assert.equal(requests.length,4,'exhaustion cannot repeat the cursor chain');
  } finally {h.unmount();globalThis.fetch=originalFetch;}
});
