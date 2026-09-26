import * as Y from 'yjs';
import { singleReplacement } from './editing-mode.ts';
import { byteToUtf16 } from './review-utilities.ts';

const REMOTE = Symbol('agent');
const encode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export interface ReviewDocumentMessage {
  type: string;
  [field: string]: unknown;
}

export interface ReviewDocumentUpdate {
  documentId: string;
  path: string;
  updateBase64: string;
}

export interface ReviewTextEdit {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface ReviewDocumentOptions {
  send: (message: ReviewDocumentMessage) => void;
  onText: (text: string) => void;
  beforeChange?: () => void;
}

// The browser is a CRDT peer. Updates refer to character identities, never to
// positions in an Agent mirror that may already include another user's edits.
export function createReviewDocument({ send, onText, beforeChange = () => {} }: ReviewDocumentOptions) {
  let document: Y.Doc | null = null;
  let documentId = '';
  let path = '';
  function sendUpdate(update: Uint8Array): void {
    send({ type: 'reviewUpdate', path, documentId, updateBase64: encode(update) });
  }
  return {
    anchor<T extends ReviewDocumentMessage>(message: T): T | (T & { reviewAnchors: string }) {
      if (!document || message.type === 'edit') return message;
      const text = document.getText('content');
      const source = text.toString();
      const positions: Record<string, string> = {};
      for (const field of ['startByte', 'endByte', 'positionByte', 'anchorByte']) {
        const value = message[field];
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue;
        const offset = byteToUtf16(source, value);
        const assoc = field === 'endByte' && typeof message.startByte === 'number'
          && value > message.startByte ? -1 : 0;
        positions[field] = encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, assoc)));
      }
      if (!Object.keys(positions).length) return message;
      const anchors: { documentId: string; positions: Record<string, string>; expectedText?: string } = {
        documentId, positions,
      };
      if (['suggestionCreate', 'suggestionUpdate'].includes(message.type)
        && typeof message.startByte === 'number' && typeof message.endByte === 'number') {
        anchors.expectedText = source.slice(byteToUtf16(source, message.startByte), byteToUtf16(source, message.endByte));
      }
      return { ...message, reviewAnchors: JSON.stringify(anchors) };
    },
    receive(message: ReviewDocumentUpdate): void {
      if (!document || message.documentId !== documentId) {
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
    commit(nextText: string, changes: readonly ReviewTextEdit[] | null = null): boolean {
      if (!document) return false;
      const text = document.getText('content');
      const previous = text.toString();
      const edits = Array.isArray(changes) && changes.length
        ? [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
        : (() => {
            const change = singleReplacement(previous, nextText);
            return change ? [{ rangeOffset: change.start,
              rangeLength: change.previousEnd - change.start, text: change.replacement }] : [];
          })();
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
