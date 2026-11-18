const REPOSITORY = 'moohnam/agent-desk';
const WORKFLOW = '.github/workflows/ci.yml';

/** Only the official main channel uses the public CI as its verification authority. */
export function usesUpdateCi(config: { source: string; ref: string }): boolean {
  return ['main', 'refs/heads/main'].includes(config.ref)
    && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)moohnam\/agent-desk(?:\.git)?\/?$/i.test(config.source);
}

export async function updateCiPassed(commit: string, request: typeof fetch = fetch): Promise<boolean> {
  const query = new URLSearchParams({ head_sha: commit, branch: 'main', event: 'push', status: 'success', per_page: '10' });
  const response = await request(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?${query}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Agent-Desk-Updater' },
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`GitHub CI 결과를 조회하지 못했습니다 (HTTP ${response.status}).`);
  type Run = { head_sha?: string; head_branch?: string; event?: string; status?: string; conclusion?: string; path?: string; head_repository?: { full_name?: string } };
  const data = await response.json() as { workflow_runs?: (Run | null)[] };
  if (!Array.isArray(data?.workflow_runs)) throw new Error('GitHub CI 결과 형식을 확인할 수 없습니다.');
  return data.workflow_runs.some(run => run?.head_sha === commit && run.head_branch === 'main' && run.event === 'push'
    && run.status === 'completed' && run.conclusion === 'success' && run.path === WORKFLOW
    && typeof run.head_repository?.full_name === 'string' && run.head_repository.full_name.toLowerCase() === REPOSITORY);
}
