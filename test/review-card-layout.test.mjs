import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewCardLayout } from '../apps/review/src/review-card-layout.ts';
import { reviewCardFingerprint } from '../apps/review/src/review-cards.ts';

test('moving a card anchor does not invalidate its rendered contents', () => {
  const item = { id: 'comment-1', kind: 'comment', summaryBase64: 'dGV4dA==', startByte: 10, endByte: 20 };
  const fingerprint = reviewCardFingerprint(item, [], '', 'user-1');
  assert.equal(reviewCardFingerprint({ ...item, startByte: 30, endByte: 40 }, [], '', 'user-1'), fingerprint);
  assert.notEqual(reviewCardFingerprint({ ...item, summaryBase64: 'bmV3' }, [], '', 'user-1'), fingerprint);
});

test('review cards share one frame and measure every height before positioning', () => {
  const originalDocument = globalThis.document;
  const originalFrame = globalThis.requestAnimationFrame;
  const frames = [];
  const operations = [];
  const rect = (top = 0) => ({ top, bottom: top + 500, left: 0, right: 500, height: 500 });
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.document = {
    querySelector: () => ({ getBoundingClientRect: () => rect() }),
    createDocumentFragment: () => ({ append() {} }),
    createElementNS: () => ({ setAttribute() {} }),
  };
  try {
    const card = (startByte) => ({
      dataset: { startByte: String(startByte) },
      get offsetHeight() { operations.push(`measure:${startByte}`); return 40; },
      style: {
        set top(value) { operations.push(`position:${startByte}:${value}`); },
        getPropertyValue: () => '#fff',
      },
    });
    const cards = { children: [card(0), card(1)], style: {}, getBoundingClientRect: () => rect() };
    const lane = { getBoundingClientRect: () => rect(), scrollHeight: 500, clientHeight: 500, scrollTop: 0 };
    const editor = {
      getTopForLineNumber: (line) => (line - 1) * 24,
      getScrolledVisiblePosition: () => ({ top: 0, height: 24 }),
      getContentHeight: () => 200,
      getScrollTop: () => 0,
    };
    const layout = createReviewCardLayout({
      state: { path: 'file.yml' }, editor, cards, lane,
      rangeFromBytes: (start) => ({ getStartPosition: () => ({ lineNumber: start + 1 }) }),
      connectors: { replaceChildren() {} },
    });
    layout.layout();
    layout.layout();
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.deepEqual(operations, [
      'measure:0', 'measure:1', 'position:0:46px', 'position:1:94px',
    ]);
    layout.layout();
    assert.equal(frames.length, 1, 'a later event can schedule the next frame');
  } finally {
    globalThis.document = originalDocument;
    globalThis.requestAnimationFrame = originalFrame;
  }
});
