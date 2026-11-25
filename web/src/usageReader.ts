export async function readUsageApi<T>(path: string, signal: AbortSignal, timeout = 15000): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
  });
  if (!response.ok) {
    const value = await response.json().catch(() => undefined);
    throw Object.assign(new Error(value?.error ?? `HTTP ${response.status}`), {status: response.status});
  }
  return await response.json() as T;
}

