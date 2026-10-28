import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { utf8ByteOffsetToUtf16Index } from '../../../packages/shared/src/text.mts';

const COMMANDS = new Set(['commentCreate', 'commentReply', 'suggestionReply', 'discussionMessageUpdate', 'discussionMessageDelete']);
export function rejectDiscussionRequest(client, path, message, detail) {
  if (!COMMANDS.has(message.type) || !message.requestId) return false;
  client.send({ type: 'discussionResult', path, id: message.id ?? '', requestId: message.requestId, status: 'error', message: detail });
  return true;
}

function transmit(binding, client, path, message, payload) {
  if (message.requestId) {
    if (!binding.synced || binding.socket?.readyState !== 1 || !binding.discussionUpdates) {
      rejectDiscussionRequest(client, path, message, !binding.discussionUpdates
        ? 'Обновите сервер для работы с новыми комментариями.' : 'Нет подключения к серверу. Черновик сохранён.'); return;
    }
    binding.discussionRequests ??= new Map();
    if (binding.discussionRequests.size >= 128) { rejectDiscussionRequest(client, path, message, 'Дождитесь завершения предыдущих отправок.'); return; }
    const previous = binding.discussionRequests.get(message.requestId);
    if (previous && previous.client !== client) { rejectDiscussionRequest(client, path, message, 'Этот запрос уже отправлен из другого окна.'); return; }
    clearTimeout(previous?.timer);
    const timer = setTimeout(() => binding.discussionRequests.delete(message.requestId), 120000);
    timer.unref?.();
    binding.discussionRequests.set(message.requestId, { client, path, timer });
    payload.requestId = message.requestId;
  }
  try { binding.socket.send(JSON.stringify(payload)); }
  catch {
    const pending = binding.discussionRequests?.get(message.requestId);
    clearTimeout(pending?.timer); binding.discussionRequests?.delete(message.requestId);
    rejectDiscussionRequest(client, path, message, 'Сообщение не отправлено. Черновик сохранён.');
  }
}

export function receiveDiscussionResult(binding, message) {
  const pending = binding.discussionRequests?.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timer); binding.discussionRequests.delete(message.requestId);
  pending.client.send({ ...message, type: 'discussionResult', path: pending.path });
}

function bodyText(client, path, message) {
  const body = Buffer.from(String(message.bodyBase64 ?? ''), 'base64').toString('utf8');
  if (body.trim() && Buffer.byteLength(body, 'utf8') <= 2048) return body;
  const detail = 'Сообщение должно содержать текст и занимать не более 2 КиБ.';
  if (!rejectDiscussionRequest(client, path, message, detail)) client.send({ type: 'notice', message: detail });
  return null;
}

export function createComment(binding, client, path, message) {
  const state = binding.requireState(client, path);
  const body = bodyText(client, path, message);
  if (body === null) return;
  const start = utf8ByteOffsetToUtf16Index(state.mirror, Math.min(message.startByte, message.endByte));
  const end = utf8ByteOffsetToUtf16Index(state.mirror, Math.max(message.startByte, message.endByte));
  const relative = index => Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, index, -1))).toString('base64');
  transmit(binding, client, path, message, { type: 'comment-create', id: message.id || crypto.randomUUID(),
    messageId: message.messageId || crypto.randomUUID(), body,
    author: binding.hub.options.user, color: binding.hub.options.color,
    startRelative: relative(start), endRelative: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, end, 0))).toString('base64') });
}

export function replyToDiscussion(binding, client, path, message, target) {
  binding.requireState(client, path);
  const collection = target === 'comment' ? binding.commentThreads : binding.suggestions;
  if (!collection.has(message.id)) {
    if (!rejectDiscussionRequest(client, path, message, 'Обсуждение уже удалено. Черновик сохранён.')) client.send({ type: 'notice', message: 'Обсуждение уже удалено.' });
    return;
  }
  const body = bodyText(client, path, message);
  if (body === null) return;
  transmit(binding, client, path, message, { type: `${target}-reply`, id: message.id,
    messageId: message.messageId || crypto.randomUUID(), author: binding.hub.options.user, color: binding.hub.options.color, body });
}

export function mutateDiscussion(binding, client, path, message) {
  binding.requireState(client, path);
  const deleting = message.type === 'discussionMessageDelete';
  const body = deleting ? null : bodyText(client, path, message);
  if (!deleting && body === null) return;
  transmit(binding, client, path, message, { type: deleting ? 'discussion-message-delete' : 'discussion-message-update',
    id: message.id, messageId: message.messageId, target: message.target, expectedRevision: message.expectedRevision,
    ...(!deleting ? { body } : {}) });
}
