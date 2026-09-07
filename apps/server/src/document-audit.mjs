import crypto from 'node:crypto';

const ACTIONS = new Set([
  'comment-create', 'comment-reply', 'comment-status', 'comment-delete',
  'suggestion-create', 'suggestion-update', 'suggestion-reply', 'suggestion-accept',
  'suggestion-revert', 'suggestion-reject', 'suggestion-delete',
  'reservation-create', 'reservation-delete', 'git-conflict-resolve',
  'personal-projection-resolve', 'history-restore',
]);
const short = (value, limit = 240) => String(value ?? '').slice(0, limit);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function auditDocumentControl(room, socket, message, operation) {
  const audit = room.registry.auditLog;
  if (!audit || !ACTIONS.has(message?.type) || room.destroyed || socket.readyState !== 1) return operation();
  const actor = room.actorFor(socket, message, 'Audit');
  const item = [...room.commentThreads, ...room.suggestions, ...room.reservations]
    .find((entry) => entry.id === message.id);
  const details = { documentId: room.documentId, objectId: short(message.id, 128) };
  if (item) {
    details.ownerId = short(item.authorId || item.createdById, 256);
    details.previousStatus = short(item.status, 64);
    details.excerpt = short(item.messages?.[0]?.body || item.originalText || item.comment);
  }
  for (const field of ['status', 'choice', 'key']) {
    if (typeof message[field] === 'string') details[field] = short(message[field]);
  }
  return audit.run(actor, message.type, room.documentId, details, operation,
    { destructive: message.type.endsWith('-delete') });
}

export async function auditDocumentEdit(room, socket, data, operation) {
  const audit = room.registry.auditLog;
  if (!audit) return operation();
  await audit.flush();
  const before = room.currentText();
  const result = await operation();
  const after = room.currentText();
  if (before !== after) {
    const actor = socket.identity?.id && room.authStore.required
      ? room.actorFor(socket, {}, 'Audit') : socket.localActor || socket.identity;
    await audit.append(actor, 'document-edit', room.documentId, {
      bytes: data.byteLength, beforeHash: hash(before), afterHash: hash(after),
      previousCharacters: before.length, characters: after.length,
    });
  }
  return result;
}
