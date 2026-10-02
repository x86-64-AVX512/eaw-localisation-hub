import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { reviewFontFamily, loadReviewDashFont } from '../apps/review/src/editor-font.ts';

const css = fs.readFileSync(new URL('../apps/review/src/em-dash-font.css', import.meta.url), 'utf8');
const font = Buffer.from(css.match(/base64,([^"\s]+)/u)[1], 'base64');
function table(tag) {
  for (let index = 0; index < font.readUInt16BE(4); index++) {
    const offset = 12 + index * 16;
    if (font.toString('ascii', offset, offset + 4) === tag) {
      const start = font.readUInt32BE(offset + 8);
      return font.subarray(start, start + font.readUInt32BE(offset + 12));
    }
  }
  throw new Error(`Missing font table: ${tag}`);
}

test('Review display font maps only U+2014, not en dashes or other text', () => {
  assert.match(css, /unicode-range: U\+2014;/u);
  const cmap = table('cmap');
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const subtable = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
    assert.equal(subtable.readUInt16BE(0), 4);
    const segments = subtable.readUInt16BE(6) / 2;
    assert.equal(segments, 2);
    assert.equal(subtable.readUInt16BE(14), 0x2014);
    assert.equal(subtable.readUInt16BE(16 + segments * 2), 0x2014);
    assert.equal(subtable.readUInt16BE(16), 0xffff);
  }
  assert.equal(table('maxp').readUInt16BE(4), 2, 'only .notdef and the em dash');
  assert.equal(table('hmtx').readUInt16BE(0), 1000);
  const glyph = table('glyf');
  assert.equal(glyph.readInt16BE(6) - glyph.readInt16BE(2), 900, 'visible bar is 0.9 em, not a stretched DOM overlay');
});

test('all chosen editor fonts retain their family and use the same em-dash-only face', () => {
  for (const family of ['Consolas', 'Courier New', 'Lucida Console']) {
    assert.equal(reviewFontFamily(family), `"EaW Em Dash", ${family}, Consolas, monospace`);
  }
});

test('font loads before measurement and a failed display font does not block Review', async () => {
  const original = globalThis.document;
  const calls = [];
  try {
    globalThis.document = { fonts: { load: async (...args) => { calls.push(args); } } };
    await loadReviewDashFont();
    assert.deepEqual(calls, [['15px "EaW Em Dash"', '—']]);
    globalThis.document.fonts.load = async () => { throw new Error('font unavailable'); };
    await assert.doesNotReject(loadReviewDashFont());
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
