import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { utf16IndexToUtf8ByteOffset } from '../../../packages/shared/src/text.mjs';

export function resolveReviewAnchors(binding, client, message) {
  if (!message.reviewAnchors) return message;
  if (client.kind !== 'review' || !client.reviewCrdt) throw new Error('CRDT anchors require a Review peer');
  const anchors = JSON.parse(message.reviewAnchors);
  if (anchors.documentId !== binding.documentId) return null;
  const resolved = { ...message };
  const indexes = {};
  const source = binding.text.toString();
  for (const [field, encoded] of Object.entries(anchors.positions ?? {})) {
    if (!['startByte', 'endByte', 'positionByte', 'anchorByte'].includes(field)
      || !Number.isSafeInteger(message[field])) throw new Error('Invalid Review anchor field');
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(encoded, 'base64')), binding.document,
    );
    if (!position || position.type !== binding.text) return null;
    indexes[field] = position.index;
    resolved[field] = utf16IndexToUtf8ByteOffset(source, position.index);
  }
  if (anchors.expectedText !== undefined
    && source.slice(indexes.startByte, indexes.endByte) !== anchors.expectedText) return null;
  return resolved;
}

export function broadcastReviewUpdate(binding, update, origin) {
  for (const client of binding.clients) {
    if (client.kind !== 'review' || !client.reviewCrdt) continue;
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.reviewSynced || origin === state.origin) continue;
      client.send({ type: 'documentSync', path: absolutePath, documentId: binding.documentId,
        updateBase64: Buffer.from(update).toString('base64') });
    }
  }
}

export function applyReviewUpdate(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  if (client.kind !== 'review' || !client.reviewCrdt || !state.initialised
    || !binding.gitWritable || message.documentId !== binding.documentId) return false;
  Y.applyUpdate(binding.document, Buffer.from(message.updateBase64, 'base64'), state.origin);
  state.mirror = binding.text.toString();
  return true;
}
