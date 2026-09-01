import assert from 'node:assert/strict';
import test from 'node:test';
import { emitReview } from '../apps/agent/src/document-view.mjs';

function harness(kind) {
  const messages = [];
  const binding = {
    clients: [],
    text: { toString: () => 'l_russian:\n' },
    commentThreads: new Map(),
    suggestions: new Map(),
  };
  const client = {
    kind,
    documents: new Map([['C:\\repo\\localisation\\russian\\test.yml', {
      binding, initialised: true,
    }]]),
    send: (message) => messages.push(message),
  };
  binding.clients.push(client);
  return { binding, messages };
}

test('Review receives comment and suggestion snapshots as one atomic batch', () => {
  const { binding, messages } = harness('review');
  emitReview(binding);
  assert.deepEqual(messages.map(({ type }) => type), [
    'reviewBatchStart', 'commentReset', 'suggestionReset', 'reviewBatchEnd',
  ]);
});

test('legacy plugin keeps its established review message sequence', () => {
  const { binding, messages } = harness('plugin');
  emitReview(binding);
  assert.deepEqual(messages.map(({ type }) => type), ['commentReset', 'suggestionReset']);
});
