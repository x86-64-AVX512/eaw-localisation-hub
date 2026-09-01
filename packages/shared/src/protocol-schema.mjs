import { Buffer } from 'node:buffer';

const text = (maximumBytes, required = true) => ({ kind: 'string', maximumBytes, required });
const integer = (maximum = Number.MAX_SAFE_INTEGER, required = true) => ({ kind: 'integer', minimum: 0, maximum, required });

const pathField = text(32 * 1024);
const idField = text(256);
const base64Field = text(12 * 1024 * 1024);
const positionField = integer(0x7fffffff);

const pluginSchemas = Object.freeze({
  hello: { clientId: idField, version: text(64), protocol: integer(1000), proof: text(128) },
  open: { path: pathField, textBase64: base64Field, ticketId: text(64, false) },
  activate: { path: pathField, positionByte: positionField, anchorByte: positionField },
  deactivate: { path: pathField },
  close: { path: pathField },
  edit: { path: pathField, positionByte: positionField, deleteBytes: positionField, insertBase64: base64Field },
  snapshot: { path: pathField, textBase64: base64Field },
  cursor: { path: pathField, positionByte: positionField, anchorByte: positionField },
  undo: { path: pathField },
  redo: { path: pathField },
  reviewOpen: { path: pathField },
  reservationCreate: {
    path: pathField, startByte: positionField, endByte: positionField,
    assigneeId: text(256, false), assignee: text(256, false), assigneeColor: text(32, false),
    comment: text(2048, false),
  },
  reservationDeleteAt: { path: pathField, positionByte: positionField },
  reservationDelete: { path: pathField, id: idField },
  commentCreate: { path: pathField, startByte: positionField, endByte: positionField, bodyBase64: base64Field },
  commentReply: { path: pathField, id: idField, bodyBase64: base64Field },
  commentStatus: { path: pathField, id: idField, status: text(32) },
  commentDelete: { path: pathField, id: idField },
  suggestionCreate: {
    path: pathField, startByte: positionField, endByte: positionField,
    replacementBase64: base64Field, suggestionId: text(256, false), traceJson: text(64 * 1024, false),
  },
  suggestionUpdate: {
    path: pathField, startByte: positionField, endByte: positionField,
    replacementBase64: base64Field, suggestionId: idField, traceJson: text(64 * 1024, false),
  },
  suggestionReply: { path: pathField, id: idField, bodyBase64: base64Field },
  suggestionAccept: { path: pathField, id: idField },
  suggestionRevert: { path: pathField, id: idField },
  suggestionReject: { path: pathField, id: idField },
  suggestionDelete: { path: pathField, id: idField },
  avatarSet: { path: pathField, avatarBase64: text(24 * 1024) },
  avatarDelete: { path: pathField },
  recoveryIssue: {},
  recoveryConfirm: { recoveryCode: text(256) },
  recoveryDiscard: {},
  externalConflictResolve: {
    path: pathField, key: text(4096), choice: text(32), source: text(32, false),
  },
  historyRequest: { path: pathField, id: idField },
  historyRestore: { path: pathField, id: idField, headId: idField },
  personalFileMaterialize: { path: pathField, mode: text(32) },
  documentVariantRequest: { path: pathField, authorId: idField },
});

function validateField(message, name, specification) {
  const value = message[name];
  if (value === undefined) {
    if (specification.required) throw new TypeError(`Protocol field '${name}' is required`);
    return;
  }
  if (specification.kind === 'string') {
    if (typeof value !== 'string') throw new TypeError(`Protocol field '${name}' must be a string`);
    if (Buffer.byteLength(value, 'utf8') > specification.maximumBytes) {
      throw new RangeError(`Protocol field '${name}' exceeds its byte limit`);
    }
    return;
  }
  if (!Number.isSafeInteger(value) || value < specification.minimum || value > specification.maximum) {
    throw new TypeError(`Protocol field '${name}' must be an integer in the accepted range`);
  }
}

export function validatePluginMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Plugin IPC message must be a JSON object');
  }
  if (typeof message.type !== 'string' || !message.type || Buffer.byteLength(message.type, 'utf8') > 64) {
    throw new TypeError("Protocol field 'type' must be a short non-empty string");
  }
  const schema = pluginSchemas[message.type];
  if (!schema) throw new TypeError(`Unknown plugin message type: ${message.type}`);
  if (Object.keys(message).length > Object.keys(schema).length + 1) {
    const known = new Set(['type', ...Object.keys(schema)]);
    const unknown = Object.keys(message).filter((key) => !known.has(key));
    if (unknown.length) throw new TypeError(`Unknown protocol field: ${unknown[0]}`);
  }
  for (const [name, specification] of Object.entries(schema)) validateField(message, name, specification);
  return message;
}

export const pluginMessageTypes = Object.freeze(Object.keys(pluginSchemas));

function serverRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function serverString(value, label, maximumBytes = 4096, { optional = false } = {}) {
  if (value == null && optional) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function serverArray(value, label, maximumItems) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  return value;
}

