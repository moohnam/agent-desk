/** Public update status. Configuration paths, environment and control identities stay on the hub. */
export type UpdateRole = 'hub' | 'daemon' | 'local' | 'shared' | 'remote';
export type UpdateMode = 'immediate' | 'when-idle';
export interface UpdateSummary {
  commits: { sha: string; subject: string }[];
  files: number;
  hub: boolean;
  runner: boolean;
}
export interface UpdateView {
  configured: boolean;
  current: string | null;
  available: string | null;
  latest: string | null;
  discoveryError: string | null;
  ciPending?: boolean;
  phase: 'not-configured' | 'idle' | 'checking' | 'ready' | 'waiting' | 'switching' | 'active' | 'failed';
  checking: boolean;
  targets: UpdateRole[];
  summary: UpdateSummary | null;
  canApply: boolean;
  reason: string | null;
  approval: { commit: string; mode: UpdateMode } | null;
  error: string | null;
}
