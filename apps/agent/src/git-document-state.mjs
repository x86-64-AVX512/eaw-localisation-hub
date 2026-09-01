import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { currentGitFileBlob } from './git-ticket-context.mjs';
import { preserveChangedFile } from './git-recovery.mjs';

export function appendGitHead(binding, url) {
  if (binding.ticketId) return;
  const head = binding.hub.currentDocumentGitCommit();
  if (head) url.searchParams.set('head', head);
  try {
    const blob = currentGitFileBlob(binding.hub.options.repo, binding.relativePath);
    if (blob) url.searchParams.set('blob', blob);
  } catch {
    // A missing committed file is reported by the canonical server as file-outdated.
  }
}

export function applySyncedGit(binding, message) {
  binding.gitState = message.git ?? null;
  binding.gitWritable = !binding.gitState
    || ['current', 'branch-outdated'].includes(binding.gitState.status);
  return binding.gitWritable;
}

export function documentStatus(gitState) {
  if (!gitState || gitState.status === 'current') return 'online';
  if (gitState.status === 'branch-outdated') return 'git-branch-outdated';
  if (gitState.status === 'conflict') return 'git-conflict';
  return 'git-file-outdated';
}

export function applySyncedMessage(binding, message) {
  binding.reservations = new Map((message.reservations ?? []).map((item) => [item.id, item]));
  binding.commentThreads = new Map((message.commentThreads ?? []).map((item) => [item.id, item]));
  binding.suggestions = new Map((message.suggestions ?? []).map((item) => [item.id, item]));
  binding.history = message.history ?? [];
  binding.historyHeadId = message.historyHeadId ?? '';
  binding.presences = new Map((message.presences ?? []).map((item) => [item.clientId, item]));
  binding.canSeed = message.canSeed === true;
  applySyncedGit(binding, message);
  if (message.identity?.displayName) binding.hub.updateIdentity(message.identity);
  binding.hub.updateDirectory(message.directory ?? []);
  binding.synced = true;
  if (binding.gitWritable) binding.socket.send(Y.encodeStateAsUpdate(binding.document));
  binding.requestPersonalDocument();
  binding.localPresences.replay();
  if (binding.gitWritable) binding.initialiseAttachedClients();
  binding.scheduleRefresh();
  binding.emitDocumentStatus(documentStatus(binding.gitState));
  preserveChangedFile(binding, binding.gitState).then((savedPath) => {
    if (!savedPath) return;
    for (const client of binding.clients) client.send({
      type: 'notice', message: `Сохранена копия локальных изменений: ${savedPath}`,
    });
  }).catch(() => {});
}

export function applyGitStatus(binding, message) {
  binding.gitState = message;
  binding.gitWritable = ['current', 'branch-outdated'].includes(message.status);
  if (binding.gitWritable) binding.initialiseAttachedClients();
  binding.emitDocumentStatus(documentStatus(binding.gitState));
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding !== binding) continue;
      client.send({ type: 'externalConflictReset', path: absolutePath, source: 'canonical' });
      if (message.status !== 'conflict') continue;
      for (const conflict of message.conflicts ?? []) client.send({
        type: 'externalConflict', path: absolutePath,
        source: 'canonical',
        key: conflict.key, label: conflict.label, detail: conflict.detail,
        baseLine: conflict.baseLine ?? '',
        collaborativeLine: conflict.collaborativeLine ?? '',
        externalLine: conflict.externalLine ?? '',
      });
    }
  }
  preserveChangedFile(binding, message).then((savedPath) => {
    if (!savedPath) return;
    for (const client of binding.clients) client.send({
      type: 'notice',
      message: `Перед блокировкой сохранена копия локальных изменений: ${savedPath}`,
    });
  }).catch(() => {});
}

export function reconnectForGitHead(binding) {
  if (binding.ticketId || binding.closing || binding.paused) return;
  binding.synced = false;
  binding.gitWritable = false;
  binding.emitDocumentStatus('syncing');
  if (binding.socket?.readyState === WebSocket.OPEN || binding.socket?.readyState === WebSocket.CONNECTING) {
    binding.socket.close();
  } else binding.scheduleReconnect();
}

export function resolveCanonicalConflict(binding, message) {
  if (binding.gitState?.status !== 'conflict') return false;
  if (message.source && message.source !== 'canonical') return false;
  binding.socket?.send(JSON.stringify({
    type: 'git-conflict-resolve', key: String(message.key ?? ''), choice: String(message.choice ?? ''),
  }));
  return true;
}
