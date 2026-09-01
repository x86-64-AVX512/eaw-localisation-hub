import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { applyUtf8ByteEdit, computeSingleReplace, utf8ByteOffsetToUtf16Index } from '../../../packages/shared/src/text.mjs';
import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mjs';

export function requestPersonalDocument(binding) {
  if (binding.ticketId || !binding.synced || binding.socket?.readyState !== WebSocket.OPEN) return;
  if (binding.personalRequestId) {
    binding.personalRefreshPending = true;
    return;
  }
  binding.personalRequestId = crypto.randomUUID();
  binding.socket.send(JSON.stringify({
    type: 'personal-projection-get', requestId: binding.personalRequestId,
    author: binding.hub.options.user, color: binding.hub.options.color,
  }));
}

export function handlePersonalDocument(binding, message) {
  const variantRequest = binding.variantRequests.get(message.requestId);
  if (variantRequest) {
    binding.variantRequests.delete(message.requestId);
    if (!variantRequest.client.closed) variantRequest.client.send({
      type: 'documentVariant', path: variantRequest.absolutePath,
      authorId: message.subjectAuthorId,
      textBase64: message.textBase64,
    });
    return;
  }
  if (!binding.personalRequestId || message.requestId !== binding.personalRequestId) return;
  binding.personalRequestId = '';
  const projected = Buffer.from(message.textBase64, 'base64').toString('utf8');
  const attachedSeed = [...binding.clients].flatMap((client) => [...client.documents.values()])
    .find((state) => state.binding === binding && state.mirror)?.mirror ?? '';
  binding.personalText = projected || binding.text.toString() || attachedSeed;
  binding.personalReady = true;
  binding.personalContributors = message.contributors ?? [];
  binding.personalConflicts = message.conflicts ?? [];
  binding.initialiseAttachedClients();
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      binding.syncClientView(client, absolutePath);
      if (client.kind === 'review') {
        client.send({
          type: 'documentVariants', path: absolutePath,
          sharedBase64: Buffer.from(binding.text.toString(), 'utf8').toString('base64'),
          mineBase64: Buffer.from(binding.personalText, 'utf8').toString('base64'),
          gitBase64: Buffer.from(binding.hub.readGitHeadText(binding.relativePath), 'utf8').toString('base64'),
          contributors: binding.personalContributors,
          conflicts: binding.personalConflicts,
        });
        client.scheduleMaterialisation?.(absolutePath);
      }
    }
  }
  if (binding.personalRefreshPending) {
    binding.personalRefreshPending = false;
    requestPersonalDocument(binding);
  }
}

export function requestDocumentVariant(binding, client, absolutePath, authorId) {
  if (binding.ticketId || !binding.synced || binding.socket?.readyState !== WebSocket.OPEN) return;
  const requestId = crypto.randomUUID();
  binding.variantRequests.set(requestId, { client, absolutePath, authorId });
  binding.socket.send(JSON.stringify({
    type: 'personal-projection-get', requestId, subjectAuthorId: authorId,
    author: binding.hub.options.user, color: binding.hub.options.color,
  }));
}

export function localFileText(binding) {
  return binding.personalMaterialisationMode === 'git'
    ? binding.hub.readGitHeadText(binding.relativePath)
    : (binding.personalReady ? binding.personalText : binding.text.toString());
}

export function setPersonalMaterialisation(binding, mode, absolutePath) {
  if (binding.ticketId || !['git', 'mine'].includes(mode)) return;
  binding.personalMaterialisationMode = mode;
  binding.hub.savePersonalMode(binding.relativePath, mode).catch(() => {});
  for (const client of binding.clients) {
    const state = client.documents.get(absolutePath);
    if (!state || state.binding !== binding) continue;
    binding.syncClientView(client, absolutePath);
    client.scheduleMaterialisation?.(absolutePath);
    if (client.kind === 'review') client.send({
      type: 'personalFileStatus', path: absolutePath, mode,
      message: mode === 'git'
        ? 'В рабочий файл записывается чистая версия Git HEAD.'
        : 'Рабочий файл содержит Git HEAD и только ваши изменения.',
    });
  }
}

export function edit(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  if (!state.initialised || !binding.gitWritable) return false;
  const positionByte = Number(message.positionByte);
  const deleteBytes = Number(message.deleteBytes ?? 0);
  const insertedText = Buffer.from(message.insertBase64 ?? '', 'base64').toString('utf8');
  const previousVisible = state.mirror;
  const nextVisible = applyUtf8ByteEdit(previousVisible, positionByte, deleteBytes, insertedText);
  if (!binding.ticketId && client.kind !== 'review') {
    const merge = mergeLocalisationThreeWay(previousVisible, binding.text.toString(), nextVisible);
    state.mirror = nextVisible;
    binding.personalText = nextVisible;
    if (binding.personalMaterialisationMode === 'git') {
      binding.personalMaterialisationMode = 'mine';
      binding.hub.savePersonalMode(binding.relativePath, 'mine').catch(() => {});
    }
    if (merge.conflicts.length) {
      state.pendingExternal = { base: previousVisible, external: nextVisible, resolutions: new Map() };
      binding.emitExternalConflicts(client, absolutePath, state, merge.conflicts);
      client.send({ type: 'notice', path: absolutePath,
        message: 'Этот ключ одновременно изменён другим участником. Выберите вариант в Review.' });
      return false;
    }
    binding.applyMergedText(merge.text);
    return true;
  }
  const start = utf8ByteOffsetToUtf16Index(previousVisible, positionByte);
  const end = utf8ByteOffsetToUtf16Index(previousVisible, positionByte + deleteBytes);
  state.mirror = nextVisible;
  binding.document.transact(() => {
    if (end > start) binding.text.delete(start, end - start);
    if (insertedText) binding.text.insert(start, insertedText);
  }, state.origin);
  return true;
}

export function snapshot(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  if (!state.initialised || !binding.gitWritable) return false;
  const nextText = Buffer.from(message.textBase64 ?? '', 'base64').toString('utf8');
  const replacement = computeSingleReplace(state.mirror, nextText);
  if (!replacement) return true;
  return edit(binding, client, absolutePath, {
    positionByte: replacement.positionByte, deleteBytes: replacement.deleteBytes,
    insertBase64: Buffer.from(replacement.insertText, 'utf8').toString('base64'),
  });
}
