import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { mergeTaskEvents } from '../../web/src/posts.ts';

type Page = { events: ReturnType<typeof event>[]; more: boolean };

function event(id: number, task = 'a', clipped = false) {
  return { id, task_id: task, kind: 'assistant', payload: { text: String(id), ...(clipped && { clipped: true }) }, ts: '' };
}

function harness() {
  const slots: any[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const requests: { task: string; at: { since?: number; before?: number }; signal: AbortSignal; resolve: (page: Page) => void; reject: (error: Error) => void }[] = [];
  const listeners = new Set<(value: ReturnType<typeof event>) => void>();
  const react = {
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
    useCallback(fn: any, deps: any[]) {
      const i = cursor++, old = slots[i];
      if (!old || !deps.every((value, j) => Object.is(value, old.deps[j]))) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(fn: () => (() => void) | void, deps: any[]) {
      const i = cursor++, old = slots[i];
      if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    },
  };
  const api = { events(task: string, at: { since?: number; before?: number }, signal: AbortSignal) {
    return new Promise<Page>((resolve, reject) => requests.push({ task, at, signal, resolve, reject }));
  } };
  const source = readFileSync(new URL('../../web/src/useHub.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports: Record<string, unknown> = {
    react, './api.ts': { api }, './posts.ts': { mergeTaskEvents }, './federation.ts': {},
    './projects.ts': {}, './feedCache.ts': {}, './draftRetention.ts': {},
  };
  const context = {
    exports: {}, require: (name: string) => { assert.ok(name in imports, `missing ${name}`); return imports[name]; },
    AbortController, setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  runInNewContext(code, context);
  const useTaskEvents = (context.exports as any).useTaskEvents;
  const onEvent = (fn: (value: ReturnType<typeof event>) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  return {
    requests, timers,
    render(task: string | null, reload = 0, since?: number) {
      cursor = 0;
      const result = useTaskEvents(task, onEvent, since, reload);
      const pending = effects; effects = []; pending.forEach(fn => fn());
      return result as { events: ReturnType<typeof event>[]; loaded: boolean; more: boolean; loadEarlier: () => void };
    },
    live(value: ReturnType<typeof event>) { for (const fn of listeners) fn(value); },
    tick() { const next = timers.entries().next().value; assert.ok(next); const [id, timer] = next; timers.delete(id); timer.fn(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

test('failed initial history retries and replaces a cut live event with its whole payload', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].reject(new Error('temporary failure'));
  await settled();
  h.live(event(2, 'a', true));
  assert.equal(h.render('a').loaded, false);
  assert.equal(h.timers.size, 2, 'history retry and cut-event hydration are both pending');
  h.tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at.since, 2, 'the first live event bounds a retry before any server read succeeds');
  h.requests[1].resolve({ events: [event(1), event(2)], more: false });
  await settled();
  const result = h.render('a');
  assert.equal(result.loaded, true);
  assert.deepEqual(result.events.map(e => e.id), [1, 2]);
  assert.equal(result.events[1].payload.clipped, undefined);
  h.unmount();
});

test('reconnect fills a gap before a newer live event and preserves earlier paging', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].resolve({ events: [event(10), event(11)], more: true });
  await settled();
  h.render('a').loadEarlier();
  assert.equal(h.requests[1].at.before, 10);
  h.requests[1].resolve({ events: [event(8), event(9)], more: true });
  await settled();
  h.live(event(603));
  h.render('a', 1);
  assert.equal(h.requests[2].at.since, 11, 'the cursor stays at the last successful history read');
  h.requests[2].resolve({ events: Array.from({ length: 593 }, (_, i) => event(i + 11)), more: true });
  await settled();
  const result = h.render('a', 1);
  assert.equal(result.loaded, true);
  assert.equal(result.more, true);
  assert.deepEqual(result.events.slice(0, 4).map(e => e.id), [8, 9, 10, 11]);
  assert.equal(result.events.length, 596, 'the live event and fetched event appear only once');
  result.loadEarlier();
  assert.equal(h.requests[3].at.before, 8, 'paging continues from the oldest retained event');
  h.unmount();
});

test('task switch aborts an old request and cancels its retry timer', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].reject(new Error('temporary failure'));
  await settled();
  assert.equal(h.timers.size, 1);
  h.render('b');
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests[1].task, 'b');
  assert.equal(h.requests[1].at.since, undefined);
  h.requests[1].resolve({ events: [event(5, 'b')], more: false });
  await settled();
  assert.equal(h.render('b').events.map(e => e.task_id).join(','), 'b');
  h.unmount();
});

test('a stale failed reload cannot schedule a retry after a newer reload succeeds', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].resolve({ events: [event(10)], more: false });
  await settled();
  h.render('a', 1);
  h.render('a', 2);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.requests[2].at.since, 10);
  h.requests[2].resolve({ events: [event(10), event(11)], more: false });
  await settled();
  h.requests[1].reject(new Error('late failure'));
  await settled();
  assert.equal(h.render('a', 2).events.map(e => e.id).join(','), '10,11');
  assert.equal(h.timers.size, 0);
  h.unmount();
});

