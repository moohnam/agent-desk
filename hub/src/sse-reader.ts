/** Decode chunked UTF-8 SSE data without retaining an unbounded upstream frame. */
export async function readSse(body: ReadableStream<Uint8Array>, receive: (data: string) => void, maxChars = 8 * 1024 * 1024) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let tail = '', data: string[] = [], size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      tail += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = tail.indexOf('\n')) !== -1) {
        const line = tail.slice(0, end).replace(/\r$/, ''); tail = tail.slice(end + 1);
        if(line.length>maxChars)throw new Error('SSE frame too large');
        if (!line) {
          if (data.length) receive(data.join('\n'));
          data = []; size = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, ''); size += value.length + 1;
          // Bound array overhead too: tiny data lines must not allocate millions of entries.
          if (size > maxChars || data.length >= 1024) throw new Error('SSE frame too large');
          data.push(value);
        }
      }
      if (tail.length + size > maxChars) throw new Error('SSE frame too large');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
