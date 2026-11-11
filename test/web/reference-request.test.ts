import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../../web/src/api.ts';

test('leaving a thread cancels the original lookup instead of parsing an abandoned response', async t => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  const fetch = t.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => {
    received = options?.signal;
    return new Promise<Response>((_resolve, reject) => received?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  });
  const request = api.events('thread-a', { ids: [1, 90] }, controller.signal);
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(received, controller.signal);
  assert.equal(fetch.mock.callCount(), 1);
});
