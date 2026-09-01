import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import {
  computeSingleReplace,
  utf16IndexToUtf8ByteOffset,
} from '../../../packages/shared/src/text.mjs';

function decodeRelativePosition(encoded) {
  return Y.decodeRelativePosition(Buffer.from(encoded, 'base64'));
}

export function scheduleRefresh(binding) {
  if (binding.refreshScheduled) return;
  binding.refreshScheduled = true;
  queueMicrotask(() => {
    binding.refreshScheduled = false;
    binding.refreshAllViews();
  });
}

export function emitDocumentStatus(binding, status) {
  const git = binding.gitState ?? {};
  const messages = {
    connecting: 'Ожидание локальной привязки документа.',
    syncing: 'Agent подключается к совместному документу на сервере.',
    offline: 'Соединение с сервером потеряно; Agent повторит подключение автоматически.',
    unauthorized: 'Сервер отклонил сохранённую сессию пользователя.',
    'git-branch-outdated': 'В ветке появился новый коммит, но Git blob этого файла совпадает с сервером.',
    'git-file-outdated': git.reason === 'local-file-not-in-head'
      ? 'Файл отсутствует в локальном HEAD. Добавьте его в Git или обновите репозиторий.'
      : 'Git blob открытого файла отличается от канонической версии сервера.',
    'git-conflict': 'Git-обновление конфликтует с совместным документом; откройте Review для просмотра diff.',
  };
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding === binding) client.send({
        type: 'documentStatus', path: absolutePath, status,
        branch: String(git.branch ?? ''),
        localHead: String(git.localHead ?? ''), remoteHead: String(git.remoteHead ?? ''),
        localBlob: String(git.localBlob ?? ''), remoteBlob: String(git.remoteBlob ?? ''),
        reason: String(git.reason ?? ''), message: messages[status] ?? String(git.message ?? ''),
        changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles.slice(0, 500) : [],
      });
    }
  }
}

export function refreshAllViews(binding) {
  if (binding.gitWritable) {
    for (const client of binding.clients) {
      for (const [absolutePath, state] of client.documents) {
        if (state.binding === binding && state.initialised) binding.syncClientView(client, absolutePath);
      }
    }
  }
  binding.emitReservations();
  binding.emitReview();
  binding.emitPresences();
}

export function syncClientView(binding, client, absolutePath) {
  const state = binding.requireState(client, absolutePath);
  const canonical = binding.text.toString();
  const visible = !binding.ticketId && client.kind !== 'review'
    ? binding.localFileText() : canonical;
  const replacement = computeSingleReplace(state.mirror, visible);
  if (replacement) {
    client.send({
      type: 'replace',
      path: absolutePath,
      source: client.kind === 'review' ? 'shared-workspace' : 'personal-workspace',
      positionByte: replacement.positionByte,
      deleteBytes: replacement.deleteBytes,
      insertBase64: Buffer.from(replacement.insertText, 'utf8').toString('base64'),
    });
    state.mirror = visible;
  }
}

function resolveAnchoredRange(binding, item) {
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      decodeRelativePosition(item.startRelative),
      binding.document,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      decodeRelativePosition(item.endRelative),
      binding.document,
    );
    if (!start || !end || start.type !== binding.text || end.type !== binding.text) return null;
    return { start: Math.min(start.index, end.index), end: Math.max(start.index, end.index) };
  } catch {
    return null;
  }
}

export function resolveReservation(binding, reservation) {
  return resolveAnchoredRange(binding, reservation);
}

export function resolveAnchoredItem(binding, item) {
  return resolveAnchoredRange(binding, item);
}

export function discussionText(_binding, item) {
  return (item.messages ?? [])
    .map((message) => `${message.author ?? 'Unknown'}: ${message.body ?? ''}`)
    .join('\n\n');
}

function avatarFor(binding, userId) {
  return binding.hub.directory.find((user) => user.id === userId)?.avatarBase64 ?? '';
}

