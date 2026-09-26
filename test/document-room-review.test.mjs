import assert from 'node:assert/strict';
import os from 'node:os';
import { after, test } from 'node:test';
import * as Y from 'yjs';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { projectedSuggestionStateBytes } from '../apps/server/src/document-suggestion-projection.mjs';

after(closeDocumentRoomValidator);

test('suggestion budget projection never changes the live document', () => {
  const document = new Y.Doc();
  try {
    const content = document.getText('content');
    content.insert(0, 'old');
    assert.ok(projectedSuggestionStateBytes(document, 0, 3, 'new') > 0);
    assert.equal(content.toString(), 'old');
  } finally { document.destroy(); }
});

function reviewRoom(text = 'old') {
  const registry = { persistedBytesFor: () => 0, assertStateBudget() {} };
  const room = new DocumentRoom(os.tmpdir(), 'test:localisation/russian/review.yml',
    'document-room-review-test', { required: false }, registry);
  const content = room.document.getText('content');
  content.insert(0, text);
  const messages = [];
  const socket = { readyState: 1, bufferedAmount: 0, identity: { displayName: 'Alice' },
    send(value, options) { if (!options?.binary) messages.push(JSON.parse(value)); } };
  room.clients.add(socket);
  const startRelative = Buffer.from(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, 0, -1),
  )).toString('base64');
  const endRelative = Buffer.from(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, text.length, 0),
  )).toString('base64');
  return { room, content, socket, messages, anchors: { startRelative, endRelative } };
}

test('review commands keep duplicate replies idempotent and roll back metadata over budget', () => {
  const { room, socket, anchors } = reviewRoom();
  try {
    room.applyJson(socket, { type: 'comment-create', id: 'thread', messageId: 'first',
      body: 'Первый', ...anchors });
    room.applyJson(socket, { type: 'comment-reply', id: 'thread', messageId: 'reply', body: 'Ответ' });
    room.applyJson(socket, { type: 'comment-reply', id: 'thread', messageId: 'reply', body: '' });
    assert.deepEqual(room.commentThreads[0].messages.map((message) => message.body), ['Первый', 'Ответ']);
    assert.throws(() => room.applyJson(socket, { type: 'comment-reply', id: 'thread',
      messageId: 'blank', body: '  ' }), /visible text/u);
    assert.equal(room.commentThreads[0].messages.length, 2);

    room.commentThreads.push({ id: 'filler', messages: [{ body: 'x'.repeat(2 * 1024 * 1024) }] });
    assert.throws(() => room.applyJson(socket, { type: 'comment-create', id: 'over-budget',
      messageId: 'first', body: 'Не сохранить', ...anchors }), /metadata exceeds/u);
    assert.equal(room.commentThreads.some((thread) => thread.id === 'over-budget'), false);
  } finally { room.destroy(); }
});

test('accepted suggestion changes shared text once and reverts to the original', () => {
  const { room, content, socket, anchors } = reviewRoom();
  try {
    room.applyJson(socket, { type: 'suggestion-create', id: 'change',
      originalText: 'old', replacementText: 'new', ...anchors });
    room.applyJson(socket, { type: 'suggestion-accept', id: 'change' });
    assert.equal(content.toString(), 'new');
    assert.equal(room.suggestions[0].status, 'accepted');
    room.applyJson(socket, { type: 'suggestion-revert', id: 'change' });
    assert.equal(content.toString(), 'old');
    assert.equal(room.suggestions[0].status, 'open');
    assert.equal(room.suggestions[0].decidedById, null);
  } finally { room.destroy(); }
});

test('stale suggestion never overwrites text changed after its creation', () => {
  const { room, content, socket, anchors } = reviewRoom();
  try {
    room.applyJson(socket, { type: 'suggestion-create', id: 'stale',
      originalText: 'old', replacementText: 'new', ...anchors });
    content.delete(0, 3);
    content.insert(0, 'other');
    room.applyJson(socket, { type: 'suggestion-accept', id: 'stale' });
    assert.equal(content.toString(), 'other');
    assert.equal(room.suggestions[0].status, 'stale');
  } finally { room.destroy(); }
});
