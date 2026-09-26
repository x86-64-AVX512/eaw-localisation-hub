import crypto from 'node:crypto';
import * as Y from 'yjs';
import { closeDocument } from './document-lifecycle.mts';
import type { LifecycleBinding, LifecycleClient } from './document-lifecycle.mts';

const SOCKET_OPEN = 1; // WebSocket.OPEN

interface DeliveryBinding extends LifecycleBinding {
  documentId: string;
  document: Y.Doc;
  hub: LifecycleBinding['hub'] & {
    loadPendingDocumentUpdate?(documentId: string): Uint8Array | null | undefined;
  };
  clients: Iterable<LifecycleClient>;
  socket: { readyState: number; send(data: string | Uint8Array): void; close(): void } | null;
  synced: boolean;
  gitWritable: boolean;
  localUpdatePending: boolean;
  pendingUpdateSent: boolean;
  deliveryFailed: boolean;
  flushWaiter: { id: string; finish(succeeded: boolean): void } | null;
  closePromise?: Promise<void>;
}

export function restorePendingDocument(binding: DeliveryBinding): void {
  const update = binding.hub.loadPendingDocumentUpdate?.(binding.documentId);
  if (!update) return;
  Y.applyUpdate(binding.document, update);
  binding.localUpdatePending = true;
}

export function forwardLocalUpdate(binding: DeliveryBinding, update: Uint8Array, isLocal: boolean): void {
  if (!isLocal) return;
  binding.localUpdatePending = true;
  if (!binding.synced || !binding.gitWritable || binding.socket?.readyState !== SOCKET_OPEN) return;
  binding.socket.send(update);
  binding.pendingUpdateSent = true;
}

export function handleSocketClose(binding: DeliveryBinding): void {
  binding.flushWaiter?.finish(false);
  binding.pendingUpdateSent = false;
}

export function handleFlushAcknowledgement(binding: DeliveryBinding,
  message: { type: string; requestId?: string }): boolean {
  if (message.type !== 'sync-flushed') return false;
  const waiter = binding.flushWaiter;
  if (waiter && waiter.id === message.requestId) waiter.finish(true);
  return true;
}

export function handleServerError(binding: DeliveryBinding, message: { message: string }): void {
  binding.deliveryFailed = true;
  console.error('[agent] server rejected an operation');
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding === binding) client.send({ type: 'error', path: absolutePath, message: message.message });
    }
  }
}

export function flushToServer(binding: DeliveryBinding, timeoutMilliseconds = 5000): Promise<boolean> {
  const socket = binding.socket;
  if (!socket || socket.readyState !== SOCKET_OPEN) return Promise.resolve(false);
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    timer.unref?.();
    const finish = (succeeded: boolean) => {
      clearTimeout(timer);
      if (binding.flushWaiter?.id === id) binding.flushWaiter = null;
      resolve(succeeded && !binding.deliveryFailed);
    };
    binding.flushWaiter = { id, finish };
    try { socket.send(JSON.stringify({ type: 'sync-flush', requestId: id })); }
    catch { finish(false); }
  });
}

export function closeBinding(binding: DeliveryBinding): Promise<void> {
  binding.closePromise ??= closeDocument(binding);
  return binding.closePromise;
}
