import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewItemsAtByte } from '../apps/review/src/review-navigation.js';

test('review navigation prefers the narrowest overlapping discussion range', () => {
  const state = {
    comments: new Map([
      ['wide', { id: 'wide', startByte: 10, endByte: 30, status: 'open' }],
      ['closed', { id: 'closed', startByte: 15, endByte: 16, status: 'resolved' }],
    ]),
    suggestions: new Map([
      ['narrow', { id: 'narrow', startByte: 14, endByte: 18, status: 'open' }],
    ]),
  };
  assert.deepEqual(
    reviewItemsAtByte(state, 16).map(({ kind, id }) => `${kind}:${id}`),
    ['suggestion:narrow', 'comment:wide'],
  );
  assert.deepEqual(reviewItemsAtByte(state, 31), []);
});
