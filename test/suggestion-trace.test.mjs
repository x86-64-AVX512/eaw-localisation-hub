import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSuggestionTrace, parseSuggestionTrace, suggestionTraceOrigins, suggestionTraceParts,
} from '../packages/shared/src/suggestion-trace.mjs';

test('suggestion trace distinguishes preserved, deleted, and manually inserted letters', () => {
  const original = 'олица';
  const replacement = 'ал';
  const trace = createSuggestionTrace(original, replacement, [4, -1]);
  assert.deepEqual(suggestionTraceParts(original, replacement, trace), [
    { kind: 'delete', text: 'олиц' },
    { kind: 'equal', text: 'а' },
    { kind: 'insert', text: 'л' },
  ]);
  assert.deepEqual(suggestionTraceOrigins(original, replacement, trace, 12), [16, -1]);
});

test('an identical letter that was deleted and retyped remains an insertion', () => {
  const trace = createSuggestionTrace('машина', 'маш', [-1, -1, -1]);
  assert.deepEqual(suggestionTraceParts('машина', 'маш', trace), [
    { kind: 'delete', text: 'машина' },
    { kind: 'insert', text: 'маш' },
  ]);
});

test('suggestion trace preserves astral Unicode code points', () => {
  const original = 'a😂b';
  const replacement = 'a😎b';
  const trace = createSuggestionTrace(original, replacement, [0, -1, -1, 3]);
  assert.deepEqual(suggestionTraceParts(original, replacement, trace), [
    { kind: 'equal', text: 'a' },
    { kind: 'delete', text: '😂' },
    { kind: 'insert', text: '😎' },
    { kind: 'equal', text: 'b' },
  ]);
});

test('malformed or text-mismatched suggestion traces are rejected', () => {
  assert.throws(() => parseSuggestionTrace('not json', 'abc', 'x'), /valid JSON/u);
  assert.throws(() => parseSuggestionTrace('[[0,1]]', 'abc', 'x'), /does not match/u);
  assert.throws(() => parseSuggestionTrace('[[-1,1]]', 'abc', 'xy'), /incomplete/u);
  assert.throws(() => parseSuggestionTrace('[[2,2]]', 'abc', 'bc'), /does not match/u);
});
