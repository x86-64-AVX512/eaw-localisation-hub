import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryBanner } from '../apps/review/src/recovery-banner.ts';

test('recovery opens the file picker after issuance and retries confirmation without rewriting the file', async t => {
  const calls = [];
  let click;
  const action = { addEventListener(_event, listener) { click = listener; } };
  const elements = new Map([['#recovery-action', action], ['#recovery-banner', {}], ['#recovery-message', {}]]);
  const state = { recoveryStatus: 'setup_required', user: 'Translator' };
  const document = { querySelector: selector => elements.get(selector) };
  let pickerCancelled = true;
  const window = {
    async showSaveFilePicker() {
      calls.push('picker');
      if (pickerCancelled) throw new DOMException('Cancelled', 'AbortError');
      return {
        async createWritable() {
          return {
            async write(text) { assert.match(text, /fixture-code/u); calls.push('write'); },
            async close() { calls.push('close'); },
          };
        },
      };
    },
  };
  Object.assign(globalThis, { document, window });
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  let online = true;
  const banner = createRecoveryBanner({
    state,
    showToast() {},
    send(message) { calls.push(message.type); return online; },
  });
  banner.refresh();
  await click();
  assert.deepEqual(calls, ['recoveryIssue']);
  banner.retry();
  assert.equal(action.disabled, false);
  assert.deepEqual(calls, ['recoveryIssue']);

  await click();
  state.recoveryStatus = 'pending_confirmation';
  banner.receive('fixture-code');
  await click();
  assert.deepEqual(calls, ['recoveryIssue', 'recoveryIssue', 'picker']);
  pickerCancelled = false;
  online = false;
  await click();
  assert.deepEqual(calls.slice(-4), ['picker', 'write', 'close', 'recoveryConfirm']);
  assert.equal(action.disabled, false);

  online = true;
  await click();
  assert.deepEqual(calls.slice(-2), ['recoveryConfirm', 'recoveryConfirm']);
  state.recoveryStatus = 'active';
  banner.refresh();
  assert.equal(banner.hasDraft(), false);
});
