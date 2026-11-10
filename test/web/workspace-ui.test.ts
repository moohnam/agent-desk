import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as compose from '../../shared/compose.ts';

// Execute the real browser modules with deterministic hooks and browser boundaries.
function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}, extra = ''): any {
  const source = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), 'utf8') + extra;
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
    const render = () => h.render(() => files.useFileDrop(ref, '', (value: string) => { inserted = value; }));
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
        './drafts.ts': { getDraft: () => draft, setDraft: (_key: string, value: string, options: { empty: boolean }) => { draft = options.empty ? undefined : value; }, useDraftSync() {} },
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
