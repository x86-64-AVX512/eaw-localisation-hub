import assert from 'node:assert/strict';
import test from 'node:test';
import { copyTextToClipboard } from '../apps/review/src/copy-text.ts';

function globals(values) {
  const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  return () => { for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } };
}

test('clipboard API copies complete Unicode text without touching DOM selection', async () => {
  const writes = [];
  const restore = globals({ navigator: { clipboard: { writeText: async (text) => writes.push(text) } },
    document: undefined, window: undefined });
  try {
    await copyTextToClipboard('Комментарий 🦄\nВторая строка.');
    assert.deepEqual(writes, ['Комментарий 🦄\nВторая строка.']);
  } finally { restore(); }
});

function fallbackEnvironment(clipboard, copyResult = true) {
  const calls = [], ranges = [{ id: 1 }, { id: 2 }];
  class Element { focus(options) { calls.push(['focus', options]); } }
  const textarea = { style: {}, select() { calls.push(['select', this.value]); },
    remove() { calls.push(['remove']); } };
  const selection = { rangeCount: 2, getRangeAt: (i) => ({ cloneRange: () => ranges[i] }),
    removeAllRanges() { calls.push(['clearRanges']); }, addRange(range) { calls.push(['range', range]); } };
  const restore = globals({ navigator: { clipboard }, HTMLElement: Element,
    window: { getSelection: () => selection }, document: {
      activeElement: new Element(), createElement(tag) { assert.equal(tag, 'textarea'); return textarea; },
      body: { append(node) { assert.equal(node, textarea); calls.push(['append']); } },
      execCommand(command) { assert.equal(command, 'copy'); if (copyResult instanceof Error) throw copyResult; return copyResult; },
    } });
  return { restore, calls, ranges, textarea };
}

test('missing or denied clipboard falls back and restores focus and all selection ranges', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const env = fallbackEnvironment(clipboard);
    try {
      await copyTextToClipboard('Ответ\n🦄');
      assert.equal(env.textarea.readOnly, true);
      assert.deepEqual(env.calls, [['append'], ['select', 'Ответ\n🦄'], ['remove'],
        ['focus', { preventScroll: true }], ['clearRanges'], ...env.ranges.map((range) => ['range', range])]);
    } finally { env.restore(); }
  }
});

test('failed fallback reports failure but still cleans up and restores selection', async () => {
  for (const failure of [false, new Error('copy failed')]) {
    const env = fallbackEnvironment(undefined, failure);
    try {
      await assert.rejects(copyTextToClipboard('Текст'), /Ctrl\+C|copy failed/);
      assert.deepEqual(env.calls.slice(2), [['remove'], ['focus', { preventScroll: true }],
        ['clearRanges'], ...env.ranges.map((range) => ['range', range])]);
    } finally { env.restore(); }
  }
});
