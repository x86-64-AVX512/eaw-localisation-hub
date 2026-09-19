import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { closeDocument } from './document-lifecycle.mjs';

export function initialiseDelivery(binding) {
  binding.localUpdatePending = false;
  binding.pendingUpdateSent = false;
  binding.deliveryFailed = false;
  binding.flushWaiter = null;
}

export function restorePendingDocument(binding) {
  const update = binding.hub.loadPendingDocumentUpdate?.(binding.documentId);
  if (!update) return;
  Y.applyUpdate(binding.document, update);
  binding.localUpdatePending = true;
}

export function forwardLocalUpdate(binding, update, isLocal) {
  if (!isLocal) return;
  binding.localUpdatePending = true;
  if (!binding.synced || !binding.gitWritable || binding.socket?.readyState !== WebSocket.OPEN) return;
  binding.socket.send(update);
  binding.pendingUpdateSent = true;
}

export function handleSocketClose(binding) {
  binding.flushWaiter?.finish(false);
  binding.pendingUpdateSent = false;
}

export function handleFlushAcknowledgement(binding, message) {
  if (message.type !== 'sync-flushed') return false;
  if (binding.flushWaiter?.id === message.requestId) binding.flushWaiter.finish(true);
  return true;
}

export function handleServerError(binding, message) {
  binding.deliveryFailed = true;
  console.error('[agent] server rejected an operation');
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      if (state.binding === binding) client.send({ type: 'error', path: absolutePath, message: message.message });
    }
  }
}

export function flushToServer(binding, timeoutMilliseconds = 5000) {
  if (binding.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    timer.unref?.();
    const finish = (succeeded) => {
      clearTimeout(timer);
      if (binding.flushWaiter?.id === id) binding.flushWaiter = null;
      resolve(succeeded && !binding.deliveryFailed);
    };
    binding.flushWaiter = { id, finish };
    try { binding.socket.send(JSON.stringify({ type: 'sync-flush', requestId: id })); }
    catch { finish(false); }
  });
}

export function closeBinding(binding) {
  binding.closePromise ??= closeDocument(binding);
  return binding.closePromise;
}
