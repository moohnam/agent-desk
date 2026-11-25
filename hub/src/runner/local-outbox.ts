import type { RunnerToHub } from '../../../shared/protocol.ts';
import { isRunnerOutput } from './wire.ts';

interface Entry {
  sequence: number;
  line: string;
  bytes: number;
  event: boolean;
  /** A subagent's step: given up first, before the thread's own events. */
  subagent: boolean;
  output: boolean;
}

/** Keeps unconfirmed output and the existing offline buffer in a single ordered queue. */
export class LocalRunnerOutbox {
  private entries = new Map<number, Entry>();
  private next = 0;
  private bytes = 0;
  private readonly maxCount: number;
  private readonly maxBytes: number;

  constructor(maxCount = 20_000, maxBytes = 64 * 1024 * 1024) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
  }

  hasUnconfirmedOutput() {
    for (const entry of this.entries.values()) if (entry.output) return true;
    return false;
  }

  enqueue(message: RunnerToHub) {
    const line = JSON.stringify(message);
    const entry = { sequence: ++this.next, line, bytes: Buffer.byteLength(line) + 1,
      event: message.type === 'event', subagent: message.type === 'subagent_event', output: isRunnerOutput(message) };
    if (entry.bytes > this.maxBytes || this.maxCount < 1) return { entry, dropped: true };
    this.entries.set(entry.sequence, entry);
    this.bytes += entry.bytes;
    let dropped = false;
    while (this.entries.size > this.maxCount || this.bytes > this.maxBytes) {
      // Keep control messages for as long as possible, as before; subagent steps go before thread events.
      const entries = [...this.entries.values()];
      this.remove(entries.find(e => e.subagent) ?? entries.find(e => e.event) ?? entries[0]);
      dropped = true;
    }
    return { entry, dropped };
  }

  /** A legacy receiver gets the original packet; only negotiated output stays after writing. */
  send(entry: Entry, confirmOutput: boolean, write: (line: string) => boolean): boolean {
    if (confirmOutput && entry.output) {
      return write(`{"type":"output","sequence":${entry.sequence},"message":${entry.line}}\n`);
    }
    const writable = write(entry.line + '\n');
    this.remove(entry);
    return writable;
  }

  flush(confirmOutput: boolean, write: (line: string) => boolean, sentThrough = 0): number {
    for (const entry of this.entries.values()) {
      if (entry.sequence <= sentThrough) continue;
      sentThrough = entry.sequence;
      if (!this.send(entry, confirmOutput, write)) break;
    }
    return sentThrough;
  }

  acknowledge(sequence: number) {
    for (const entry of this.entries.values()) {
      if (entry.sequence > sequence) break;
      this.remove(entry);
    }
  }

  private remove(entry: Entry) {
    if (this.entries.delete(entry.sequence)) this.bytes -= entry.bytes;
  }
}
