import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateCiPassed, usesUpdateCi } from '../../hub/src/update-ci.ts';

const commit = 'a'.repeat(40);
const pass = {
  head_sha: commit, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  path: '.github/workflows/ci.yml', head_repository: { full_name: 'moohnam/agent-desk' },
};

test('automatic CI policy recognizes only the official repository and main branch', () => {
  const source = 'https://github.com/moohnam/agent-desk.git';
  assert.equal(usesUpdateCi({source, ref:'main'}), true);
  assert.equal(usesUpdateCi({source:'git@github.com:moohnam/agent-desk.git', ref:'refs/heads/main'}), true);
  assert.equal(usesUpdateCi({source, ref:'refs/tags/main'}), false);
  assert.equal(usesUpdateCi({source:'https://github.com/fork/agent-desk.git', ref:'main'}), false);
});

test('CI must pass for the exact SHA, workflow, repository and main push', async () => {
  const runs = (workflow_runs: unknown[]) => async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/repos/moohnam/agent-desk/actions/workflows/ci.yml/runs');
    assert.equal(url.searchParams.get('head_sha'), commit);
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
    return Response.json({workflow_runs});
  };
  assert.equal(await updateCiPassed(commit, runs([pass])), true);
  const rejected = [null, {...pass, head_sha:'b'.repeat(40)}, {...pass, head_branch:'dev'}, {...pass, event:'pull_request'},
    {...pass, status:'in_progress'}, {...pass, conclusion:'failure'}, {...pass, path:'.github/workflows/other.yml'},
    {...pass, head_repository:{full_name:'someone/agent-desk'}}];
  assert.equal(await updateCiPassed(commit, runs(rejected)), false);
  assert.equal(await updateCiPassed(commit, runs([])), false);
  await assert.rejects(updateCiPassed(commit, async () => Response.json({}, {status:429})), /HTTP 429/);
});
