import { ProtocolLimitError, controlledString, controlledText } from './protocol-limits.mts';
import { parseSuggestionTrace } from '../../../packages/shared/src/suggestion-trace.mts';

export const MAX_DISCUSSION_MESSAGES = 100;
export const MAX_DELETED_MESSAGE_IDS = 4096;
const MAX_DISCUSSION_TEXT_BYTES = 2048;
const MAX_SUGGESTION_TEXT_BYTES = 16 * 1024;

export function newDiscussionMessage(target, actor, message, createdAt = new Date().toISOString()) {
  const id = controlledString(message.messageId, 'Discussion message id', 128, { required: true });
  if (target.messages.some((item) => item.id === id) || target.deletedMessageIds?.includes(id)) return null;
  if (target.deletedMessageIdsRecovery?.includes(id)) return null;
  if (target.deletionHistoryBlocked || target.deletedMessageIdsRecovery?.length) {
    throw new ProtocolLimitError('This discussion has reached its deletion history limit');
  }
  if (target.messages.filter((item) => !item.deleted).length >= MAX_DISCUSSION_MESSAGES) {
    throw new ProtocolLimitError('This discussion has reached its message limit');
  }
  const body = controlledText(message.body, 'Discussion message', MAX_DISCUSSION_TEXT_BYTES, { required: true });
  if (!body.trim()) throw new ProtocolLimitError('Discussion message must contain visible text');
  return {
    id,
    authorId: actor.id,
    author: actor.displayName,
    color: actor.color ?? '#8a8a8a',
    body,
    createdAt,
  };
}

// Compact tombstones without forgetting their IDs. Never expire deletion history:
// a local draft can retry long after the original message was deleted.
export function withRoomForMessages(target, count) {
  if (count && (target.deletionHistoryBlocked || target.deletedMessageIdsRecovery?.length)) {
    throw new ProtocolLimitError('This discussion has reached its deletion history limit');
  }
  const messages = target.messages ?? [];
  if (messages.filter((item) => !item.deleted).length + count > MAX_DISCUSSION_MESSAGES) return null;
  const next = [...messages];
  const deleted = new Set(target.deletedMessageIds ?? []);
  while (next.length + count > MAX_DISCUSSION_MESSAGES) {
    const index = next.findIndex((item) => item.deleted);
    deleted.add(next[index].id);
    next.splice(index, 1);
  }
  if (deleted.size > MAX_DELETED_MESSAGE_IDS) throw new ProtocolLimitError('This discussion has reached its deletion history limit');
  return { messages: next, deletedMessageIds: [...deleted] };
}

export function newCommentThread(id, actor, message, createdAt = new Date().toISOString()) {
  return {
    id,
    authorId: actor.id,
    author: actor.displayName,
    color: actor.color ?? '#8a8a8a',
    status: 'open',
    createdAt,
    startRelative: controlledString(message.startRelative, 'Comment start', 4096, { required: true }),
    endRelative: controlledString(message.endRelative, 'Comment end', 4096, { required: true }),
    messages: [],
  };
}

export function suggestionDraft(message) {
  const originalText = controlledText(
    message.originalText, 'Suggestion original text', MAX_SUGGESTION_TEXT_BYTES,
  );
  const replacementText = controlledText(
    message.replacementText, 'Suggestion replacement text', MAX_SUGGESTION_TEXT_BYTES,
  );
  const traceJson = controlledString(message.traceJson ?? '', 'Suggestion trace', 64 * 1024);
  if (traceJson) parseSuggestionTrace(traceJson, originalText, replacementText);
  if (!originalText && !replacementText) {
    throw new ProtocolLimitError('Suggestion must insert or delete text');
  }
  return { originalText, replacementText, traceJson };
}

export function newSuggestion(id, actor, message, createdAt = new Date().toISOString()) {
  const draft = suggestionDraft(message);
  return {
    id,
    authorId: actor.id,
    author: actor.displayName,
    color: actor.color ?? '#8a8a8a',
    status: 'open',
    createdAt,
    decidedById: null,
    decidedBy: null,
    startRelative: controlledString(message.startRelative, 'Suggestion start', 4096, { required: true }),
    endRelative: controlledString(message.endRelative, 'Suggestion end', 4096, { required: true }),
    ...draft,
    messages: [],
  };
}

export function editableSuggestionDraft(suggestion, actor, message) {
  const sameAuthor = suggestion.authorId
    ? suggestion.authorId === actor.id
    : suggestion.author === actor.displayName;
  if (!sameAuthor) throw new ProtocolLimitError('Only the suggestion author may update its draft');
  return {
    startRelative: controlledString(message.startRelative, 'Suggestion start', 4096, { required: true }),
    endRelative: controlledString(message.endRelative, 'Suggestion end', 4096, { required: true }),
    ...suggestionDraft(message),
  };
}
