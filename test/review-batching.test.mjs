import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { emitPresences, emitReservationTargets, emitReservations, emitReview } from '../apps/agent/src/document-view.mjs';
import { createCollaborationRefresh } from '../apps/review/src/review-refresh.js';

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

test('Review receives comment and suggestion snapshots as one atomic batch and skips unchanged repeats', () => {
  const { binding, messages } = harness('review');
  emitReview(binding);
  assert.deepEqual(messages.map(({ type }) => type), [
    'reviewBatchStart', 'commentReset', 'suggestionReset', 'reviewBatchEnd',
  ]);
  emitReview(binding);
  assert.equal(messages.length, 4);
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

test('Review receives presence and reservation targets as snapshots while the plugin keeps its sequence', () => {
  for (const kind of ['review', 'plugin']) {
    const { binding, messages } = harness(kind);
    const document = new Y.Doc();
    const text = document.getText('content');
    text.insert(0, 'l_russian:\nKEY:0 "Значение"');
    const relative = Buffer.from(Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, 12),
    )).toString('base64');
    binding.document = document;
    binding.text = text;
    binding.presences = new Map([['remote', {
      clientId: 'remote', user: 'Другой', color: '#123456',
      caretRelative: relative, anchorRelative: relative,
    }]]);
    binding.hub = {
      isLocalPresenceId: () => false,
      directory: [{ id: 'one', displayName: 'Другой', color: '#123456' }],
      identity: { id: 'self' }, options: { user: 'Я', color: '#654321' },
    };
    emitPresences(binding);
    emitReservationTargets(binding);
    assert.deepEqual(messages.map(({ type }) => type), kind === 'review'
      ? ['presenceSnapshot', 'reservationTargetSnapshot']
      : ['presenceReset', 'presence', 'reservationTargetReset', 'reservationTarget']);
    if (kind === 'review') {
      assert.equal(messages[0].presences[0].user, 'Другой');
      assert.equal(messages[1].targets[0].displayName, 'Другой');
      emitReservationTargets(binding);
      assert.equal(messages.length, 2, 'an unchanged target directory must not be sent again');
      emitReservationTargets(binding, binding.clients[0]);
      assert.equal(messages.length, 3, 'an explicit client synchronisation must resend the snapshot');
    }
    document.destroy();
  }
});

test('collaboration refresh redraws only sections changed during one animation frame', (t) => {
  let frame = null;
  globalThis.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = null; };
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  let decorations = 0;
  const sections = [];
  const refresh = createCollaborationRefresh(
    () => { decorations += 1; },
    { refresh: (requested) => sections.push(requested ? [...requested].sort() : null) },
  );
  refresh.schedule('presenceSnapshot');
  refresh.schedule('presenceSnapshot');
  refresh.schedule('reservationTargetSnapshot');
  frame();
  assert.equal(decorations, 1);
  assert.deepEqual(sections, [['presences', 'reservations', 'targets']]);

  refresh.schedule('externalConflict');
  frame();
  assert.equal(decorations, 1, 'conflicts do not require editor decoration recalculation');
  assert.deepEqual(sections.at(-1), ['conflicts']);
  refresh.dispose();
});
