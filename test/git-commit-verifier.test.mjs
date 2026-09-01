import assert from 'node:assert/strict';
import test from 'node:test';
import { GitCommitVerifier } from '../apps/server/src/git-commit-verifier.mjs';

test('GitHub verifier requires the commit to be an ancestor of the selected branch and caches success', async () => {
  const commit = 'a'.repeat(40);
  let calls = 0;
  const verifier = new GitCommitVerifier('EaW-Team/equestria_dev', async (url) => {
    calls += 1;
    assert.match(url, /compare\/a{40}\.\.\.general-dev$/u);
    return { ok: true, status: 200, async json() {
      return { status: 'ahead', base_commit: { sha: commit } };
    } };
  });
  await verifier.verify('general-dev', commit);
  await verifier.verify('general-dev', commit);
  assert.equal(calls, 1);
});

test('GitHub verifier rejects commits outside the branch and fails closed on outages', async () => {
  const commit = 'b'.repeat(40);
  const absent = new GitCommitVerifier('EaW-Team/equestria_dev', async () => ({ status: 404, ok: false }));
  await assert.rejects(absent.verify('general-dev', commit), /does not belong/u);
  const unavailable = new GitCommitVerifier('EaW-Team/equestria_dev', async () => { throw new Error('offline'); });
  await assert.rejects(unavailable.verify('general-dev', commit), /unavailable/u);
});
