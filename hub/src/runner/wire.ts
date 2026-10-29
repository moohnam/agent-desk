import type { Socket } from 'node:net';

export const RUNNER_HOST = '127.0.0.1';
export const RUNNER_PORT = Number(process.env.RUNNER_PORT ?? 4318);

/** Calls `onMessage` for each newline-delimited JSON message read from `socket`. */
export function readLines(socket: Socket, onMessage: (m: any) => void) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: unknown;
      try { m = JSON.parse(line); } catch (err) { console.error('bad message', err); continue; }
      try { onMessage(m); } catch (err) { console.error('message handling failed', err); }
    }
  });
}

export function writeLine(socket: Socket, m: unknown) {
  socket.write(JSON.stringify(m) + '\n');
}
