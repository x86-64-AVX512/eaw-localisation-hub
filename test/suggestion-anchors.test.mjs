import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { createSuggestionAnchors } from '../apps/agent/src/document-actions.mjs';

function resolve(encoded, document) {
  return Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(encoded, 'base64')),
    document,
  ).index;
}

test('suggestion anchors exclude new lines inserted at either word boundary', () => {
  for (const side of ['left', 'right']) {
    const document = new Y.Doc();
    const text = document.getText('content');
    text.insert(0, 'document');
    const anchors = createSuggestionAnchors(text, 0, 'document'.length);
    text.insert(side === 'left' ? 0 : text.length, '\n');
    const start = resolve(anchors.startRelative, document);
    const end = resolve(anchors.endRelative, document);
    assert.equal(text.toString().slice(start, end), 'document', `${side} boundary moved the range`);
  }
});