export function emitReview(binding, onlyClient = null) {
  const recipients = onlyClient ? [onlyClient] : binding.clients;
  const canonical = binding.text.toString();
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      if (client.kind === 'review') client.send({ type: 'reviewBatchStart', path: absolutePath });
      client.send({ type: 'commentReset', path: absolutePath });
      for (const thread of binding.commentThreads.values()) {
        const resolved = binding.resolveAnchoredItem(thread);
        const status = thread.status === 'resolved' ? 'resolved' : (resolved ? 'open' : 'orphaned');
        const lastMessage = thread.messages?.at(-1);
        client.send({
          type: 'commentThread',
          path: absolutePath,
          id: thread.id,
          author: thread.author,
          authorId: thread.authorId ?? '',
          avatarBase64: avatarFor(binding, thread.authorId),
          color: thread.color ?? '#8a8a8a',
          createdAt: thread.createdAt ?? thread.messages?.[0]?.createdAt ?? '',
          status,
          messageCount: thread.messages?.length ?? 0,
          summaryAuthor: lastMessage?.author ?? thread.author,
          summaryColor: lastMessage?.color ?? thread.color ?? '#8a8a8a',
          summaryBase64: Buffer.from(lastMessage?.body ?? '', 'utf8').toString('base64'),
          threadBase64: Buffer.from(binding.discussionText(thread), 'utf8').toString('base64'),
          startByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.start) : 0,
          endByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.end) : 0,
        });
        for (const discussionMessage of thread.messages ?? []) {
          client.send({
            type: 'commentMessage',
            path: absolutePath,
            id: thread.id,
            author: discussionMessage.author,
            authorId: discussionMessage.authorId ?? '',
            avatarBase64: avatarFor(binding, discussionMessage.authorId),
            color: discussionMessage.color ?? '#8a8a8a',
            createdAt: discussionMessage.createdAt ?? '',
            bodyBase64: Buffer.from(discussionMessage.body ?? '', 'utf8').toString('base64'),
          });
        }
      }
      client.send({ type: 'suggestionReset', path: absolutePath });
      for (const suggestion of binding.suggestions.values()) {
        const resolved = binding.resolveAnchoredItem(suggestion);
        let status = suggestion.status;
        if (status === 'open') {
          status = !resolved
            ? 'orphaned'
            : canonical.slice(resolved.start, resolved.end) === suggestion.originalText ? 'open' : 'stale';
        }
        client.send({
          type: 'suggestion',
          path: absolutePath,
          id: suggestion.id,
          author: suggestion.author,
          authorId: suggestion.authorId ?? '',
          avatarBase64: avatarFor(binding, suggestion.authorId),
          color: suggestion.color ?? '#8a8a8a',
          createdAt: suggestion.createdAt ?? '',
          decidedBy: suggestion.decidedBy ?? '',
          status,
          messageCount: suggestion.messages?.length ?? 0,
          originalBase64: Buffer.from(suggestion.originalText ?? '', 'utf8').toString('base64'),
          replacementBase64: Buffer.from(suggestion.replacementText ?? '', 'utf8').toString('base64'),
          traceJson: suggestion.traceJson ?? '',
          threadBase64: Buffer.from(binding.discussionText(suggestion), 'utf8').toString('base64'),
          startByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.start) : 0,
          endByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.end) : 0,
        });
        for (const discussionMessage of suggestion.messages ?? []) {
          client.send({
            type: 'suggestionMessage',
            path: absolutePath,
            id: suggestion.id,
            author: discussionMessage.author,
            authorId: discussionMessage.authorId ?? '',
            avatarBase64: avatarFor(binding, discussionMessage.authorId),
            color: discussionMessage.color ?? '#8a8a8a',
            createdAt: discussionMessage.createdAt ?? '',
            bodyBase64: Buffer.from(discussionMessage.body ?? '', 'utf8').toString('base64'),
          });
        }
      }
      if (client.kind === 'review') client.send({ type: 'reviewBatchEnd', path: absolutePath });
    }
  }
}

