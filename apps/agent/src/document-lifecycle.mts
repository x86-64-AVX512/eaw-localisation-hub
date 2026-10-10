import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  send(message: { type: string; path?: string; message?: string; ticketId?: string; reason?: string }): void;
}

interface TicketRecovery {
  text: string;
  savedPath: string;
  announced: boolean;
  recipients: LifecycleClient[];
  attempt: Promise<boolean>;
}

export interface LifecycleBinding {
  ticketId: string;
  relativePath?: string;
  ticketUnavailable?: boolean;
  ticketRemovedLocally?: boolean;
  ticketDiscardErrorReported?: boolean;
  ticketRecovery?: TicketRecovery;
  gitWritable?: boolean;
  paused: boolean;
  closing: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  localUpdatePending: boolean;
  pendingUpdateSent: boolean;
  documentId: string;
  document: Y.Doc;
  hub: {
    options?: { state: string };
    consumeTicketRemoval?(documentId: string, closeReason: string): boolean;
    discardPendingDocumentUpdate?(documentId: string): void;
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
  // Keep all locally changed text, even if an earlier update was sent: send()
  // does not confirm durability or cover edits made while the socket closes.
  binding.ticketUnavailable = true;
  binding.gitWritable = false;
  // A ticket or file this user removed through this Agent is discarded on
  // purpose: a copy and a notice after every finished ticket would be noise.
  binding.ticketRemovedLocally = binding.hub.consumeTicketRemoval?.(binding.documentId, closeReason) === true;
  void recoverDeletedTicket(binding);
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

function recoverDeletedTicket(binding: LifecycleBinding): Promise<boolean> {
  if (binding.ticketRemovedLocally) {
    try {
      binding.hub.discardPendingDocumentUpdate?.(binding.documentId);
      return Promise.resolve(true);
    } catch (error) {
      console.error('[agent] deleted ticket buffer removal failed');
      let detail = error instanceof Error ? error.message : String(error);
      // Keep the latest state, not merely the older buffer that failed to unlink.
      try {
        if (binding.localUpdatePending) binding.hub.savePendingDocumentUpdate(
          binding.documentId, Y.encodeStateAsUpdate(binding.document));
      } catch (checkpointError) {
        detail += `; ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`;
      }
      if (!binding.ticketDiscardErrorReported) {
        binding.ticketDiscardErrorReported = true;
        for (const client of binding.clients) {
          try { client.send({ type: 'notice',
            message: `Не удалось удалить буфер удалённого тикета: ${detail}. Буфер восстановления не удалён.` }); }
          catch { /* A disconnected peer must not break document cleanup. */ }
        }
      }
      return Promise.resolve(false);
    }
  }
  if (!binding.localUpdatePending) return Promise.resolve(true);
  const text = binding.document.getText('content').toString();
  const previous = binding.ticketRecovery;
  // An edit already in flight from Review can still land after the first
  // checkpoint; closing must not settle for the older text.
  if (previous?.text === text) return previous.attempt;
  const recovery: TicketRecovery = { text, savedPath: '', announced: false,
    recipients: previous?.recipients ?? [...binding.clients], attempt: Promise.resolve(false) };
  binding.ticketRecovery = recovery;
  recovery.attempt = preserveUnconfirmedTicketText(binding, recovery, previous);
  return recovery.attempt;
}

// Checkpoint synchronously before notifying Review (which may detach at once).
// Only a successfully written and synced readable copy may retire that exact
// checkpoint. A failed copy or a newer retry buffer must remain recoverable.
async function preserveUnconfirmedTicketText(binding: LifecycleBinding,
  recovery: TicketRecovery, previous?: TicketRecovery): Promise<boolean> {
  const notify = (message: string) => {
    for (const client of recovery.recipients) {
      try { client.send({ type: 'notice', message }); }
      catch { /* A disconnected peer cannot invalidate the recovery copy. */ }
    }
  };
  let temporary = '';
  try {
    const update = Y.encodeStateAsUpdate(binding.document);
    binding.hub.savePendingDocumentUpdate(binding.documentId, update);
    // One writer at a time: a later text replaces the earlier copy of this ticket.
    await previous?.attempt;
    const state = binding.hub.options?.state;
    if (!state) throw new Error('Agent state directory is unavailable');
    const directory = path.join(state, 'git-recovery', 'deleted-ticket');
    const name = path.basename(binding.relativePath ?? 'ticket.yml');
    recovery.savedPath = previous?.savedPath || path.join(directory, `${name}.${crypto.randomUUID()}.yml`);
    await fs.mkdir(directory, { recursive: true });
    // Readers never see a partial copy, and a failed rewrite keeps the older one.
    temporary = `${recovery.savedPath}.${crypto.randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(recovery.text, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, recovery.savedPath);
    temporary = '';
    binding.hub.clearPendingDocumentUpdate(binding.documentId, update);
    recovery.announced = previous?.announced === true;
    if (!recovery.announced) notify(`Тикет удалён. Неподтверждённые правки сохранены: ${recovery.savedPath}`);
    recovery.announced = true;
    return true;
  } catch (error) {
    console.error('[agent] deleted ticket recovery failed');
    if (temporary) await fs.unlink(temporary).catch(() => {});
    recovery.savedPath ||= previous?.savedPath ?? '';
    recovery.announced = previous?.announced === true;
    const detail = error instanceof Error ? error.message : String(error);
    notify(`Не удалось сохранить копию правок удалённого тикета: ${detail}. Буфер восстановления не удалён.`);
    return false;
  }
}

export async function closeDocument(binding: LifecycleBinding): Promise<void> {
  binding.closing = true;
  resetPersonalRequest(binding);
  if (binding.reconnectTimer) clearTimeout(binding.reconnectTimer);
  let pendingUpdate = null;
  if (binding.ticketUnavailable) await recoverDeletedTicket(binding);
  else if (binding.localUpdatePending) {
    // Keep the exact CRDT identities so a retry is idempotent even if the
    // server applied the update but its acknowledgement never reached us.
    pendingUpdate = Y.encodeStateAsUpdate(binding.document);
    binding.hub.savePendingDocumentUpdate(binding.documentId, pendingUpdate);
  }
  const flushed = await binding.flushToServer();
  // Deletion can also arrive while the ordinary close is awaiting its flush.
  if (binding.ticketUnavailable) await recoverDeletedTicket(binding);
  else if (flushed && binding.pendingUpdateSent && pendingUpdate) {
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
