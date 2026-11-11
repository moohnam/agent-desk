/** A project belongs to one machine and directory; the display address is never a shell command. */
export function remoteLocation(value: string): { address: string; path: string } | null {
  if (!value || value.startsWith('/') || value.startsWith('~/') || value.startsWith('./') || value.startsWith('../')) return null;
  if (!value.includes('@') && !/^[^/]*:/.test(value)) return null;
  const m = /^((?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*):((?:\/|~\/).*)$/.exec(value);
  if (!m || /[\r\n\0]/.test(value)) throw new Error('원격 경로는 호스트:~/경로 또는 호스트:/절대경로로 입력하세요. 계정을 지정하려면 사용자@호스트를 사용하세요');
  return { address: m[1], path: m[2] };
}

export interface RemoteRunnerView {
  id: string; address: string; connected: boolean; last_seen: string | null; pending: number; engines: string[];
}

/** Each side acknowledges only data already committed to its own database. */
export interface Sequenced<T> { seq: number; value: T; created_at?: string }
export interface RemoteExchange {
  version: 1; journalId: string; commandAck: number;
  events: Sequenced<import('./protocol.ts').RunnerToHub>[]; more: boolean;
  sessions: import('./protocol.ts').LiveSession[];
  engines: string[];
  /** Absent from old agents; only true means frozen desk skill commands are safe to deliver. */
  skillSnapshot?: boolean;
}
export interface RemoteReply {
  eventAck: number;
  commands: Sequenced<import('./protocol.ts').HubToRunner>[];
}
