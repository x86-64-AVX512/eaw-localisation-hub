import assert from 'node:assert/strict';
import test from 'node:test';
import { textChangeSummary } from '../apps/server/src/notification-summary.mjs';

test('ticket edit summary counts replacements even when total text length is unchanged', () => {
  assert.deepEqual(textChangeSummary('key:0 "cat"', 'key:0 "dog"'), {
    lines: 1, words: 1, characters: 3,
  });
});
