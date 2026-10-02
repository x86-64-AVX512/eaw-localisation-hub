import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { applyUtf8ByteEdit, computeSingleReplace, normaliseLineEndings, utf8ByteOffsetToUtf16Index } from '../../../packages/shared/src/text.mts';
import {
  localisationSelectionChanges,
  setLocalisationSelection,
} from '../../../packages/shared/src/merge.mts';

const PERSONAL_REFRESH_DELAY_MS = 250;
const PERSONAL_REFRESH_MAX_WAIT_MS = 2_000;

function variantsPayload(binding) {
  const commit = binding.hub.gitCommit;
  const git = commit && binding.variantGitCommit === commit && binding.variantGitText !== undefined
    ? binding.variantGitText : binding.hub.readGitHeadText(binding.relativePath);
  if (commit) { binding.variantGitCommit = commit; binding.variantGitText = git; }
  const shared = binding.text.toString();
  const local = localFileText(binding) ?? binding.personalText;
  const selection = localisationSelectionChanges(git, shared, local);
  binding.personalSelectionRevision = crypto.randomUUID();
  binding.personalSelectionGit = git;
  binding.personalSelectionShared = shared;
  binding.personalSelectionLocal = local;
  return {
    shared, mine: binding.personalText,
    mineRevision: crypto.createHash('sha256').update(binding.personalText).digest('hex'),
    git,
    contributors: binding.personalContributors,
    conflicts: binding.personalConflicts,
    gitConflicts: binding.personalGitConflicts,
    localSelections: binding.personalSelectionStale ? [] : selection.entries,
    localSelectionBlocked: binding.personalSelectionStale
      ? 'Git HEAD изменился после сохранения локальных выборов. Рабочий файл не перезаписывается; проверьте его перед продолжением.'
      : selection.blockedReason,
    localSelectionRevision: binding.personalSelectionRevision,
  };
}

function sendVariants(client, state, absolutePath, payload) {
  const message = { type: 'documentVariants', path: absolutePath,
    contributors: payload.contributors, conflicts: payload.conflicts,
    gitConflicts: payload.gitConflicts, localSelections: payload.localSelections,
    localSelectionBlocked: payload.localSelectionBlocked,
    localSelectionRevision: payload.localSelectionRevision };
  const compact = client.reviewCrdt && client.compactVariants && state.reviewSynced;
  if (!state.variantSharedSent && !compact) {
    message.sharedBase64 = Buffer.from(payload.shared, 'utf8').toString('base64');
    state.variantSharedSent = true;
  }
  if (state.variantGitText !== payload.git) {
    message.gitBase64 = Buffer.from(payload.git, 'utf8').toString('base64');
    state.variantGitText = payload.git;
  }
  if (state.variantMineText !== payload.mine) {
    const baseRevision = state.variantMineRevision ?? '';
    const patch = !(compact && payload.mine === payload.git) && typeof state.variantMineText === 'string'
      ? computeSingleReplace(state.variantMineText, payload.mine) : null;
    if (compact && payload.mine === payload.git) message.mineFromGit = true;
    else if (patch && Buffer.byteLength(patch.insertText, 'utf8') < Buffer.byteLength(payload.mine, 'utf8') / 2) {
      message.minePatch = { positionByte: patch.positionByte, deleteBytes: patch.deleteBytes,
        insertBase64: Buffer.from(patch.insertText, 'utf8').toString('base64') };
      message.mineBaseRevision = baseRevision;
    } else message.mineBase64 = Buffer.from(payload.mine, 'utf8').toString('base64');
    state.variantMineText = payload.mine;
    state.variantMineRevision = payload.mineRevision;
  }
  message.mineRevision = payload.mineRevision;
  client.send(message);
}

export function emitDocumentVariants(binding, onlyClient = null) {
  if (binding.ticketId || !binding.personalReady) return;
  const payload = variantsPayload(binding);
  for (const client of binding.clients) {
    if (onlyClient && client !== onlyClient) continue;
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised || client.kind !== 'review') continue;
      sendVariants(client, state, absolutePath, payload);
    }
  }
}

export function resetPersonalRequest(binding) {
  clearTimeout(binding.personalRefreshTimer);
  binding.personalRefreshTimer = null;
  binding.personalRefreshStartedAt = null;
  clearTimeout(binding.personalRequestTimer);
  binding.personalRequestTimer = null;
  binding.personalRequestId = '';
  binding.personalRefreshPending = false;
  binding.personalReady = Boolean(binding.ticketId);
  binding.variantRequests.clear();
  binding.personalSelectionMigrationSent = false;
}