export function emitHistory(binding, onlyClient = null) {
  const recipients = onlyClient ? [onlyClient] : binding.clients;
  for (const client of recipients) {
    if (client.kind !== 'review') continue;
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      client.send({
        type: 'history', path: absolutePath, headId: binding.historyHeadId,
        entries: binding.history,
      });
    }
  }
}

export function emitReservations(binding, onlyClient = null) {
  const recipients = onlyClient ? [onlyClient] : binding.clients;
  const canonical = binding.text.toString();
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      client.send({ type: 'reservationReset', path: absolutePath });
      for (const reservation of binding.reservations.values()) {
        const resolved = binding.resolveReservation(reservation);
        client.send({
          type: 'reservation',
          path: absolutePath,
          id: reservation.id,
          assignee: reservation.assignee,
          assigneeId: reservation.assigneeId ?? '',
          color: reservation.color,
          createdBy: reservation.createdBy ?? reservation.assignee,
          createdById: reservation.createdById ?? '',
          comment: reservation.comment ?? '',
          keyCount: reservation.initialKeys?.length ?? 0,
          status: resolved ? (resolved.start === resolved.end ? 'empty' : 'active') : 'orphaned',
          startByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.start) : 0,
          endByte: resolved ? utf16IndexToUtf8ByteOffset(canonical, resolved.end) : 0,
        });
      }
    }
  }
}

export function emitPresences(binding, onlyClient = null) {
  const recipients = onlyClient ? [onlyClient] : binding.clients;
  const canonical = binding.text.toString();
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      client.send({ type: 'presenceReset', path: absolutePath });
      for (const presence of binding.presences.values()) {
        if (presence.offline || binding.hub.isLocalPresenceId(presence.clientId)) continue;
        try {
          const caret = Y.createAbsolutePositionFromRelativePosition(
            decodeRelativePosition(presence.caretRelative),
            binding.document,
          );
          const anchor = Y.createAbsolutePositionFromRelativePosition(
            decodeRelativePosition(presence.anchorRelative),
            binding.document,
          );
          if (!caret || !anchor || caret.type !== binding.text || anchor.type !== binding.text) continue;
          client.send({
            type: 'presence',
            path: absolutePath,
            clientId: presence.clientId,
          user: presence.user,
          avatarBase64: binding.hub.directory.find((user) => user.displayName === presence.user)?.avatarBase64 ?? '',
            color: presence.color,
            positionByte: utf16IndexToUtf8ByteOffset(canonical, caret.index),
            anchorByte: utf16IndexToUtf8ByteOffset(canonical, anchor.index),
          });
        } catch {
          // A stale relative position is intentionally omitted from the visual layer.
        }
      }
    }
  }
}

export function emitReservationTargets(binding, onlyClient = null) {
  const recipients = onlyClient ? [onlyClient] : binding.clients;
  const configured = binding.hub.directory.length > 0
    ? binding.hub.directory
    : [
        { id: '', displayName: binding.hub.options.user, color: binding.hub.options.color },
        ...[...binding.presences.values()].map((presence) => ({
          id: '',
          displayName: presence.user,
          color: presence.color,
        })),
      ];
  const seen = new Set();
  const targets = configured.filter((user) => {
    const key = user.id || String(user.displayName ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      client.send({ type: 'reservationTargetReset', path: absolutePath });
      for (const target of targets) {
        client.send({
          type: 'reservationTarget',
          path: absolutePath,
          id: String(target.id ?? ''),
          displayName: String(target.displayName ?? ''),
          color: String(target.color ?? '#6aa9ff'),
          avatarBase64: String(target.avatarBase64 ?? ''),
          isSelf: target.id
            ? target.id === binding.hub.identity?.id
            : target.displayName === binding.hub.options.user,
        });
      }
    }
  }
}
