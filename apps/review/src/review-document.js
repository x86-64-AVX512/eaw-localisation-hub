import * as Y from 'yjs';
import { singleReplacement } from './editing-mode.js';
import { byteToUtf16 } from './review-utilities.js';

const REMOTE = Symbol('agent');
const encode = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

// The browser is a CRDT peer. Updates refer to character identities, never to
// positions in an Agent mirror that may already include another user's edits.
export function createReviewDocument({ send, onText, beforeChange = () => {} }) {
  let document = null;
  let documentId = '';
  let path = '';
  function sendUpdate(update) {
    send({ type: 'reviewUpdate', path, documentId, updateBase64: encode(update) });
  }
  return {
    anchor(message) {
      if (!document || message.type === 'edit') return message;
      const text = document.getText('content');
      const source = text.toString();
      const positions = {};
      for (const field of ['startByte', 'endByte', 'positionByte', 'anchorByte']) {
        if (!Number.isSafeInteger(message[field])) continue;
        const offset = byteToUtf16(source, message[field]);
        const assoc = field === 'endByte' && message.endByte > message.startByte ? -1 : 0;
        positions[field] = encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, assoc)));
      }
      if (!Object.keys(positions).length) return message;
      const anchors = { documentId, positions };
      if (['suggestionCreate', 'suggestionUpdate'].includes(message.type)) {
        anchors.expectedText = source.slice(byteToUtf16(source, message.startByte), byteToUtf16(source, message.endByte));
      }
      return { ...message, reviewAnchors: JSON.stringify(anchors) };
    },
    receive(message) {
      if (message.documentId !== documentId) {
        document?.destroy();
        document = new Y.Doc();
        documentId = message.documentId;
        document.on('update', (update, origin) => {
          if (origin !== REMOTE) sendUpdate(update);
        });
      }
      path = message.path;
      beforeChange();
      Y.applyUpdate(document, decode(message.updateBase64), REMOTE);
      onText(document.getText('content').toString());
    },
    commit(nextText, changes = null) {
      if (!document) return false;
      const text = document.getText('content');
      const previous = text.toString();
      const change = singleReplacement(previous, nextText);
      const edits = Array.isArray(changes) && changes.length
        ? [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
        : change ? [{ rangeOffset: change.start, rangeLength: change.previousEnd - change.start, text: change.replacement }] : [];
      // Monaco can queue several ordered content events while getValue() already
      // exposes the final model. Apply each event, not that future snapshot.
      for (const edit of edits) {
        if (!Number.isSafeInteger(edit.rangeOffset) || !Number.isSafeInteger(edit.rangeLength)
          || edit.rangeOffset < 0 || edit.rangeLength < 0
          || edit.rangeOffset + edit.rangeLength > previous.length) {
          throw new Error('Editor change is outside the CRDT document');
        }
      }
      if (edits.length) document.transact(() => {
        for (const edit of edits) {
          if (edit.rangeLength) text.delete(edit.rangeOffset, edit.rangeLength);
          if (edit.text) text.insert(edit.rangeOffset, edit.text);
        }
      });
      return true;
    },
    replay() {
      if (document) sendUpdate(Y.encodeStateAsUpdate(document));
    },
    text() { return document?.getText('content').toString() ?? null; },
    dispose() { document?.destroy(); },
  };
}
