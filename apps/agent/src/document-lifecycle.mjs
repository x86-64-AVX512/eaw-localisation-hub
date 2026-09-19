import { resetPersonalRequest } from './personal-document.mjs';
import * as Y from 'yjs';

export function handleUnavailableTicketClose(binding, code, closeReason) {
  if (code !== 1001 || !binding.ticketId
    || !['Ticket deleted', 'Ticket file removed'].includes(closeReason)) return false;
  binding.paused = true;
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding === binding && client.kind === 'review') client.send({
        type: 'ticketUnavailable', path: absolutePath, ticketId: binding.ticketId,
        reason: closeReason === 'Ticket deleted' ? 'deleted' : 'file-removed',
      });
    }
  }
  return true;
}

export async function closeDocument(binding) {
  binding.closing = true;
  resetPersonalRequest(binding);
  if (binding.reconnectTimer) clearTimeout(binding.reconnectTimer);
  let pendingUpdate = null;
  if (binding.localUpdatePending) {
    // Keep the exact CRDT identities so a retry is idempotent even if the
    // server applied the update but its acknowledgement never reached us.
    pendingUpdate = Y.encodeStateAsUpdate(binding.document);
    binding.hub.savePendingDocumentUpdate(binding.documentId, pendingUpdate);
  }
  const flushed = await binding.flushToServer();
  if (flushed && binding.pendingUpdateSent && pendingUpdate) {
    binding.hub.clearPendingDocumentUpdate(binding.documentId, pendingUpdate);
  }
  binding.socket?.close();
  binding.localPresences.clear();
  for (const client of binding.clients) {
    for (const state of client.documents.values()) {
      if (state.binding !== binding) continue;
      if (state.diskDebounce) clearTimeout(state.diskDebounce);
      if (state.diskPollTimer) clearInterval(state.diskPollTimer);
      state.diskWatcher?.close();
    }
  }
  const pendingBaseWrites = [...binding.baseWrites];
  for (const client of binding.clients) {
    for (const state of client.documents.values()) {
      if (state.binding === binding) pendingBaseWrites.push(state.basePersistPromise);
    }
  }
  await Promise.allSettled(pendingBaseWrites);
  for (const undo of binding.undoManagers.values()) undo.destroy();
  binding.document.destroy();
}
