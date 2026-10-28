import { controlledString, controlledText, sendWithBackpressure } from './protocol-limits.mts';
import { currentDocumentActor } from './document-actor.mjs';
import { newCommentThread } from './document-review-policy.mjs';
import { captureReviewAnchor } from './review-anchors.mjs';
import { auditDocumentControl } from './document-audit.mjs';
import { MAX_COMMENT_THREADS_PER_ROOM } from './room-metadata.mjs';

// Review shows these results to the user, so they follow the Russian UI source
// language that the English catalogue translates.
const USER_ERRORS = new Map([
  ['Only the message author may edit it; moderators may delete replies',
    'Изменять сообщение может только его автор; удалять чужие ответы могут модераторы.'],
  ['Delete the whole discussion to remove its first message', 'Первое сообщение удаляется только вместе со всем обсуждением.'],
  ['This document has reached its comment limit', 'В документе достигнут лимит обсуждений.'],
  ['This discussion has reached its message limit', 'В обсуждении достигнут лимит сообщений.'],
  ['This discussion has reached its deletion history limit', 'В обсуждении достигнут лимит удалённых ответов. Создайте новое обсуждение.'],
  ['Room metadata exceeds the persistence limit', 'Для обсуждений этого документа не осталось места.'],
  ['Discussion message must contain visible text', 'Сообщение должно содержать текст и занимать не более 2 КиБ.'],
  ['Account access was revoked', 'Доступ к аккаунту отозван.'],
  ['Mod contributors may edit English localisation files only', 'Недостаточно прав для изменения обсуждения.'],
]);
const WRITES = new Set(['comment-create', 'comment-reply', 'suggestion-reply', 'discussion-message-update', 'discussion-message-delete']);
export const isDiscussionWrite = (message) => WRITES.has(message?.type);

