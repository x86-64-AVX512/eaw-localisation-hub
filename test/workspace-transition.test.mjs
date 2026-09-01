import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForGitCheckout } from '../apps/agent/src/workspace-transition.mjs';

test('workspace transition waits for the Git index and a stable checkout', async () => {
  let clock = 0;
  const observations = [
    { workspace: 'feature', commit: 'a'.repeat(40), locked: true, indexFingerprint: 'old' },
    { workspace: 'feature', commit: 'a'.repeat(40), locked: false, indexFingerprint: 'one' },
    { workspace: 'feature', commit: 'a'.repeat(40), locked: false, indexFingerprint: 'one' },
    { workspace: 'feature', commit: 'a'.repeat(40), locked: false, indexFingerprint: 'two' },
    { workspace: 'feature', commit: 'a'.repeat(40), locked: false, indexFingerprint: 'two' },
    { workspace: 'feature', commit: 'a'.repeat(40), locked: false, indexFingerprint: 'two' },
  ];
  let calls = 0;
  const hub = {
    gitCheckoutObservation() {
      return observations[Math.min(calls++, observations.length - 1)];
    },
  };
  const result = await waitForGitCheckout(hub, 'feature', {
    timeoutMilliseconds: 1_000,
    quietMilliseconds: 100,
    pollMilliseconds: 50,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(result.indexFingerprint, 'two');
  assert.equal(calls, 6);
});

test('workspace transition fails closed when checkout never settles', async () => {
  let clock = 0;
  const hub = {
    gitCheckoutObservation: () => ({
      workspace: 'feature', commit: 'a'.repeat(40), locked: true, indexFingerprint: 'locked',
    }),
  };
  await assert.rejects(waitForGitCheckout(hub, 'feature', {
    timeoutMilliseconds: 100,
    pollMilliseconds: 50,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  }), /did not settle/u);
});
