import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import {
  computeSingleReplace,
} from '../../../packages/shared/src/text.mjs';

const COORDINATE_STEP = 4096;

function documentCoordinates(binding, text) {
  if (binding.coordinateText === text && binding.coordinateCheckpoints) {
    return binding.coordinateCheckpoints;
  }
  const checkpoints = [{ utf16: 0, bytes: 0 }];
  let utf16 = 0; let bytes = 0;
  while (utf16 < text.length) {
    let next = Math.min(text.length, utf16 + COORDINATE_STEP);
    if (next < text.length && /[\uD800-\uDBFF]/u.test(text[next - 1])
      && /[\uDC00-\uDFFF]/u.test(text[next])) next -= 1;
    bytes += Buffer.byteLength(text.slice(utf16, next), 'utf8');
    utf16 = next;
    checkpoints.push({ utf16, bytes });
  }
  binding.coordinateText = text;
  binding.coordinateCheckpoints = checkpoints;
  return checkpoints;
}

function byteOffsetFor(binding, text, utf16Index) {
  if (!Number.isSafeInteger(utf16Index) || utf16Index < 0 || utf16Index > text.length) {
    throw new RangeError('Invalid UTF-16 position');
  }
  if (utf16Index > 0 && utf16Index < text.length
    && /[\uD800-\uDBFF]/u.test(text[utf16Index - 1])
    && /[\uDC00-\uDFFF]/u.test(text[utf16Index])) {
    throw new RangeError('UTF-16 position splits a surrogate pair');
  }
  const checkpoints = documentCoordinates(binding, text);
  let low = 0; let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle].utf16 <= utf16Index) low = middle;
    else high = middle - 1;
  }
  const checkpoint = checkpoints[low];
  return checkpoint.bytes + Buffer.byteLength(text.slice(checkpoint.utf16, utf16Index), 'utf8');
}

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
  if (client.kind === 'review' && client.reviewCrdt) {
    if (!state.reviewSynced) client.send({
      type: 'documentSync', path: absolutePath, documentId: binding.documentId,
      updateBase64: Buffer.from(Y.encodeStateAsUpdate(binding.document)).toString('base64'),
    });
    state.reviewSynced = true;
    state.mirror = canonical;
    return;
  }
  const visible = !binding.ticketId && client.kind !== 'review'
    ? binding.localFileText() : canonical;
  if (visible === null) return;
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
  if (item.orphaned) return null;
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
  if (reservation.orphaned) return null;
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
  const threads = [...binding.commentThreads.values()].map((thread) => {
    const resolved = binding.resolveAnchoredItem(thread);
    const status = thread.status === 'resolved' ? 'resolved' : (resolved ? 'open' : 'orphaned');
    return { thread, resolved, status };
  });
  const suggestions = [...binding.suggestions.values()].map((suggestion) => {
    const resolved = binding.resolveAnchoredItem(suggestion);
    let status = suggestion.status;
    if (status === 'open') status = !resolved
      ? 'orphaned'
      : canonical.slice(resolved.start, resolved.end) === suggestion.originalText ? 'open' : 'stale';
    return { suggestion, resolved, status };
  });
  const positionFingerprint = JSON.stringify([
    binding.reviewRevision ?? 0,
    threads.map(({ thread, resolved, status }) => [thread.id, status, resolved?.start, resolved?.end]),
    suggestions.map(({ suggestion, resolved, status }) => [suggestion.id, status, resolved?.start, resolved?.end]),
  ]);
  const targets = [];
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      if (client.kind === 'review' && !onlyClient
        && state.reviewPositionFingerprint === positionFingerprint) continue;
      state.reviewPositionFingerprint = positionFingerprint;
      targets.push({ client, absolutePath });
    }
  }
  if (!targets.length) return;
  const messages = [{ type: 'commentReset' }];
  for (const { thread, resolved, status } of threads) {
        const lastMessage = thread.messages?.at(-1);
        messages.push({
          type: 'commentThread',
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
          startByte: resolved ? byteOffsetFor(binding, canonical, resolved.start) : 0,
          endByte: resolved ? byteOffsetFor(binding, canonical, resolved.end) : 0,
        });
        for (const discussionMessage of thread.messages ?? []) {
          messages.push({
            type: 'commentMessage',
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
  messages.push({ type: 'suggestionReset' });
  for (const { suggestion, resolved, status } of suggestions) {
        messages.push({
          type: 'suggestion',
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
          startByte: resolved ? byteOffsetFor(binding, canonical, resolved.start) : 0,
          endByte: resolved ? byteOffsetFor(binding, canonical, resolved.end) : 0,
        });
        for (const discussionMessage of suggestion.messages ?? []) {
          messages.push({
            type: 'suggestionMessage',
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
  for (const { client, absolutePath } of targets) {
      if (client.kind === 'review') {
        client.send({ type: 'reviewBatchStart', path: absolutePath });
        for (const message of messages) client.send({ ...message, path: absolutePath });
        client.send({ type: 'reviewBatchEnd', path: absolutePath });
      } else for (const message of messages) client.send({ ...message, path: absolutePath });
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
  const reservations = [...binding.reservations.values()].map((reservation) => {
    const resolved = binding.resolveReservation(reservation);
    return {
      id: reservation.id,
      assignee: reservation.assignee,
      assigneeId: reservation.assigneeId ?? '',
      color: reservation.color,
      createdBy: reservation.createdBy ?? reservation.assignee,
      createdById: reservation.createdById ?? '',
      comment: reservation.comment ?? '',
      keyCount: reservation.initialKeys?.length ?? 0,
      status: resolved ? (resolved.start === resolved.end ? 'empty' : 'active') : 'orphaned',
      startIndex: resolved?.start ?? 0,
      endIndex: resolved?.end ?? 0,
    };
  });
  const positionFingerprint = JSON.stringify([
    binding.reservationRevision ?? 0,
    reservations.map(({ id, status, startIndex, endIndex }) => [id, status, startIndex, endIndex]),
  ]);
  for (const client of recipients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      if (client.kind === 'review' && !onlyClient
        && state.reservationPositionFingerprint === positionFingerprint) continue;
      state.reservationPositionFingerprint = positionFingerprint;
      const encoded = reservations.map(({ startIndex, endIndex, ...reservation }) => ({
        ...reservation,
        startByte: byteOffsetFor(binding, canonical, startIndex),
        endByte: byteOffsetFor(binding, canonical, endIndex),
      }));
      if (client.kind === 'review') {
        client.send({ type: 'reservationSnapshot', path: absolutePath, reservations: encoded });
      } else {
        client.send({ type: 'reservationReset', path: absolutePath });
        for (const reservation of encoded) client.send({
          type: 'reservation', path: absolutePath, ...reservation,
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
      const presences = [];
      if (client.kind !== 'review') client.send({ type: 'presenceReset', path: absolutePath });
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
          const item = {
            type: 'presence',
            path: absolutePath,
            clientId: presence.clientId,
          user: presence.user,
          avatarBase64: binding.hub.directory.find((user) => user.displayName === presence.user)?.avatarBase64 ?? '',
            color: presence.color,
            positionByte: byteOffsetFor(binding, canonical, caret.index),
            anchorByte: byteOffsetFor(binding, canonical, anchor.index),
          };
          if (client.kind === 'review') presences.push(item);
          else client.send(item);
        } catch {
          // A stale relative position is intentionally omitted from the visual layer.
        }
      }
      if (client.kind === 'review') client.send({ type: 'presenceSnapshot', path: absolutePath, presences });
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
      const items = [];
      if (client.kind !== 'review') client.send({ type: 'reservationTargetReset', path: absolutePath });
      for (const target of targets) {
        const item = {
          type: 'reservationTarget',
          path: absolutePath,
          id: String(target.id ?? ''),
          displayName: String(target.displayName ?? ''),
          color: String(target.color ?? '#6aa9ff'),
          avatarBase64: String(target.avatarBase64 ?? ''),
          isSelf: target.id
            ? target.id === binding.hub.identity?.id
            : target.displayName === binding.hub.options.user,
        };
        if (client.kind === 'review') items.push(item);
        else client.send(item);
      }
      if (client.kind === 'review') {
        const fingerprint = JSON.stringify(items);
        if (!onlyClient && state.reservationTargetsFingerprint === fingerprint) continue;
        state.reservationTargetsFingerprint = fingerprint;
        client.send({ type: 'reservationTargetSnapshot', path: absolutePath, targets: items });
      }
    }
  }
}
