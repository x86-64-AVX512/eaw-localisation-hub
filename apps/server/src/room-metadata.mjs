import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { MAX_DELETED_MESSAGE_IDS } from './document-review-policy.mjs';

export const MAX_COMMENT_THREADS_PER_ROOM = 500;
const MAX_SUGGESTIONS_PER_ROOM = 500;
const MAX_DISCUSSION_MESSAGES = 100;

// Like the other minimal* readers, drop malformed entries instead of refusing the
// whole metadata file: a throw here would stop the server at startup.
function deletionHistory(item) {
  const ids = [...new Set([
    ...(Array.isArray(item.deletedMessageIds) ? item.deletedMessageIds : []),
    ...(Array.isArray(item.deletedMessageIdsRecovery) ? item.deletedMessageIdsRecovery : []),
  ].filter(id => typeof id === 'string' && id && Buffer.byteLength(id, 'utf8') <= 128))];
  return {
    ...(ids.length ? { deletedMessageIds: ids.slice(0, MAX_DELETED_MESSAGE_IDS) } : {}),
    ...(ids.length > MAX_DELETED_MESSAGE_IDS ? { deletedMessageIdsRecovery: ids.slice(MAX_DELETED_MESSAGE_IDS) } : {}),
    ...(ids.length > MAX_DELETED_MESSAGE_IDS || item.deletionHistoryBlocked === true ? {deletionHistoryBlocked:true} : {}),
  };
}

// Recovery IDs remain on disk and in the room, but never enlarge the wire ledger.
export function publicDiscussionItems(items) {
  return items.map(({ deletedMessageIdsRecovery, mergeOverflowIdsRecovery, ...item }) => item);
}

function mergeOverflowMetadata(thread) {
  const result = {};
  if (Array.isArray(thread.mergeOverflowIds) || Array.isArray(thread.mergeOverflowIdsRecovery)) {
    const ids = [...new Set([
      ...(Array.isArray(thread.mergeOverflowIds) ? thread.mergeOverflowIds : []),
      ...(Array.isArray(thread.mergeOverflowIdsRecovery) ? thread.mergeOverflowIdsRecovery : []),
    ].filter(id => typeof id === 'string' && id && Buffer.byteLength(id,'utf8') <= 128))];
    if (ids.length) result.mergeOverflowIds = ids.slice(0,MAX_DELETED_MESSAGE_IDS);
    if (ids.length > MAX_DELETED_MESSAGE_IDS) {
      result.mergeOverflowIdsRecovery = ids.slice(MAX_DELETED_MESSAGE_IDS);
      result.mergeOverflowBlocked = true;
    }
  }
  if (thread.mergeOverflowBlocked === true) result.mergeOverflowBlocked = true;
  if (typeof thread.mergeOverflowParent === 'string') result.mergeOverflowParent = thread.mergeOverflowParent;
  if (/^[0-9a-f]{64}$/u.test(thread.mergeOverflowOrigin)) result.mergeOverflowOrigin = thread.mergeOverflowOrigin;
  return result;
}

export function minimalReservation(reservation) {
  const assignee = String(reservation.assignee ?? reservation.createdBy ?? 'Unknown');
  const result = {
    id: String(reservation.id),
    revision: Number.isSafeInteger(reservation.revision) && reservation.revision >= 0 ? reservation.revision : 0,
    assigneeId: reservation.assigneeId ? String(reservation.assigneeId) : null,
    assignee,
    color: String(reservation.color ?? '#6aa9ff'),
    createdById: reservation.createdById ? String(reservation.createdById) : null,
    createdBy: String(reservation.createdBy ?? assignee),
    comment: String(reservation.comment ?? ''),
    startRelative: String(reservation.startRelative),
    endRelative: String(reservation.endRelative),
    initialKeys: Array.isArray(reservation.initialKeys) ? reservation.initialKeys.map(String) : [],
  };
  if (reservation.orphaned === true) result.orphaned = true;
  return result;
}

export function minimalDiscussionMessage(message) {
  return {
    id: String(message.id),
    authorId: message.authorId ? String(message.authorId) : null,
    author: String(message.author ?? 'Unknown'),
    color: String(message.color ?? '#8a8a8a'),
    body: message.deleted === true ? '' : String(message.body ?? ''),
    revision: Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : 0,
    ...(message.editedAt ? { editedAt: String(message.editedAt) } : {}),
    ...(message.deleted === true ? { deleted: true } : {}),
    ...(message.mergeConflict === true ? { mergeConflict: true } : {}),
    ...(message.lastMutationId ? { lastMutationId: String(message.lastMutationId).slice(0, 128) } : {}),
    ...(message.branchMergeBase && ['origin', 'source', 'target'].every(key => /^[0-9a-f]{64}$/u.test(message.branchMergeBase[key]))
      ? { branchMergeBase: { origin: message.branchMergeBase.origin, source: message.branchMergeBase.source, target: message.branchMergeBase.target } } : {}),
    createdAt: String(message.createdAt ?? ''),
  };
}

function minimalAnchorLocator(locator) {
  if (!locator || typeof locator !== 'object') return null;
  return {
    empty: locator.empty === true,
    startKey: String(locator.startKey ?? '').slice(0, 512),
    endKey: String(locator.endKey ?? '').slice(0, 512),
    startOffset: Math.max(0, Number.isSafeInteger(locator.startOffset) ? locator.startOffset : 0),
    endOffset: Math.max(0, Number.isSafeInteger(locator.endOffset) ? locator.endOffset : 0),
    before: String(locator.before ?? '').slice(-96),
    after: String(locator.after ?? '').slice(0, 96),
    selected: String(locator.selected ?? '').slice(0, 512),
  };
}

