import assert from 'node:assert/strict';
import test from 'node:test';
import { emitReservations, emitReview } from '../apps/agent/src/document-view.mjs';

function harness(kind) {
  const messages = [];
  const binding = {
    clients: [],
    text: { toString: () => 'l_russian:\n' },
    commentThreads: new Map(),
    suggestions: new Map(),
    reservations: new Map(),
    resolveReservation: () => null,
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

test('Review receives reservations in one snapshot while the legacy plugin keeps its sequence', () => {
  const review = harness('review');
  review.binding.reservations.set('one', {
    id: 'one', assignee: 'User', color: '#123456', startRelative: '', endRelative: '', initialKeys: ['key'],
  });
  emitReservations(review.binding);
  assert.deepEqual(review.messages.map(({ type }) => type), ['reservationSnapshot']);
  assert.equal(review.messages[0].reservations.length, 1);

  const plugin = harness('plugin');
  plugin.binding.reservations = review.binding.reservations;
  emitReservations(plugin.binding);
  assert.deepEqual(plugin.messages.map(({ type }) => type), ['reservationReset', 'reservation']);
});

test('legacy plugin keeps its established review message sequence', () => {
  const { binding, messages } = harness('plugin');
  emitReview(binding);
  assert.deepEqual(messages.map(({ type }) => type), ['commentReset', 'suggestionReset']);
});