export async function receiveDiscussionWrite(room, socket, message, authorise) {
  const requestId = controlledString(message.requestId, 'Discussion request id', 128, { required: true });
  const id = controlledString(message.id, 'Discussion id', 128, { required: true });
  let result;
  try {
    authorise();
    result = await auditDocumentControl(room, socket, message, () => room.applyJson(socket, message));
    if (!result) throw new Error('Discussion is unavailable');
    // Already inside the room queue: flush() would wait for this very request.
    if (room.persistTimer) { clearTimeout(room.persistTimer); room.persistTimer = null; }
    await room.persist();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[server] discussion write rejected for ${room.documentId}: ${detail}`);
    result = { status: 'error', message: USER_ERRORS.get(detail) ?? 'Не удалось сохранить сообщение. Черновик сохранён.' };
  }
  sendWithBackpressure(socket, JSON.stringify({ type: 'discussion-result', requestId, id, ...result }));
}

function owns(message, actor) { return Boolean(message.authorId && message.authorId === actor.id); }
function mutateMessage(room, socket, message) {
  const id = controlledString(message.id, 'Discussion id', 128, { required: true });
  const messageId = controlledString(message.messageId, 'Discussion message id', 128, { required: true });
  if (!['comment', 'suggestion'].includes(message.target)) throw new Error('Invalid discussion target');
  if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) throw new Error('Invalid discussion revision');
  const collection = message.target === 'comment' ? room.commentThreads : room.suggestions;
  const thread = collection.find(item => item.id === id);
  const index = thread?.messages.findIndex(item => item.id === messageId) ?? -1;
  if (!thread || index < 0) return { status: 'deleted' };
  const previous = thread.messages[index];
  const actor = room.actorFor(socket, message, 'Comment');
  const deleting = message.type === 'discussion-message-delete';
  const roles = currentDocumentActor(room.authStore, socket.identity)?.roles ?? [];
  if (!owns(previous, actor) && !(deleting && roles.some(role => ['admin', 'senior translator'].includes(role)))) {
    throw new Error('Only the message author may edit it; moderators may delete replies');
  }
  if (deleting && message.target === 'comment' && index === 0) throw new Error('Delete the whole discussion to remove its first message');
  const revision = previous.revision ?? 0;
  if (message.requestId && previous.lastMutationId === message.requestId) {
    return deleting !== Boolean(previous.deleted) || (!deleting && previous.body !== message.body)
      ? { status: 'stale', revision } : { status: 'saved', revision };
  }
  if (previous.deleted) return { status: 'deleted' };
  if (message.expectedRevision !== revision) return { status: 'stale', revision };
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Discussion revision exhausted');
  const body = deleting ? '' : controlledText(message.body, 'Discussion message', 2048, { required: true });
  if (!deleting && !body.trim()) throw new Error('Discussion message must contain visible text');
  const next = { ...previous, body, revision: revision + 1,
    ...(message.requestId ? { lastMutationId: controlledString(message.requestId, 'Discussion request id', 128) } : {}),
    ...(deleting ? { deleted: true } : { editedAt: new Date().toISOString() }) };
  thread.messages[index] = next;
  try { room.assertMetadataBudget(); } catch (error) { thread.messages[index] = previous; throw error; }
  room.schedulePersist();
  room.broadcastReview();
  return { status: 'saved', revision: next.revision };
}

export function applyDiscussionControl(room, socket, message) {
  if (['discussion-message-update', 'discussion-message-delete'].includes(message.type)) return mutateMessage(room, socket, message);
  if (!['comment-create', 'comment-reply', 'comment-status', 'comment-delete', 'suggestion-reply'].includes(message.type)) return false;
  const id = controlledString(message.id, 'Discussion id', 128, { required: true });
  const actor = room.actorFor(socket, message, 'Comment');
  const collection = message.type === 'suggestion-reply' ? room.suggestions : room.commentThreads;
  let thread = collection.find(item => item.id === id);
  if (message.type === 'comment-create') {
    if (!thread) {
      if (collection.length >= MAX_COMMENT_THREADS_PER_ROOM) throw new Error('This document has reached its comment limit');
      thread = newCommentThread(id, actor, message);
      captureReviewAnchor(room.document, thread);
      collection.push(thread);
      try { room.appendDiscussionMessage(thread, actor, message); room.assertMetadataBudget(); }
      catch (error) { collection.pop(); throw error; }
      room.schedulePersist();
      room.notifyTicketOwner('comment-created', actor, { discussionId: id });
    } else {
      if (!owns(thread, actor) || thread.messages[0]?.id !== message.messageId) throw new Error('Discussion id already exists');
      if (message.requestId && thread.messages[0]?.body !== message.body) return { status:'stale', revision:thread.messages[0]?.revision ?? 0 };
    }
  } else if (message.type.endsWith('-reply')) {
    if (!thread) return { status: 'deleted' };
    if (thread.deletedMessageIds?.includes(message.messageId) || thread.deletedMessageIdsRecovery?.includes(message.messageId)) return { status: 'deleted' };
    const previous = thread.messages.find(item => item.id === message.messageId);
    if (previous && !owns(previous, actor)) throw new Error('Discussion message id already exists');
    if (message.requestId && previous?.deleted) return {status:'deleted'};
    if (message.requestId && previous && previous.body !== message.body) return {status:'stale',revision:previous.revision ?? 0};
    if (room.appendDiscussionMessage(thread, actor, message)) {
      room.registry.eventJournal?.append('comment-reply', actor, [thread.authorId], { documentId: room.documentId, discussionId: id });
      room.notifyTicketOwner(message.type === 'comment-reply' ? 'comment-replied' : 'suggestion-replied', actor,
        message.type === 'comment-reply' ? { discussionId: id } : { suggestionId: id });
      room.schedulePersist();
    }
  } else if (message.type === 'comment-status') {
    const status = controlledString(message.status, 'Comment status', 16, { required: true });
    if (!['open', 'resolved'].includes(status)) throw new Error('Invalid comment status');
    if (thread && thread.status !== status) {
      thread.status = status; room.notifyTicketOwner('comment-status', actor, { discussionId: id, status }); room.schedulePersist();
    }
  } else if (thread) {
    room.commentThreads = collection.filter(item => item.id !== id); room.schedulePersist();
  }
  room.broadcastReview();
  return { status: 'saved' };
}