function validateDirectoryUser(value) {
  const user = serverRecord(value, 'Directory user');
  serverString(user.id, 'Directory user id', 256);
  serverString(user.displayName, 'Directory display name', 256);
  serverString(user.color, 'Directory color', 32);
  serverString(user.avatarBase64 ?? '', 'Directory avatar', 24 * 1024);
  if (user.roles !== undefined) {
    for (const role of serverArray(user.roles, 'Directory roles', 8)) serverString(role, 'Directory role', 64);
  }
}

function validateIdentity(value) {
  const identity = serverRecord(value, 'Identity');
  serverString(identity.id, 'Identity id', 256);
  serverString(identity.displayName, 'Identity display name', 256, { optional: true });
  serverString(identity.avatarBase64 ?? '', 'Identity avatar', 24 * 1024);
  for (const role of serverArray(identity.roles ?? [], 'Identity roles', 8)) serverString(role, 'Identity role', 64);
}

function validatePresence(value) {
  const presence = serverRecord(value, 'Presence');
  serverString(presence.clientId, 'Presence client id', 256);
  serverString(presence.user, 'Presence user', 256);
  serverString(presence.color, 'Presence color', 32);
  serverString(presence.caretRelative, 'Presence caret', 4096);
  serverString(presence.anchorRelative, 'Presence anchor', 4096);
}

function validateReservation(value) {
  const reservation = serverRecord(value, 'Reservation');
  serverString(reservation.id, 'Reservation id', 256);
  serverString(reservation.assignee, 'Reservation assignee', 256);
  serverString(reservation.color, 'Reservation color', 32);
  serverString(reservation.startRelative, 'Reservation start', 4096);
  serverString(reservation.endRelative, 'Reservation end', 4096);
  serverArray(reservation.initialKeys ?? [], 'Reservation keys', 1000)
    .forEach((key) => serverString(key, 'Reservation key', 4096));
}

function validateDiscussionMessage(value) {
  const message = serverRecord(value, 'Discussion message');
  serverString(message.author, 'Discussion author', 256);
  serverString(message.color, 'Discussion color', 32);
  serverString(message.body, 'Discussion body', 2048);
  serverString(message.createdAt ?? '', 'Discussion date', 64);
}

function validateReviewItem(value, kind) {
  const item = serverRecord(value, kind);
  serverString(item.id, `${kind} id`, 256);
  serverString(item.author, `${kind} author`, 256);
  serverString(item.color, `${kind} color`, 32);
  serverString(item.status, `${kind} status`, 32);
  serverString(item.createdAt ?? '', `${kind} date`, 64);
  serverString(item.startRelative, `${kind} start`, 4096);
  serverString(item.endRelative, `${kind} end`, 4096);
  for (const message of serverArray(item.messages ?? [], `${kind} messages`, 100)) validateDiscussionMessage(message);
  if (kind === 'Suggestion') {
    serverString(item.originalText, 'Suggestion original text', 16 * 1024);
    serverString(item.replacementText, 'Suggestion replacement text', 16 * 1024);
    serverString(item.traceJson ?? '', 'Suggestion trace', 64 * 1024);
  }
}

function validateHistoryEntry(value) {
  const entry = serverRecord(value, 'History entry');
  serverString(entry.id, 'History id', 256);
  serverString(entry.author, 'History author', 256);
  serverString(entry.color, 'History color', 32);
  serverString(entry.reason, 'History reason', 32);
  serverString(entry.createdAt, 'History creation date', 64);
  serverString(entry.updatedAt, 'History update date', 64);
}

