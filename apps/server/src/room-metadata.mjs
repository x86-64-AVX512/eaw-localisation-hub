import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_COMMENT_THREADS_PER_ROOM = 500;
const MAX_SUGGESTIONS_PER_ROOM = 500;
const MAX_DISCUSSION_MESSAGES = 100;

export function minimalReservation(reservation) {
  const assignee = String(reservation.assignee ?? reservation.createdBy ?? 'Unknown');
  return {
    id: String(reservation.id),
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
}

export function minimalDiscussionMessage(message) {
  return {
    id: String(message.id),
    authorId: message.authorId ? String(message.authorId) : null,
    author: String(message.author ?? 'Unknown'),
    color: String(message.color ?? '#8a8a8a'),
    body: String(message.body ?? ''),
    createdAt: String(message.createdAt ?? ''),
  };
}

export function minimalCommentThread(thread) {
  return {
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
}

export function minimalSuggestion(suggestion) {
  const statuses = new Set(['open', 'accepted', 'rejected', 'stale']);
  return {
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
