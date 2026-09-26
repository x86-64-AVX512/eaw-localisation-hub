import { ProtocolLimitError, controlledString, controlledText } from './protocol-limits.mts';
import { parseSuggestionTrace } from '../../../packages/shared/src/suggestion-trace.mts';

const MAX_DISCUSSION_MESSAGES = 100;
const MAX_DISCUSSION_TEXT_BYTES = 2048;
const MAX_SUGGESTION_TEXT_BYTES = 16 * 1024;

export function newDiscussionMessage(target, actor, message, createdAt = new Date().toISOString()) {
  if (target.messages.length >= MAX_DISCUSSION_MESSAGES) {
    throw new ProtocolLimitError('This discussion has reached its message limit');
  }
  const id = controlledString(message.messageId, 'Discussion message id', 128, { required: true });
  if (target.messages.some((item) => item.id === id)) return null;
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