export function schedulePersonalDocumentRefresh(binding) {
  if (!binding.personalReady) { requestPersonalDocument(binding); return; }
  const now = Date.now();
  binding.personalRefreshStartedAt ??= now;
  const remaining = PERSONAL_REFRESH_MAX_WAIT_MS - (now - binding.personalRefreshStartedAt);
  clearTimeout(binding.personalRefreshTimer);
  binding.personalRefreshTimer = setTimeout(() => {
    binding.personalRefreshTimer = null;
    binding.personalRefreshStartedAt = null;
    requestPersonalDocument(binding);
  }, Math.max(0, Math.min(PERSONAL_REFRESH_DELAY_MS, remaining)));
  binding.personalRefreshTimer.unref?.();
}

export function seedAttachedDocument(binding) {
  if (!binding.canSeed || !binding.synced || !binding.gitWritable || binding.text.length) return false;
  for (const client of binding.clients) {
    for (const state of client.documents.values()) {
      if (state.binding !== binding || !state.mirror) continue;
      binding.canSeed = false;
      resetPersonalRequest(binding);
      binding.document.transact(() => binding.text.insert(0, state.mirror), state.origin);
      return true;
    }
  }
  return false;
}

export function requestPersonalDocument(binding) {
  if (binding.ticketId || binding.closing || binding.paused || !binding.synced || binding.socket?.readyState !== WebSocket.OPEN) return;
  if (binding.personalRequestId) {
    binding.personalRefreshPending = true;
    return;
  }
  binding.personalRequestId = crypto.randomUUID();
  binding.personalRequestTimer = setTimeout(() => {
    resetPersonalRequest(binding);
    requestPersonalDocument(binding);
  }, 10_000);
  binding.personalRequestTimer.unref?.();
  binding.socket.send(JSON.stringify({
    type: 'personal-projection-get', requestId: binding.personalRequestId,
    baseRevision: binding.personalRevision ?? '',
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
      variantEpoch: variantRequest.variantEpoch,
      textBase64: message.textBase64,
    });
    return;
  }
  if (!binding.personalRequestId || message.requestId !== binding.personalRequestId) return;
  binding.personalRequestId = '';
  clearTimeout(binding.personalRequestTimer);
  binding.personalRequestTimer = null;
  const refreshPending = binding.personalRefreshPending;
  binding.personalRefreshPending = false;
  const wasReady = binding.personalReady;
  let projected;
  if (message.patch) {
    if (!wasReady || message.baseRevision !== binding.personalRevision) {
      requestPersonalDocument(binding);
      return;
    }
    projected = applyUtf8ByteEdit(
      binding.serverPersonalText ?? binding.personalText, Number(message.patch.positionByte),
      Number(message.patch.deleteBytes), Buffer.from(message.patch.insertBase64 ?? '', 'base64').toString('utf8'),
    );
  } else {
    projected = Buffer.from(message.textBase64 ?? '', 'base64').toString('utf8');
  }
  binding.serverPersonalText = projected;
  let saved = binding.personalSelectionSnapshot;
  const git = saved ? binding.hub.readGitHeadText(binding.relativePath) : '';
  if (saved && saved.text.replace(/\r\n/gu, '\n') === git.replace(/\r\n/gu, '\n')) {
    binding.hub.clearPersonalSelection?.(binding.relativePath);
    binding.personalSelectionSnapshot = null;
    saved = null;
  }
  binding.personalSelectionStale = Boolean(saved
    && crypto.createHash('sha256').update(git).digest('hex') !== saved.gitHash);
  if (saved && projected === saved.text) {
    binding.hub.clearPersonalSelection?.(binding.relativePath);
    binding.personalSelectionSnapshot = null;
    binding.personalSelectionMigrationSent = false;
    saved = null;
  }
  let migrationSentNow = false;
  if (saved && !binding.personalSelectionStale && !binding.personalSelectionMigrationSent
    && binding.socket?.readyState === WebSocket.OPEN) {
    binding.personalSelectionMigrationSent = true;
    migrationSentNow = true;
    binding.socket.send(JSON.stringify({ type: 'personal-projection-set', text: saved.text,
      author: binding.hub.options.user, color: binding.hub.options.color }));
  }
  binding.personalText = saved && !binding.personalSelectionStale ? saved.text : projected;
  binding.personalRevision = String(message.revision ?? '');
  binding.personalReady = true;
  binding.personalContributors = message.contributors ?? [];
  binding.personalConflicts = message.conflicts ?? [];
  binding.personalGitConflicts = message.gitConflicts ?? [];
  const publish = !refreshPending || !wasReady;
  if (publish) binding.initialiseAttachedClients();
  // A superseded projection is still the base of the next patch, but it is
  // never shown. Do not parse three complete localisation variants for it.
  if (!publish) binding.personalSelectionRevision = '';
  const payload = publish ? variantsPayload(binding) : null;
  for (const client of publish ? binding.clients : []) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding || !state.initialised) continue;
      binding.reconcileInitialDisk(client, absolutePath, state);
      binding.syncClientView(client, absolutePath);
      if (client.kind === 'review') {
        sendVariants(client, state, absolutePath, payload);
        client.scheduleMaterialisation?.(absolutePath);
      }
    }
  }
  if (refreshPending || migrationSentNow) requestPersonalDocument(binding);
}

