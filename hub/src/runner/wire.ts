import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import { checkRunnerToHub, type RunnerToHub } from '../../../shared/protocol.ts';

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
      try { m = JSON.parse(line); } catch { console.error('러너 연결의 JSON 메시지 형식이 잘못되었습니다.'); continue; }
      try { onMessage(m); } catch { console.error('러너 연결 메시지를 처리하지 못했습니다.'); }
    }
  });
}

export function writeLine(socket: Socket, m: unknown) {
  socket.write(JSON.stringify(m) + '\n');
}

/** Replay conversation output and the engine ID. Running state comes from the hello snapshot. */
export function isRunnerOutput(message: RunnerToHub): message is Extract<RunnerToHub, { type: 'event' | 'engine_session' }> {
  if (message.type === 'engine_session') return true;
  if (message.type !== 'event') return false;
  if (message.event.kind === 'status' && message.event.state === 'request_receipt') return true;
  const { kind } = message.event;
  return kind === 'assistant' || kind === 'tool' || kind === 'tool_result';
}

export function wireSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function readOutput(raw: unknown) {
  const packet = raw as { sequence?: unknown; message?: unknown };
  if (!wireSequence(packet.sequence)) return null;
  const message = checkRunnerToHub(packet.message);
  return typeof message !== 'string' && isRunnerOutput(message) ? { sequence: packet.sequence, message } : null;
}
