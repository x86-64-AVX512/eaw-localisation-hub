import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishExternalMerge, resolveExternalConflict,
} from '../apps/agent/src/disk-reconciliation.mjs';

function localClient(path, state) {
  const sent = [];
  return {
    sent,
    documents: new Map([[path, state]]),
    send(message) { sent.push(message); },
  };
}

test('resolved disk conflict is removed from every local view of the file', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const binding = {
    clients: new Set(),
    personalText: '', personalReady: false,
    applyMergedText(text) { this.applied = text; },
  };
  const firstState = { binding, pendingExternal: {}, diskBase: 'old' };
  const secondState = { binding, pendingExternal: {}, diskBase: 'old' };
  const first = localClient(absolutePath, firstState);
  const second = localClient(absolutePath, secondState);
  binding.clients.add(first);
  binding.clients.add(second);

  finishExternalMerge(binding, first, absolutePath, firstState, 'merged', 'done');

  for (const state of [firstState, secondState]) {
    assert.equal(state.pendingExternal, null);
    assert.equal(state.diskBase, 'merged');
  }
  for (const client of [first, second]) {
    assert.ok(client.sent.some((message) => message.type === 'externalConflictReset'
      && message.source === 'disk'));
  }
  assert.equal(binding.applied, 'merged');
});

test('disk conflict resolver ignores explicitly canonical conflicts', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const state = { pendingExternal: {}, binding: null };
  const client = localClient(absolutePath, state);
  const binding = {
    requireState: () => state,
  };
  state.binding = binding;
  assert.equal(resolveExternalConflict(binding, client, absolutePath, {
    source: 'canonical', key: 'key', choice: 'external',
  }), false);
});
