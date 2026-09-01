import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { keysInsideRange, utf8ByteOffsetToUtf16Index } from '../../../packages/shared/src/text.mjs';

function encodeRelativePosition(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

export function createSuggestionAnchors(text, start, end) {
  return {
    // Boundary edits belong outside the suggestion: a prefix moves the start
    // forward, while a suffix stays after the anchored end.
    startRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    endRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, end, -1)),
  };
}

export function createReservation(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  let startByte = Number(message.startByte);
  let endByte = Number(message.endByte);
  if (startByte > endByte) [startByte, endByte] = [endByte, startByte];
  const start = utf8ByteOffsetToUtf16Index(state.mirror, startByte);
  const end = utf8ByteOffsetToUtf16Index(state.mirror, endByte);
  const initialKeys = keysInsideRange(state.mirror, start, end);
  if (start === end) {
    client.send({ type: 'notice', message: 'Сначала выделите хотя бы один ключ локализации.' });
    return;
  }
  if (initialKeys.length === 0) {
    client.send({ type: 'notice', message: 'В выделении не найдено ключей локализации.' });
    return;
  }
  binding.socket.send(JSON.stringify({
    type: 'reservation-create',
    id: crypto.randomUUID(),
    assigneeId: String(message.assigneeId ?? ''),
    assignee: String(message.assignee ?? binding.hub.options.user),
    assigneeColor: String(message.assigneeColor ?? binding.hub.options.color),
    color: binding.hub.options.color,
    comment: String(message.comment ?? ''),
    startRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, start, -1)),
    endRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, end, 0)),
    initialKeys,
  }));
  client.send({ type: 'notice', message: `Бронь для ${initialKeys.length} ключ(а/ей) создана.` });
}

export function deleteReservationAt(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  const caret = utf8ByteOffsetToUtf16Index(state.mirror, Number(message.positionByte));
  for (const reservation of binding.reservations.values()) {
    const resolved = binding.resolveReservation(reservation);
    if (resolved && caret >= resolved.start && caret <= resolved.end) {
      binding.deleteReservation(client, absolutePath, { id: reservation.id });
      return;
    }
  }
  client.send({ type: 'notice', message: 'Под курсором нет брони.' });
}

export function deleteReservation(binding, client, absolutePath, message) {
  binding.requireState(client, absolutePath);
  const id = String(message.id ?? '');
  if (!binding.reservations.has(id)) {
    client.send({ type: 'notice', message: 'Выбранная бронь уже удалена.' });
    return;
  }
  binding.socket.send(JSON.stringify({ type: 'reservation-delete', id }));
  client.send({ type: 'notice', message: 'Бронь удалена.' });
}

export function createComment(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  let startByte = Number(message.startByte);
  let endByte = Number(message.endByte);
  if (startByte > endByte) [startByte, endByte] = [endByte, startByte];
  const start = utf8ByteOffsetToUtf16Index(state.mirror, startByte);
  const end = utf8ByteOffsetToUtf16Index(state.mirror, endByte);
  const body = Buffer.from(String(message.bodyBase64 ?? ''), 'base64').toString('utf8');
  if (!body.trim()) {
    client.send({ type: 'notice', message: 'Комментарий не может быть пустым.' });
    return;
  }
  if (Buffer.byteLength(body, 'utf8') > 2048) {
    client.send({ type: 'notice', message: 'Комментарий превышает лимит 2 КиБ.' });
    return;
  }
  binding.socket.send(JSON.stringify({
    type: 'comment-create',
    id: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    author: binding.hub.options.user,
    color: binding.hub.options.color,
    body,
    startRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, start, -1)),
    endRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, end, 0)),
  }));
  client.send({ type: 'notice', message: 'Комментарий создан.' });
}

