// What the engine adapters (claude.ts, codex.ts, agy.ts) share: how a session is started, how tool
// output is cut, the end of a process's stderr, and, for engines that run one turn at a time, the
// queue of turns and the busy signal that goes with it.

import { execFileSync, type ChildProcess } from 'node:child_process';
import type { Effort, ModelName, PermissionMode } from '../../../shared/compose.ts';
import type { EngineAdapter, RunnerToHub } from '../../../shared/protocol.ts';

/** How the runner starts a session of any engine; the adapter reports through `emit`. */
export interface StartOptions {
  sessionId: string; cwd: string; prompt: string; resume?: string; fork?: boolean; permissionMode: PermissionMode;
  model?: ModelName; effort?: Effort; skills?: string[]; skillsHome?: string;
  /** pi only: the local model's context size in tokens. */
  context?: number;
  emit: (m: RunnerToHub) => void;
}
export type StartEngine = (opts: StartOptions) => EngineAdapter;

/** Tool output kept per result; the rest is cut, so one command's output can't flood the feed. */
export const MAX_RESULT_TEXT = 4000;
export const clipResult = (text: string) => text.length > MAX_RESULT_TEXT ? text.slice(0, MAX_RESULT_TEXT) + '\n…(truncated)' : text;

/** The last lines a process wrote to stderr, for the message when it dies. Lines split across chunks stay whole. */
export class StderrTail {
  private lines: string[] = [];
  private partial = '';
  private max: number;
  constructor(max = 20) { this.max = max; }
  push(chunk: Buffer | string) {
    const parts = (this.partial + chunk.toString()).split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) if (line.trim()) this.lines.push(line);
    this.lines.splice(0, Math.max(0, this.lines.length - this.max));
  }
  /** The last `n` lines (those `keep` passes), the unfinished one included. */
  last(n: number, keep: (line: string) => boolean = () => true): string[] {
    return [...this.lines, ...(this.partial.trim() ? [this.partial] : [])].filter(keep).slice(-n);
  }
  clear() { this.lines = []; this.partial = ''; }
}

/**
 * A session's turns when the engine runs one at a time (Codex, agy): a message sent while a turn
 * runs, or before the session is ready, waits; as a turn ends the next one starts, and when none is
 * left the session reports `busy: false`. The adapter reports `busy: true` itself when a message comes.
 */
export class TurnQueue<T> {
  /** A turn is running (started and not yet ended). */
  active = false;
  private waiting: T[] = [];
  private ready: boolean;
  private run: (turn: T) => void;
  private setBusy: (busy: boolean) => void;
  /** `run` starts a turn; `ready` false holds messages until open(). */
  constructor(run: (turn: T) => void, setBusy: (busy: boolean) => void, ready = true) {
    this.run = run;
    this.setBusy = setBusy;
    this.ready = ready;
  }
  /** A message: its turn starts now if nothing runs and the session is ready, else after the ones waiting. */
  push(turn: T) {
    if (this.active || !this.ready || this.waiting.length) this.waiting.push(turn);
    else this.begin(turn);
  }
  /** The session is ready (Codex: its thread started); a message that waited for it starts. */
  open() {
    this.ready = true;
    this.next();
  }
  /** The running turn ended (done, failed or interrupted): the next starts, or the session is idle. */
  ended() {
    if (!this.active) return;
    this.active = false;
    this.next();
  }
  /** Drops the waiting messages; whether there were any. */
  clear(): boolean {
    const had = this.waiting.length > 0;
    this.waiting.length = 0;
    return had;
  }
  private begin(turn: T) {
    this.active = true;
    this.run(turn);
  }
  private next() {
    if (this.active || !this.ready) return;
    const turn = this.waiting.shift();
    if (turn !== undefined) this.begin(turn);
    else this.setBusy(false);
  }
}

/** Everything `root` started, deepest first, as ps shows it now. */
export function descendants(root: number): number[] {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return []; }
  const kids = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const walk = (p: number) => { for (const c of kids.get(p) ?? []) { walk(c); found.push(c); } };
  walk(root);
  return found;
}

/**
 * Stops an engine process and what it started. agy runs each command in a session of its own (a
 * terminal), which outlives agy and a signal to its process group, so the commands are found first
 * and signalled one by one: SIGTERM, then SIGKILL for those still running a few seconds later.
 */
export function stopTree(proc: ChildProcess, signal: NodeJS.Signals) {
  const pids = proc.pid ? descendants(proc.pid) : [];
  proc.kill(signal);
  const send = (sig: NodeJS.Signals) => { for (const pid of pids) { try { process.kill(pid, sig); } catch { /* already gone */ } } };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), 3000).unref();
}
