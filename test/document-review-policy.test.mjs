import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editableSuggestionDraft,
  newCommentThread,
  newDiscussionMessage,
  newSuggestion,
  suggestionDraft,
} from '../apps/server/src/document-review-policy.mjs';

const alice = { id: 'alice-id', displayName: 'Alice', color: '#abcdef' };
const createdAt = '2026-09-24T00:00:00.000Z';
const anchors = { startRelative: 'AA==', endRelative: 'AQ==' };

test('review discussion policy keeps canonical authors and idempotent message ids', () => {
  const target = { messages: [] };
  const first = newDiscussionMessage(target, alice, {
    messageId: 'message-1', body: 'Комментарий', author: 'Spoofed', color: '#000000',
  }, createdAt);
  assert.deepEqual(first, {
    id: 'message-1', authorId: 'alice-id', author: 'Alice', color: '#abcdef',
    body: 'Комментарий', createdAt,
  });
  target.messages.push(first);
  assert.equal(newDiscussionMessage(target, alice, { messageId: 'message-1', body: '' }), null);
  assert.throws(() => newDiscussionMessage(target, alice, { messageId: 'message-2', body: '   ' }),
    /visible text/u);
  assert.throws(() => newDiscussionMessage(target, alice, { messageId: 'message-2', body: 'x'.repeat(2049) }),
    /protocol limit/u);
  target.messages = Array.from({ length: 100 }, (_, index) => ({ id: String(index) }));
  assert.throws(() => newDiscussionMessage(target, alice, { messageId: '0' }), /message limit/u);
});

test('review policy creates comments and validates anchors without trusting message author', () => {
  const thread = newCommentThread('thread', alice, {
    ...anchors, author: 'Spoofed', color: '#000000',
  }, createdAt);
  assert.equal(thread.authorId, alice.id);
  assert.equal(thread.author, alice.displayName);
  assert.equal(thread.color, alice.color);
  assert.equal(thread.status, 'open');
  assert.deepEqual(thread.messages, []);
  assert.equal(thread.createdAt, createdAt);
  assert.throws(() => newCommentThread('thread', alice, { startRelative: 'AA==' }), /Comment end/u);
});

test('suggestion drafts validate text, trace, and author before mutation', () => {
  const traceJson = JSON.stringify([[-1, 3]]);
  const draft = { ...anchors, originalText: 'old', replacementText: 'new', traceJson };
  assert.deepEqual(suggestionDraft(draft), {
    originalText: 'old', replacementText: 'new', traceJson,
  });
  const suggestion = newSuggestion('suggestion', alice, {
    ...draft, author: 'Spoofed', color: '#000000',
  }, createdAt);
  assert.equal(suggestion.authorId, alice.id);
  assert.equal(suggestion.color, alice.color);
  assert.equal(suggestion.status, 'open');
  assert.equal(suggestion.createdAt, createdAt);
  assert.deepEqual(editableSuggestionDraft(suggestion, alice, draft), draft);
  assert.throws(() => editableSuggestionDraft(suggestion,
    { id: 'bob-id', displayName: 'Alice' }, draft), /Only the suggestion author/u);
  assert.throws(() => suggestionDraft({ originalText: '', replacementText: '' }), /insert or delete/u);
  assert.throws(() => suggestionDraft({ ...draft, traceJson: JSON.stringify([[-1, 4]]) }), /trace/iu);
  assert.throws(() => suggestionDraft({ ...draft, replacementText: 'x'.repeat(16 * 1024 + 1) }),
    /protocol limit/u);
  assert.equal(editableSuggestionDraft({ authorId: null, author: 'Alice' }, alice, draft).originalText, 'old');
});