export function minimalCommentThread(thread) {
  const result = {
    id: String(thread.id),
    authorId: thread.authorId ? String(thread.authorId) : null,
    author: String(thread.author ?? 'Unknown'),
    color: String(thread.color ?? '#8a8a8a'),
    status: thread.status === 'resolved' ? 'resolved' : 'open',
    createdAt: String(thread.createdAt ?? thread.messages?.[0]?.createdAt ?? ''),
    startRelative: String(thread.startRelative),
    endRelative: String(thread.endRelative),
    messages: (Array.isArray(thread.messages) ? thread.messages : [])
      .slice(0, MAX_DISCUSSION_MESSAGES)
      .map(minimalDiscussionMessage),
  };
  Object.assign(result, deletionHistory(thread));
  Object.assign(result, mergeOverflowMetadata(thread));
  const anchorLocator = minimalAnchorLocator(thread.anchorLocator);
  if (anchorLocator) result.anchorLocator = anchorLocator;
  if (thread.orphaned === true) result.orphaned = true;
  return result;
}

export function minimalSuggestion(suggestion) {
  const statuses = new Set(['open', 'accepted', 'rejected', 'stale']);
  const result = {
    id: String(suggestion.id),
    authorId: suggestion.authorId ? String(suggestion.authorId) : null,
    author: String(suggestion.author ?? 'Unknown'),
    color: String(suggestion.color ?? '#8a8a8a'),
    status: statuses.has(suggestion.status) ? suggestion.status : 'open',
    createdAt: String(suggestion.createdAt ?? ''),
    decidedById: suggestion.decidedById ? String(suggestion.decidedById) : null,
    decidedBy: suggestion.decidedBy ? String(suggestion.decidedBy) : null,
    startRelative: String(suggestion.startRelative),
    endRelative: String(suggestion.endRelative),
    originalText: String(suggestion.originalText ?? ''),
    replacementText: String(suggestion.replacementText ?? ''),
    traceJson: String(suggestion.traceJson ?? ''),
    messages: (Array.isArray(suggestion.messages) ? suggestion.messages : [])
      .slice(0, MAX_DISCUSSION_MESSAGES)
      .map(minimalDiscussionMessage),
  };
  Object.assign(result, deletionHistory(suggestion));
  const anchorLocator = minimalAnchorLocator(suggestion.anchorLocator);
  if (anchorLocator) result.anchorLocator = anchorLocator;
  if (suggestion.orphaned === true) result.orphaned = true;
  return result;
}

async function metadataFiles(dataDirectory) {
  const directory = path.join(dataDirectory, 'documents');
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/u.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function serialiseMetadata(reservations, commentThreads, suggestions, gitBase = null) {
  return `${JSON.stringify({ schema: 3, reservations, commentThreads, suggestions, gitBase }, null, 2)}\n`;
}

export async function minimisePersistedDocumentMetadata(dataDirectory, atomicWrite) {
  for (const target of await metadataFiles(dataDirectory)) {
    const metadata = JSON.parse(await fs.readFile(target, 'utf8'));
    const reservations = (Array.isArray(metadata.reservations) ? metadata.reservations : [])
      .filter((reservation) => !reservation.deletedAt)
      .map(minimalReservation);
    const commentThreads = (Array.isArray(metadata.commentThreads) ? metadata.commentThreads : [])
      .slice(0, MAX_COMMENT_THREADS_PER_ROOM)
      .map(minimalCommentThread);
    const suggestions = (Array.isArray(metadata.suggestions) ? metadata.suggestions : [])
      .slice(0, MAX_SUGGESTIONS_PER_ROOM)
      .map(minimalSuggestion);
    await atomicWrite(target, serialiseMetadata(
      reservations, commentThreads, suggestions, metadata.gitBase ?? null,
    ));
  }
}

export async function anonymisePersistedReservationUser(dataDirectory, userId, atomicWrite) {
  for (const target of await metadataFiles(dataDirectory)) {
    const metadata = JSON.parse(await fs.readFile(target, 'utf8'));
    let changed = false;
    const reservations = (Array.isArray(metadata.reservations) ? metadata.reservations : []).map((item) => {
      const reservation = minimalReservation(item);
      if (reservation.assigneeId === userId) {
        reservation.assigneeId = null;
        reservation.assignee = 'Deleted user';
        reservation.color = '#8a8a8a';
        changed = true;
      }
      if (reservation.createdById === userId) {
        reservation.createdById = null;
        reservation.createdBy = 'Deleted user';
        changed = true;
      }
      return reservation;
    });
    const anonymiseDiscussion = (item) => {
      if (item.authorId === userId) {
        item.authorId = null;
        item.author = 'Deleted user';
        item.color = '#8a8a8a';
        changed = true;
      }
      for (const message of item.messages ?? []) {
        if (message.authorId !== userId) continue;
        message.authorId = null;
        message.author = 'Deleted user';
        message.color = '#8a8a8a';
        changed = true;
      }
      if (item.decidedById === userId) {
        item.decidedById = null;
        item.decidedBy = 'Deleted user';
        changed = true;
      }
      return item;
    };
    const commentThreads = (Array.isArray(metadata.commentThreads) ? metadata.commentThreads : [])
      .map(minimalCommentThread).map(anonymiseDiscussion);
    const suggestions = (Array.isArray(metadata.suggestions) ? metadata.suggestions : [])
      .map(minimalSuggestion).map(anonymiseDiscussion);
    if (changed) await atomicWrite(target, serialiseMetadata(
      reservations, commentThreads, suggestions, metadata.gitBase ?? null,
    ));
  }
}
