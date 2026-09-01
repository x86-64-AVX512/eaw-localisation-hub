import assert from 'node:assert/strict';
import test from 'node:test';
import { completedSuggestionZoneAfterLine } from '../apps/review/src/editor-decorations.js';

test('a completed leading-newline replacement is rendered below its original line', () => {
  const range = {
    getStartPosition: () => ({ lineNumber: 6, column: 1 }),
    getEndPosition: () => ({ lineNumber: 6, column: 7 }),
  };
  assert.equal(completedSuggestionZoneAfterLine(range), 6);
});

test('a multiline original renders its replacement after the final original line', () => {
  const range = {
    getStartPosition: () => ({ lineNumber: 6, column: 4 }),
    getEndPosition: () => ({ lineNumber: 8, column: 5 }),
  };
  assert.equal(completedSuggestionZoneAfterLine(range), 8);
});