test('changing focus within a task does not skip the gap before the focused post', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].resolve({ events: [event(10), event(11)], more: false });
  await settled();
  h.live(event(603));
  h.render('a', 0, 500);
  assert.equal(h.requests[1].at.since, 11);
  h.requests[1].resolve({ events: Array.from({ length: 593 }, (_, i) => event(i + 11)), more: false });
  await settled();
  assert.equal(h.render('a', 0, 500).events.length, 594);
  h.unmount();
});

test('history retries back off to ten seconds with only one pending timer', async () => {
  const h = harness();
  h.render('a');
  for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
    h.requests[h.requests.length - 1].reject(new Error('temporary failure'));
    await settled();
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, delay);
    h.tick();
  }
  h.unmount();
  assert.equal(h.timers.size, 0);
});

test('first failed read recovers a gap larger than the newest page before advancing its cursor', async () => {
  const h = harness();
  h.render('a');
  h.requests[0].reject(new Error('temporary failure'));
  await settled();
  h.live(event(1));
  h.tick();
  assert.equal(h.requests[1].at.since, 1);
  h.requests[1].resolve({ events: Array.from({ length: 603 }, (_, i) => event(i + 1)), more: false });
  await settled();
  const result = h.render('a');
  assert.equal(result.loaded, true);
  assert.equal(result.more, false);
  assert.equal(result.events.length, 603);
  h.render('a', 1);
  assert.equal(h.requests[2].at.since, 603);
  h.unmount();
});

test('an in-flight first read backfills earlier live events before marking history loaded', async () => {
  const h = harness();
  h.render('a');
  h.live(event(1));
  h.requests[0].resolve({ events: Array.from({ length: 500 }, (_, i) => event(i + 104)), more: true });
  await settled();
  assert.equal(h.requests[1].at.since, 1);
  assert.equal(h.render('a').loaded, false);
  h.requests[1].resolve({ events: Array.from({ length: 603 }, (_, i) => event(i + 1)), more: false });
  await settled();
  const result = h.render('a');
  assert.equal(result.loaded, true);
  assert.equal(result.more, false);
  assert.equal(result.events.length, 603);
  h.unmount();
});

test('a superseded gap backfill cannot overwrite the newer history generation', async () => {
  const h = harness();
  h.render('a');
  h.live(event(1));
  h.requests[0].resolve({ events: Array.from({ length: 500 }, (_, i) => event(i + 104)), more: true });
  await settled();
  assert.equal(h.requests[1].at.since, 1);
  h.render('a', 1);
  assert.equal(h.requests[1].signal.aborted, true);
  assert.equal(h.requests[2].at.since, 1);
  h.requests[2].resolve({ events: Array.from({ length: 603 }, (_, i) => event(i + 1)), more: false });
  await settled();
  h.requests[1].resolve({ events: [event(1)], more: false });
  await settled();
  const result = h.render('a', 1);
  assert.equal(result.loaded, true);
  assert.equal(result.events.length, 603);
  assert.equal(result.more, false);
  h.unmount();
});

test('an incomplete backfill retries without declaring the gapped history loaded', async () => {
  const h = harness();
  h.render('a');
  h.live(event(1));
  const newest = { events: Array.from({ length: 500 }, (_, i) => event(i + 104)), more: true };
  h.requests[0].resolve(newest);
  await settled();
  h.requests[1].resolve(newest);
  await settled();
  assert.equal(h.render('a').loaded, false);
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.requests[2].at.since, 1);
  h.requests[2].resolve({ events: Array.from({ length: 603 }, (_, i) => event(i + 1)), more: false });
  await settled();
  assert.equal(h.render('a').events.length, 603);
  h.unmount();
});
