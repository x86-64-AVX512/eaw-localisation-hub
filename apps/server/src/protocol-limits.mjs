import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  TRACKED_PATH_PATTERN,
} from '../../../packages/shared/src/constants.mjs';

const MAX_CONTROL_STRING_BYTES = 4096;
const INBOUND_BURST_BYTES = 16 * 1024 * 1024;
const INBOUND_REFILL_BYTES_PER_SECOND = 1024 * 1024;
const INBOUND_UPDATE_BURST = 100;
const INBOUND_UPDATE_REFILL_PER_SECOND = 20;

export class ProtocolLimitError extends Error {
  constructor(message, closeCode = 1008) {
    super(message);
    this.closeCode = closeCode;
  }
}

export function byteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return Number(value?.byteLength ?? value?.length ?? 0);
}

export function controlledString(
  value,
  label,
  maximumBytes = MAX_CONTROL_STRING_BYTES,
  { required = false } = {},
) {
  const result = String(value ?? '');
  if ((required && !result) || /[\u0000-\u001f\u007f]/u.test(result) || byteLength(result) > maximumBytes) {
    throw new ProtocolLimitError(`${label} is missing or exceeds the protocol limit`);
  }
  return result;
}

export function controlledText(value, label, maximumBytes, { required = false } = {}) {
  const result = String(value ?? '');
  if ((required && !result) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)
      || byteLength(result) > maximumBytes) {
    throw new ProtocolLimitError(`${label} is missing or exceeds the protocol limit`);
  }
  return result;
}

export function validDocumentId(documentId) {
  if (!documentId || byteLength(documentId) > 1024 || /[\u0000-\u001f\u007f\\]/u.test(documentId)) return false;
  const separator = documentId.indexOf(':');
  if (separator < 1 || separator > 255 || documentId.indexOf(':', separator + 1) >= 0) return false;
  const workspace = documentId.slice(0, separator);
  const relativePath = documentId.slice(separator + 1);
  if (workspace.startsWith('.') || workspace.startsWith('-') || workspace.endsWith('.')
      || workspace.includes('..') || workspace.includes('@{')) return false;
  if (!TRACKED_PATH_PATTERN.test(relativePath) || relativePath.includes('//')) return false;
  return !relativePath.split('/').some((part) => !part || part === '.' || part === '..');
}

export function sendWithBackpressure(socket, value, options = undefined) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const outgoingBytes = byteLength(value);
  if (outgoingBytes > MAX_MESSAGE_BYTES || socket.bufferedAmount + outgoingBytes > MAX_SOCKET_BUFFERED_BYTES) {
    socket.close(1013, 'Client is too slow');
    return false;
  }
  socket.send(value, options);
  return true;
}

export function createInboundBudget() {
  return { bytes: INBOUND_BURST_BYTES, updates: INBOUND_UPDATE_BURST, updatedAt: Date.now() };
}

export function consumeInboundBudget(socket, bytes, isUpdate) {
  const now = Date.now();
  const elapsed = Math.max(0, now - socket.inboundBudget.updatedAt) / 1000;
  socket.inboundBudget.bytes = Math.min(
    INBOUND_BURST_BYTES,
    socket.inboundBudget.bytes + elapsed * INBOUND_REFILL_BYTES_PER_SECOND,
  );
  socket.inboundBudget.updates = Math.min(
    INBOUND_UPDATE_BURST,
    socket.inboundBudget.updates + elapsed * INBOUND_UPDATE_REFILL_PER_SECOND,
  );
  socket.inboundBudget.updatedAt = now;
  if (bytes > socket.inboundBudget.bytes || (isUpdate && socket.inboundBudget.updates < 1)) {
    throw new ProtocolLimitError('Document update rate exceeded the server limit', 1008);
  }
  socket.inboundBudget.bytes -= bytes;
  if (isUpdate) socket.inboundBudget.updates -= 1;
}
