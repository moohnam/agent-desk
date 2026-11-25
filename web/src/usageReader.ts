export async function readUsageApi<T>(path: string, signal: AbortSignal, timeout = 15000): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

