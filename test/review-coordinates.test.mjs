import test from 'node:test';
import assert from 'node:assert/strict';
import { byteToUtf16, utf16ToByte } from '../apps/review/src/review-utilities.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('cached Review byte coordinates match whole-text conversion across Unicode and checkpoint boundaries', () => {
  for (const text of [
    '', 'ASCII §YПривет§! 👑\n[Root.GetName]',
    `${'а'.repeat(4095)}👑${'б'.repeat(4200)}\n`,
    `${'x'.repeat(4095)}👑${'y'.repeat(4098)}`,
  ]) {
    const bytes = encoder.encode(text);
    const offsets = new Set([0, bytes.length]);
    for (let index = 0; index < bytes.length; index += 97) offsets.add(index);
    for (const offset of offsets) {
      assert.equal(byteToUtf16(text, offset), decoder.decode(bytes.slice(0, offset)).length);
    }
    const positions = new Set([0, text.length]);
    for (let index = 0; index < text.length; index += 97) positions.add(index);
    for (const index of positions) {
      assert.equal(utf16ToByte(text, index), encoder.encode(text.slice(0, index)).length);
    }
  }
  assert.throws(() => byteToUtf16('аб', 5), RangeError);
});
