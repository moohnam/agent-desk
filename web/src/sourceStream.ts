/** Per-source facade over a single gateway SSE connection, shared within this page. */
interface SourceStream {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  close: () => void;
}
interface Packet { source: string; view_index?: number; connected?: boolean; message?: unknown }
type Connection = Pick<EventSource, 'onerror' | 'onmessage' | 'close'> & { readyState?: number };
/** EventSource.CLOSED: the browser gave up on this transport and will not retry it. */
const CLOSED = 2;
const RETRY_MIN_MS = 1000, RETRY_MAX_MS = 30_000;

export function createSourceStreams(connect: () => Connection,
  schedule: (fn: () => void, ms: number) => () => void = (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); }) {
  let connection: Connection | undefined;
  let cancelRetry: (() => void) | undefined, retryMs = RETRY_MIN_MS;
  const subscribers = new Map<string, Set<SourceStream>>();
  const statuses = new Map<string, boolean>();
  const open = () => {
    cancelRetry?.(); cancelRetry = undefined;
    connection = connect();
    const active = connection;
    connection.onmessage = event => {
      if(connection!==active)return;
      retryMs = RETRY_MIN_MS;
      let packet: Packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (!packet || typeof packet.source !== 'string' || packet.source.length>128) return;
      if (typeof packet.connected === 'boolean') {
        if(packet.connected||subscribers.has(packet.source))statuses.set(packet.source, packet.connected);else statuses.delete(packet.source);
        if(statuses.size>512)for(const key of statuses.keys()){if(!subscribers.has(key)){statuses.delete(key);break;}}
        for (const sub of subscribers.get(packet.source) ?? []) packet.connected ? sub.onopen?.() : sub.onerror?.();
      } else if (packet.message) {
        for (const sub of subscribers.get(packet.source) ?? []) sub.onmessage?.({data: JSON.stringify(packet.message)});
      }
    };
    connection.onerror = () => {
      if(connection!==active)return;
      statuses.clear();
      for (const group of subscribers.values()) for (const sub of group) sub.onerror?.();
      // A dropped connection the browser reopens by itself. After an HTTP error response (a 503
      // while the hub restarts) it closes the transport for good, so open a new one, backing off.
      if (active.readyState !== CLOSED) return;
      active.close(); connection = undefined;
      if (!subscribers.size) return;
      cancelRetry = schedule(() => { cancelRetry = undefined; if (subscribers.size && !connection) open(); }, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  };
  return (source: string): SourceStream => {
    const stream: SourceStream = { onopen: null, onerror: null, onmessage: null, close() {
      const group = subscribers.get(source); group?.delete(stream);
      if (!group?.size) subscribers.delete(source);
      if (!subscribers.size) {
        connection?.close(); connection = undefined; statuses.clear();
        cancelRetry?.(); cancelRetry = undefined; retryMs = RETRY_MIN_MS;
      }
    } };
    let group = subscribers.get(source);
    if (!group) subscribers.set(source, group = new Set());
    group.add(stream);
    if (!connection) open();
    // Discovery can finish after the gateway has already reported this source's connection.
    const known = statuses.get(source);
    if (known !== undefined) queueMicrotask(() => {
      if (subscribers.get(source)?.has(stream)) statuses.get(source) ? stream.onopen?.() : stream.onerror?.();
    });
    return stream;
  };
}
export const openSourceStream = createSourceStreams(() => new EventSource('/api/streams'));
