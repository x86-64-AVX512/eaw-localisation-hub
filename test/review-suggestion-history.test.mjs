import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuggestionHistory } from '../apps/review/src/suggestion-history.js';

test('suggestion history removes and recreates an automatic review suggestion', () => {
  const sent = [];
  const history = createSuggestionHistory((message) => sent.push(message));
  const action = {
    type: 'suggestionCreate', path: 'x.yml', suggestionId: 'suggestion-1',
    startByte: 10, endByte: 12, replacementBase64: 'WA==',
  };
  history.record(action);
  assert.equal(history.undo('x.yml'), true);
  assert.deepEqual(sent.pop(), { type: 'suggestionDelete', path: 'x.yml', id: 'suggestion-1' });
  assert.equal(history.redo(), true);
  assert.deepEqual(sent.pop(), action);
  assert.equal(history.redo(), false);
});

test('recording after undo discards the abandoned redo branch', () => {
  const sent = [];
  const history = createSuggestionHistory((message) => sent.push(message));
  history.record({ type: 'suggestionCreate', path: 'x', suggestionId: 'one' });
  history.undo('x');
  history.record({ type: 'suggestionCreate', path: 'x', suggestionId: 'two' });
  assert.equal(history.redo(), false);
});
