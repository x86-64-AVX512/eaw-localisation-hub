import { PROTOCOL_VERSION } from '../../../packages/shared/src/constants.mts';
import * as actions from './document-actions.mjs';
import * as disk from './disk-reconciliation.mjs';
import * as diskRequests from './disk-merge-request.mjs';
import * as gitState from './git-document-state.mjs';
import * as delivery from './document-delivery.mts';
import * as personalDocument from './personal-document.mjs';

// Applies one validated server control message to a DocumentBinding. Kept apart
// from the binding lifecycle so new message types do not grow the coordinator.
export function receiveServerMessage(binding, message) {
  if (message.type === 'reservation-update-result') {
    actions.receiveReservationUpdateResult(binding, message);
    return;
  }
  if (message.type === 'disk-merge-result') {
    diskRequests.receiveDiskMergeResult(binding, message);
    return;
  }
  if (message.type === 'tickets-changed') {
    for (const client of binding.clients) {
      if (client.kind === 'review') client.send({ type: 'ticketCatalogChanged', revision: message.revision });
    }
    return;
  }
  if (delivery.handleFlushAcknowledgement(binding, message)) return;
  if (message.type === 'synced') {
    if (message.protocol !== PROTOCOL_VERSION) {
      binding.paused = true;
      binding.gitWritable = false;
      for (const client of binding.clients) client.send({ type: 'notice',
        message: `Несовместимый протокол: сервер ${message.protocol}, Agent ${PROTOCOL_VERSION}. Обновите клиент и сервер.` });
      binding.socket?.close(1002, 'Protocol version mismatch');
      return;
    }
    gitState.applySyncedMessage(binding, message);
    disk.retryPendingDiskMerges(binding);
    return;
  }
  if (message.type === 'git-status') {
    gitState.applyGitStatus(binding, message);
    if (binding.gitWritable) disk.retryPendingDiskMerges(binding);
    return;
  }
  if (message.type === 'reservations') {
    binding.reservations = new Map((message.reservations ?? []).map((item) => [item.id, item]));
    binding.reservationRevision += 1;
    binding.emitReservations();
    return;
  }
  if (message.type === 'review') {
    binding.commentThreads = new Map((message.commentThreads ?? []).map((item) => [item.id, item]));
    binding.suggestions = new Map((message.suggestions ?? []).map((item) => [item.id, item]));
    binding.reviewRevision += 1;
    binding.emitReview();
    return;
  }
  if (message.type === 'directory') {
    binding.hub.updateDirectory(message.users ?? []);
    return;
  }
  if (message.type === 'history') {
    binding.history = message.entries ?? [];
    binding.historyHeadId = message.headId ?? '';
    binding.emitHistory();
    personalDocument.schedulePersonalDocumentRefresh(binding);
    return;
  }
  if (message.type === 'history-version') {
    binding.hub.rememberHistoryVersion?.(binding, message);
    for (const client of binding.clients) {
      if (client.kind !== 'review') continue;
      for (const [absolutePath, state] of client.documents) {
        if (state.binding === binding) client.send({
          type: 'historyVersion', path: absolutePath, id: message.id, textBase64: message.textBase64,
        });
      }
    }
    return;
  }
  if (message.type === 'personal-projection') {
    personalDocument.handlePersonalDocument(binding, message);
    return;
  }
  if (message.type === 'presence') {
    if (message.clientId && !binding.hub.isLocalPresenceId(message.clientId)) {
      binding.presences.set(message.clientId, message);
      binding.emitPresences();
      binding.emitReservationTargets();
    }
    return;
  }
  if (message.type === 'presence-left') {
    if (message.clientId) binding.presences.delete(message.clientId);
    binding.emitPresences();
    binding.emitReservationTargets();
    return;
  }
  if (message.type === 'error') delivery.handleServerError(binding, message);
}
