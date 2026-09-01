import assert from 'node:assert/strict';
import test from 'node:test';
import { keyAtLine, lineForKey } from '../apps/review/src/scroll-sync.js';

function modelFrom(lines) {
  return {
    getLineCount: () => lines.length,
    getLineContent: (line) => lines[line - 1] ?? '',
  };
}

test('scroll synchronisation maps localisation keys instead of raw line numbers', () => {
  const russian = modelFrom([
    'l_russian:',
    ' FIRST_KEY:0 "Первый"',
    ' # translator note',
    ' SECOND_KEY:0 "Второй"',
    ' continuation without a key',
  ]);
  const english = modelFrom([
    'l_english:',
    '',
    ' FIRST_KEY:0 "First"',
    '',
    ' SECOND_KEY:0 "Second"',
  ]);

  assert.equal(keyAtLine(russian, 5), 'SECOND_KEY');
  assert.equal(lineForKey(english, 'SECOND_KEY'), 5);
  assert.equal(lineForKey(english, 'MISSING_KEY'), 0);
});
