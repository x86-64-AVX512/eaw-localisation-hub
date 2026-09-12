import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import {
  captureReviewAnchor,
  repairReviewAnchors,
  resolveReviewRange,
} from '../apps/server/src/review-anchors.mjs';

function encoded(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

function anchoredItem(text, source, start, end) {
  return {
    startRelative: encoded(Y.createRelativePositionFromTypeIndex(text, start, -1)),
    endRelative: encoded(Y.createRelativePositionFromTypeIndex(text, end, 0)),
  };
}

test('review anchors follow a localisation key across a full document replacement', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const original = 'l_russian:\n first:0 "One"\n second:0 "Two"\n';
  text.insert(0, original);
  const start = original.indexOf('Two');
  const item = anchoredItem(text, original, start, start + 3);
  assert.equal(captureReviewAnchor(document, item), true);

  text.delete(0, text.length);
  text.insert(0, 'l_russian:\n first:0 "Changed"\n second:0 "Still here"\n');
  assert.deepEqual(resolveReviewRange(document, item), { start: 0, end: 0 });
  assert.equal(repairReviewAnchors(document, [item], { force: true }), true);

  const range = resolveReviewRange(document, item);
  assert.ok(range.start > text.toString().indexOf('second:0'));
  assert.ok(range.end > range.start);
  assert.equal(item.orphaned, undefined);
});

test('review anchors become orphaned when their key and context disappear', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const original = 'l_russian:\n unique_key:0 "Unique value"\n';
  text.insert(0, original);
  const start = original.indexOf('Unique value');
  const item = anchoredItem(text, original, start, start + 'Unique value'.length);
  captureReviewAnchor(document, item);

  text.delete(0, text.length);
  text.insert(0, 'l_russian:\n other:0 "Other"\n');
  repairReviewAnchors(document, [item], { force: true });
  assert.equal(item.orphaned, true);
  assert.equal(resolveReviewRange(document, item), null);
});

test('empty suggestion anchors retain their insertion point after full replacement', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const original = 'l_russian:\n target:0 "Value"\n';
  text.insert(0, original);
  const position = original.indexOf('Value');
  const item = anchoredItem(text, original, position, position);
  captureReviewAnchor(document, item);

  text.delete(0, text.length);
  text.insert(0, 'l_russian:\n target:0 "Changed value"\n');
  repairReviewAnchors(document, [item], { force: true });
  const range = resolveReviewRange(document, item);
  assert.equal(range.start, range.end);
  assert.ok(range.start > text.toString().indexOf('target:0'));
});

test('review anchors use surrounding context outside localisation entries', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const original = 'header before OLD BLOCK footer after';
  text.insert(0, original);
  const start = original.indexOf('OLD BLOCK');
  const item = anchoredItem(text, original, start, start + 'OLD BLOCK'.length);
  captureReviewAnchor(document, item);

  text.delete(0, text.length);
  text.insert(0, 'header before NEW BLOCK footer after');
  repairReviewAnchors(document, [item], { force: true });
  const range = resolveReviewRange(document, item);
  assert.equal(text.toString().slice(range.start, range.end), 'NEW BLOCK');
});
