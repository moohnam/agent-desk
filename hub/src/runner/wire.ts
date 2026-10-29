import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { config } from '../config.ts';

export const { host: RUNNER_HOST, port: RUNNER_PORT, tokenFile: RUNNER_TOKEN_FILE } = config.runner;

/** The runner token (readable by this user only), made on first use. The hub and the runner each call this; whichever comes first writes it. */
export function runnerToken(file = RUNNER_TOKEN_FILE): string {
  mkdirSync(dirname(file), { recursive: true });
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  return readFileSync(file, 'utf8').trim();
}

/** Whether `given` is the token, in constant time. */
export function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Calls `onMessage` for each newline-delimited JSON message read from `socket`. */
export function readLines(socket: Socket, onMessage: (m: unknown) => void) {
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
