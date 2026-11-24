// One JSON-RPC connection per agy process. Request IDs are independent in each direction.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type Id = string | number;
type Json = any;

export class AgyAcp {
  private sequence = 0;
  private requests = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  private ended?: Error;
  private child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams, receive: (method: string, params: Json, id?: Id) => void) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.ended) return;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || msg.jsonrpc !== '2.0') return;
      if (typeof msg.method === 'string') { receive(msg.method, msg.params ?? {}, msg.id); return; }
      const pending = this.requests.get(msg.id);
      if (!pending) return;
      this.requests.delete(msg.id);
      if (msg.error) pending.reject(new Error(String(msg.error.message ?? 'agy 요청 실패')));
      else pending.resolve(msg.result);
    }).on('close', () => this.close());
    child.stdin.on('error', error => this.close(error));
    child.once('error', error => this.close(error));
    child.once('exit', () => this.close());
  }

  call(method: string, params: Json): Promise<Json> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = method === 'session/prompt' ? undefined : setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`agy 응답 시간 초과: ${method}`));
      }, 60_000);
      this.requests.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  reply(id: Id, result: Json) { this.write({ id, result }); }
  unsupported(id: Id) { this.write({ id, error: { code: -32601, message: 'Unsupported client method' } }); }
  private write(payload: Json) {
    if (!this.ended) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n',
      error => { if (error) this.close(error); });
  }
  close(error = new Error('agy 연결이 종료되었습니다')) {
    this.ended = error;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