export function validateServerMessage(message) {
  serverRecord(message, 'Server message');
  const type = serverString(message.type, 'Server message type', 64);
  if (type === 'synced') {
    if (!Number.isSafeInteger(message.protocol) || message.protocol < 0 || message.protocol > 1000) {
      throw new TypeError('Server protocol version must be an integer');
    }
    serverString(message.version, 'Server version', 64);
    serverString(message.documentId, 'Server document id', 1024);
    if (typeof message.canSeed !== 'boolean') throw new TypeError('Server canSeed must be boolean');
    for (const item of serverArray(message.reservations, 'Server reservations', 500)) validateReservation(item);
    for (const item of serverArray(message.commentThreads, 'Server comments', 500)) validateReviewItem(item, 'Comment');
    for (const item of serverArray(message.suggestions, 'Server suggestions', 500)) validateReviewItem(item, 'Suggestion');
    for (const item of serverArray(message.history ?? [], 'Server history', 100)) validateHistoryEntry(item);
    serverString(message.historyHeadId ?? '', 'History head id', 256);
    for (const item of serverArray(message.presences, 'Server presences', 256)) validatePresence(item);
    for (const item of serverArray(message.directory, 'Server directory', 256)) validateDirectoryUser(item);
    if (message.identity !== null) validateIdentity(message.identity);
    if (message.git !== null && message.git !== undefined) {
      const git = serverRecord(message.git, 'Server Git state');
      serverString(git.status, 'Git status', 32);
      serverString(git.branch, 'Git branch', 256);
      serverString(git.localHead ?? '', 'Local Git head', 128);
      serverString(git.remoteHead, 'Remote Git head', 128);
      serverString(git.localBlob ?? '', 'Local Git blob', 128);
      serverString(git.remoteBlob ?? '', 'Remote Git blob', 128);
      serverString(git.reason ?? '', 'Git status reason', 64);
      for (const file of serverArray(git.changedFiles ?? [], 'Changed Git files', 500)) {
        serverString(file, 'Changed Git file', 1024);
      }
      if (!Number.isSafeInteger(git.checkedAt) || git.checkedAt < 0) throw new TypeError('Git check date must be an integer');
    }
    return message;
  }
  if (type === 'git-status') {
    serverString(message.status, 'Git status', 32);
    serverString(message.branch, 'Git branch', 256);
    serverString(message.localHead ?? '', 'Local Git head', 128);
    serverString(message.remoteHead, 'Remote Git head', 128);
    serverString(message.localBlob ?? '', 'Local Git blob', 128);
    serverString(message.remoteBlob ?? '', 'Remote Git blob', 128);
    serverString(message.reason ?? '', 'Git status reason', 64);
    for (const file of serverArray(message.changedFiles ?? [], 'Changed Git files', 500)) {
      serverString(file, 'Changed Git file', 1024);
    }
    for (const value of serverArray(message.conflicts ?? [], 'Git conflicts', 1000)) {
      const conflict = serverRecord(value, 'Git conflict');
      serverString(conflict.key, 'Git conflict key', 512);
      serverString(conflict.label, 'Git conflict label', 1024);
      serverString(conflict.detail, 'Git conflict detail', 4096);
      serverString(conflict.baseLine ?? '', 'Git conflict base line', 64 * 1024);
      serverString(conflict.collaborativeLine ?? '', 'Git conflict collaborative line', 64 * 1024);
      serverString(conflict.externalLine ?? '', 'Git conflict external line', 64 * 1024);
    }
    serverString(message.message ?? '', 'Git status message', 4096);
    return message;
  }
  if (type === 'reservations') {
    serverString(message.documentId, 'Server document id', 1024);
    for (const item of serverArray(message.reservations, 'Server reservations', 500)) validateReservation(item);
    return message;
  }
  if (type === 'review') {
    serverString(message.documentId, 'Server document id', 1024);
    for (const item of serverArray(message.commentThreads, 'Server comments', 500)) validateReviewItem(item, 'Comment');
    for (const item of serverArray(message.suggestions, 'Server suggestions', 500)) validateReviewItem(item, 'Suggestion');
    return message;
  }
  if (type === 'directory') {
    for (const item of serverArray(message.users, 'Server directory', 256)) validateDirectoryUser(item);
    return message;
  }
  if (type === 'presence') {
    validatePresence(message);
    return message;
  }
  if (type === 'presence-left') {
    serverString(message.clientId, 'Presence client id', 256);
    return message;
  }
  if (type === 'history') {
    serverString(message.documentId, 'Server document id', 1024);
    serverString(message.headId, 'History head id', 256);
    for (const item of serverArray(message.entries, 'Server history', 100)) validateHistoryEntry(item);
    return message;
  }
  if (type === 'history-version') {
    serverString(message.documentId, 'Server document id', 1024);
    serverString(message.id, 'History id', 256);
    serverString(message.textBase64, 'History text', 12 * 1024 * 1024);
    return message;
  }
  if (type === 'personal-projection') {
    serverString(message.documentId, 'Server document id', 1024);
    serverString(message.requestId, 'Projection request id', 128);
    serverString(message.subjectAuthorId, 'Projection author id', 256);
    serverString(message.textBase64, 'Projection text', 12 * 1024 * 1024);
    for (const value of serverArray(message.contributors ?? [], 'Projection contributors', 256)) {
      const contributor = serverRecord(value, 'Projection contributor');
      serverString(contributor.id, 'Projection contributor id', 256);
      serverString(contributor.displayName, 'Projection contributor name', 256);
    }
    for (const value of serverArray(message.conflicts ?? [], 'Projection conflicts', 1000)) {
      const conflict = serverRecord(value, 'Projection conflict');
      serverString(conflict.key, 'Projection conflict key', 4096);
      serverString(conflict.baseLine ?? '', 'Projection conflict base', 64 * 1024);
      for (const variant of serverArray(conflict.variants ?? [], 'Projection conflict variants', 64)) {
        const item = serverRecord(variant, 'Projection conflict variant');
        serverString(item.authorId, 'Projection conflict author id', 256);
        serverString(item.author, 'Projection conflict author', 256);
        serverString(item.line ?? '', 'Projection conflict line', 64 * 1024);
      }
    }
    return message;
  }
  if (type === 'error') {
    serverString(message.message ?? '', 'Server error', 64 * 1024);
    return message;
  }
  throw new TypeError(`Unknown server message type: ${type}`);
}