export function requestDocumentVariant(binding, client, absolutePath, authorId, variantEpoch = '') {
  if (binding.ticketId || !binding.synced || binding.socket?.readyState !== WebSocket.OPEN) return;
  const requestId = crypto.randomUUID();
  binding.variantRequests.set(requestId, { client, absolutePath, authorId, variantEpoch });
  binding.socket.send(JSON.stringify({
    type: 'personal-projection-get', requestId, subjectAuthorId: authorId,
    author: binding.hub.options.user, color: binding.hub.options.color,
  }));
}

export function replacePersonalDocument(binding, text) {
  if (binding.personalSelectionSnapshot) {
    binding.hub.clearPersonalSelection?.(binding.relativePath);
    binding.personalSelectionSnapshot = null;
    binding.personalSelectionStale = false;
  }
  binding.personalText = String(text ?? '');
  binding.serverPersonalText = binding.personalText;
  binding.personalReady = true;
  binding.personalGitConflicts = [];
  binding.personalRevision = '';
  if (binding.ticketId || binding.closing || binding.paused || !binding.synced
    || binding.socket?.readyState !== WebSocket.OPEN) return false;
  resetPersonalRequest(binding);
  binding.socket.send(JSON.stringify({
    type: 'personal-projection-set',
    text: binding.personalText,
    author: binding.hub.options.user,
    color: binding.hub.options.color,
  }));
  requestPersonalDocument(binding);
  return true;
}

export function localFileText(binding) {
  const text = binding.personalMaterialisationMode === 'git'
    ? binding.hub.readGitHeadText(binding.relativePath)
    : (binding.ticketId ? binding.text.toString()
      : binding.personalReady && !binding.personalSelectionStale
        && !binding.personalGitConflicts?.length ? binding.personalText : null);
  // Wire snapshots and their byte patches retain the server's exact encoding.
  // Disk comparisons instead use LF, just like readDiskText and secure writes.
  return text === null ? null : normaliseLineEndings(text);
}

export function setPersonalMaterialisation(binding, mode, absolutePath) {
  if (binding.ticketId || !['git', 'mine'].includes(mode)) return;
  if (mode === 'git' && binding.personalSelectionStale) {
    binding.hub.clearPersonalSelection?.(binding.relativePath);
    binding.personalSelectionSnapshot = null;
    binding.personalSelectionStale = false;
  }
  binding.personalMaterialisationMode = mode;
  binding.hub.savePersonalMode(binding.relativePath, mode).catch(() => {});
  emitDocumentVariants(binding);
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

export function setPersonalSelection(binding, absolutePath, changeId, include, revision) {
  if (binding.ticketId || !binding.synced || !binding.gitWritable || binding.personalGitConflicts?.length
    || binding.personalSelectionStale) return false;
  const git = binding.hub.readGitHeadText(binding.relativePath);
  const shared = binding.text.toString();
  if (!revision || revision !== binding.personalSelectionRevision
    || git !== binding.personalSelectionGit || shared !== binding.personalSelectionShared
    || localFileText(binding) !== binding.personalSelectionLocal) return false;
  const current = localFileText(binding);
  if (current === null) return false;
  let next;
  try {
    next = setLocalisationSelection(git, shared, current, changeId, include);
  } catch {
    requestPersonalDocument(binding);
    return false;
  }
  binding.personalMaterialisationMode = 'mine';
  binding.hub.savePersonalMode(binding.relativePath, 'mine').catch(() => {});
  replacePersonalDocument(binding, next);
  emitDocumentVariants(binding);
  for (const client of binding.clients) {
    const state = client.documents.get(absolutePath);
    if (!state || state.binding !== binding) continue;
    binding.syncClientView(client, absolutePath);
    client.scheduleMaterialisation?.(absolutePath);
  }
  return true;
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
    state.mirror = nextVisible;
    binding.personalText = nextVisible;
    binding.queueExternalMerge(client, absolutePath, state, previousVisible, nextVisible,
      'Изменения объединены с совместным документом.');
    if (binding.personalMaterialisationMode === 'git') {
      binding.personalMaterialisationMode = 'mine';
      binding.hub.savePersonalMode(binding.relativePath, 'mine').catch(() => {});
    }
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