export function replyToDiscussion(binding, client, absolutePath, message, targetType) {
  binding.requireState(client, absolutePath);
  const collection = targetType === 'comment' ? binding.commentThreads : binding.suggestions;
  const id = String(message.id ?? '');
  if (!collection.has(id)) {
    client.send({ type: 'notice', message: 'Обсуждение уже удалено.' });
    return;
  }
  const body = Buffer.from(String(message.bodyBase64 ?? ''), 'base64').toString('utf8');
  if (!body.trim() || Buffer.byteLength(body, 'utf8') > 2048) {
    client.send({ type: 'notice', message: 'Ответ должен содержать текст и занимать не более 2 КиБ.' });
    return;
  }
  binding.socket.send(JSON.stringify({
    type: `${targetType}-reply`, id, messageId: crypto.randomUUID(),
    author: binding.hub.options.user, color: binding.hub.options.color, body,
  }));
}

export function setCommentStatus(binding, client, absolutePath, message) {
  binding.requireState(client, absolutePath);
  binding.socket.send(JSON.stringify({
    type: 'comment-status', id: String(message.id ?? ''),
    status: message.status === 'resolved' ? 'resolved' : 'open',
  }));
}

export function deleteReviewItem(binding, client, absolutePath, message, targetType) {
  binding.requireState(client, absolutePath);
  binding.socket.send(JSON.stringify({ type: `${targetType}-delete`, id: String(message.id ?? '') }));
}

export function createSuggestion(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  let startByte = Number(message.startByte);
  let endByte = Number(message.endByte);
  if (startByte > endByte) [startByte, endByte] = [endByte, startByte];
  const start = utf8ByteOffsetToUtf16Index(state.mirror, startByte);
  const end = utf8ByteOffsetToUtf16Index(state.mirror, endByte);
  const originalText = state.mirror.slice(start, end);
  const replacementText = Buffer.from(String(message.replacementBase64 ?? ''), 'base64').toString('utf8');
  if (Buffer.byteLength(originalText, 'utf8') > 16 * 1024
      || Buffer.byteLength(replacementText, 'utf8') > 16 * 1024) {
    client.send({ type: 'notice', message: 'Исходный и предложенный фрагменты ограничены 16 КиБ.' });
    return;
  }
  if (!originalText && !replacementText) {
    client.send({ type: 'notice', message: 'Пустая правка не создаётся.' });
    return;
  }
  if (originalText === replacementText) {
    client.send({ type: 'notice', message: 'Предложенный текст не отличается от исходного.' });
    return;
  }
  const anchors = createSuggestionAnchors(binding.text, start, end);
  binding.socket.send(JSON.stringify({
    type: 'suggestion-create', id: String(message.suggestionId || crypto.randomUUID()),
    author: binding.hub.options.user, color: binding.hub.options.color,
    ...anchors,
    originalText, replacementText,
    traceJson: String(message.traceJson ?? ''),
  }));
  client.send({ type: 'notice', message: 'Предлагаемая правка создана.' });
}

export function updateSuggestion(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  let startByte = Number(message.startByte);
  let endByte = Number(message.endByte);
  if (startByte > endByte) [startByte, endByte] = [endByte, startByte];
  const start = utf8ByteOffsetToUtf16Index(state.mirror, startByte);
  const end = utf8ByteOffsetToUtf16Index(state.mirror, endByte);
  const originalText = state.mirror.slice(start, end);
  const replacementText = Buffer.from(String(message.replacementBase64 ?? ''), 'base64').toString('utf8');
  if (Buffer.byteLength(originalText, 'utf8') > 16 * 1024
      || Buffer.byteLength(replacementText, 'utf8') > 16 * 1024
      || (!originalText && !replacementText)
      || originalText === replacementText) return;
  const anchors = createSuggestionAnchors(binding.text, start, end);
  binding.socket.send(JSON.stringify({
    type: 'suggestion-update', id: String(message.suggestionId),
    author: binding.hub.options.user, color: binding.hub.options.color,
    ...anchors,
    originalText, replacementText,
    traceJson: String(message.traceJson ?? ''),
  }));
}

export function decideSuggestion(binding, client, absolutePath, message, decision) {
  binding.requireState(client, absolutePath);
  binding.socket.send(JSON.stringify({
    type: `suggestion-${decision}`, id: String(message.id ?? ''), author: binding.hub.options.user,
  }));
}
