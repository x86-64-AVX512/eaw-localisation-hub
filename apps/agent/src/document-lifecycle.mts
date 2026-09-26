import { resetPersonalRequest } from './personal-document.mjs';
import * as Y from 'yjs';

export interface LifecycleDocumentState {
  binding: unknown;
  diskDebounce?: ReturnType<typeof setTimeout> | null;
  diskPollTimer?: ReturnType<typeof setInterval> | null;
  diskWatcher?: { close(): void } | null;
  basePersistPromise: Promise<unknown>;
}

export interface LifecycleClient {
  kind: string;
  documents: ReadonlyMap<string, LifecycleDocumentState>;
  send(message: { type: string; path: string; message?: string; ticketId?: string; reason?: string }): void;
}

export interface LifecycleBinding {
  ticketId: string;
  paused: boolean;
  closing: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  localUpdatePending: boolean;
  pendingUpdateSent: boolean;
  documentId: string;
  document: Y.Doc;
  hub: {
    savePendingDocumentUpdate(documentId: string, update: Uint8Array): void;
    clearPendingDocumentUpdate(documentId: string, update: Uint8Array): unknown;
  };
  flushToServer(): Promise<boolean>;
  socket: { close(): void } | null;
  localPresences: { clear(): void };
  clients: Iterable<LifecycleClient>;
  baseWrites: Iterable<Promise<unknown>>;
  undoManagers: ReadonlyMap<string, { destroy(): void }>;
  emitDocumentStatus(status: string): unknown;
}

export function handleMergedBranchClose(binding: LifecycleBinding, code: number): boolean {
  if (code !== 4002 || binding.ticketId) return false;
  binding.paused = true;
  binding.emitDocumentStatus('git-branch-merged');
  for (const client of binding.clients) client.send({
    type: 'notice', path: '',
    message: 'Ветка влита в general-dev. Комментарии и тикеты перенесены; переключите локальный Git на general-dev.',
  });
  return true;
}

export function handleUnavailableTicketClose(binding: LifecycleBinding,
  code: number, closeReason: string): boolean {
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

export async function closeDocument(binding: LifecycleBinding): Promise<void> {
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
