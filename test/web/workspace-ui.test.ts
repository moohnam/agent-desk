import assert from 'node:assert/strict';
import * as federation from '../../web/src/federation.ts';
import * as draftRetention from '../../web/src/draftRetention.ts';
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


test('approval and question SSE updates survive a delayed feed during state refresh',async()=>{
 const h=hooks();const streams:any[]=[];let finish:(events:any[])=>void=()=>{};
 const feed=new Promise<any[]>(r=>{finish=r;});
 const request=(id:string,status:string)=>({id,task_id:'task',session_id:'session',status,created_at:'',text:'?',answer:null,answered_at:null,tool_name:'Bash',input:{}});
 const module=load('useHub.ts',{
   react:h.react,'./api.ts':{api:{state:async()=>({projects:[],tasks:[],approvals:[request('old','pending')],questions:[request('old','pending')],runner:{connected:true}}),feed:()=>feed,remember(){}},FEED_PAGE:1000},
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

test('an empty shared project deleted during a delayed feed does not reappear', async () => {
  const h = hooks(), streams: any[] = [];
  let finish: (events: any[]) => void = () => {};
  const feed = new Promise<any[]>(resolve => { finish = resolve; });
  const project = { id: federation.scopeId('shared-a', 'project'), name: 'shared-test' };
  const module = load('useHub.ts', {
    react: h.react,
    './api.ts': { api: { state: async () => ({ projects: [project], tasks: [], approvals: [], questions: [] }), feed: () => feed, remember() {} }, FEED_PAGE: 1000 },
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
