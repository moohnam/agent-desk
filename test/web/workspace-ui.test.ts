import assert from 'node:assert/strict';
import * as federation from '../../web/src/federation.ts';
import * as draftRetention from '../../web/src/draftRetention.ts';
import * as posts from '../../web/src/posts.ts';
import * as feedCache from '../../web/src/feedCache.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as compose from '../../shared/compose.ts';

// Execute the real browser modules with deterministic hooks and browser boundaries.
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = ''): any {
  const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8') + extra;
  imports={ './federation.ts':federation,'./draftRetention.ts':draftRetention,'./Workspaces.tsx':{useSources:()=>[]},...imports};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = { exports: {}, require: (name: string) => {
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
  const project = { id: 'project', name: 'project' };
  const task = { id: 'new-task', project_id: project.id, title: 'new', status: 'running', title_revision: 0 };
  const event = { id: 1, task_id: task.id, session_id: 'session', kind: 'user', ts: '2026-11-12T00:00:00Z', payload: { text: 'first' } };
  const defs = [{ id: 'project-column', filter: { projectIds: [project.id] } }];
  const module = load('useHub.ts', {
    react: h.react, './api.ts': { api: {
      state: async () => ({ projects: [project], tasks: [], approvals: [], questions: [], channels: [] }),
      feed: async () => [], feedPage: async () => ({ events: [], complete: true }),
      feedCount: async () => ({ posts: 0, tasks: 0 }), remember() {},
    }, FEED_PAGE: 1000 },
    './federation.ts': { ...federation, discoverSources: async () => {}, getSources: () => [], subscribeSources: () => () => {} },
    './posts.ts': posts, './projects.ts': { assignProjectColors() {}, forgetProjectColors() {} },
    './feedCache.ts': feedCache,
  }, { EventSource: class { onmessage: any; constructor() { streams.push(this); } close() {} },
    AbortController, window: { setTimeout }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} });
  const render = () => h.render(() => {
    const hub = module.useHub();
    const columns = module.useColumnFeeds(defs, () => defs, hub.tasks, hub.onEvent, hub.synced, hub.gone);
    return { hub, columns };
  });
  try {
    await render().hub.refresh();
    render();
    await Promise.resolve();
    streams[0].onmessage({ data: JSON.stringify({ type: 'event', event }) });
    streams[0].onmessage({ data: JSON.stringify({ type: 'task', task }) });
    await new Promise(resolve => setTimeout(resolve, 65));
    const result = render();
    assert.equal(result.hub.tasks.has(task.id), true);
    assert.equal(result.columns.feeds.get('project-column')?.events.map((e: any) => e.id).join(','), String(event.id));
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
  const render = () => h.render(() => module.useColumnFeeds(defs, () => defs, new Map(), onEvent, 0));
  try {
    render(); await Promise.resolve(); await Promise.resolve();
    for (const id of [3, 4]) for (const listener of listeners) listener(event(id));
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '2,3,4');
    render().loadEarlier('column');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cursors.join(','), '2', 'the evicted first page must be fetched again');
    assert.equal(render().feeds.get('column')?.events.map((e: any) => e.id).join(','), '1,2,3,4');
  } finally { h.unmount(); }
});

test('workspace connections share one refresh and partial state becomes usable before it finishes', async () => {
  const h=hooks(),streams:any[]=[],reads:{progress:(s:any)=>void;finish:(s:any)=>void}[]=[];
  const sources=[{id:'a'},{id:'b'}];
  const value={projects:[{id:'project'}],tasks:[{id:'local-task',project_id:'project'},{id:'w:a:task',project_id:'project'}],approvals:[],questions:[],availableSources:[''],unavailableSources:[]};
  const module=load('useHub.ts',{
    react:h.react,'./api.ts':{api:{state:(progress:any)=>new Promise(resolve=>reads.push({progress,finish:resolve})),
      feed:()=>{throw Error('columns own feed requests');},remember(){}},FEED_PAGE:1000},
    './federation.ts':{...federation,discoverSources:async()=>{},getSources:()=>sources,subscribeSources:()=>()=>{},sourceConnected(){}},
    './posts.ts':posts,'./projects.ts':{assignProjectColors(){},forgetProjectColors(){}},'./feedCache.ts':{},
  },{EventSource:class{onopen:any;constructor(){streams.push(this);}close(){}},setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){}});
  const render=()=>h.render(()=>module.useHub());
  try {
    render();for(const stream of streams)stream.onopen();
    assert.equal(reads.length,1,'three SSE connections must not start three state reads');
    reads[0].progress(value);
    assert.ok(render().tasks.has('local-task'),'the remote state is still pending');
    const refresh=render().refresh();render().refresh();
    streams[0].onopen(); // A reconnect after this source's snapshot also requires a follow-up.
    sources.splice(0,1);
    const current={...value,tasks:value.tasks.slice(0,1)};
    reads[0].finish(current);await new Promise(r=>setTimeout(r,0));
    assert.equal(reads.length,2,'explicit refreshes during a read coalesce into one follow-up');
    reads[1].finish(current);await refresh;
    assert.equal(render().synced,2);
    assert.equal(render().tasks.has('w:a:task'),false,'detaching a source must not retain its old tasks');
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
