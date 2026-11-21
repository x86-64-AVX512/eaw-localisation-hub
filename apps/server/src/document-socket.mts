import {
  MAX_QUEUED_INBOUND_BYTES,
  MAX_TOTAL_QUEUED_INBOUND_BYTES,
  ProtocolLimitError,
  byteLength,
  consumeInboundBudget,
  sendWithBackpressure,
} from './protocol-limits.mts';
import type { InboundBudget } from './protocol-limits.mts';

interface DocumentSocket {
  readyState: number;
  bufferedAmount: number;
  inboundBudget: InboundBudget;
  messageQueue?: Promise<void>;
  queuedInboundBytes?: number;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  send(value: string | Uint8Array, options?: unknown): void;
  close(code: number, reason: string): void;
}

interface DocumentRoomPort {
  clientWritable(socket: DocumentSocket): boolean;
  flush(): Promise<unknown> | unknown;
  receiveBinary(socket: DocumentSocket, data: Buffer, recheckWritable: () => void): Promise<unknown> | unknown;
  receiveJson(socket: DocumentSocket, control: Record<string, unknown>,
    recheckWritable: () => void): Promise<unknown> | unknown;
}

interface DocumentSocketOptions {
  socket: DocumentSocket;
  documentId: string;
  room: DocumentRoomPort;
  ticketStore: { documentWritable(documentId: string): boolean };
  isShuttingDown(): boolean;
  authoriseSession(): void;
}

let totalQueuedInboundBytes = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function attachDocumentSocket({
  socket, documentId, room, ticketStore, isShuttingDown, authoriseSession,
}: DocumentSocketOptions): void {
  const writableError = (isBinary: boolean, control: Record<string, unknown> | null): string => {
    const controlType = typeof control?.type === 'string' ? control.type : '';
    if (!ticketStore.documentWritable(documentId)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'disk-merge-check', 'sync-flush'].includes(controlType))) {
      return 'Ticket is read-only';
    }
    if (!room.clientWritable(socket)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'disk-merge-check', 'git-conflict-resolve', 'sync-flush'].includes(controlType))) {
      return 'The local Git version of this file is not canonical';
    }
    return '';
  };
  socket.messageQueue = Promise.resolve();
  const respondError = (control: Record<string, unknown> | null, message: string) => {
    // Echo only a bounded string id: a deeply nested JSON value parses fine but
    // overflows the stack when serialised again.
    const id = typeof control?.id === 'string' && control.id.length <= 128 ? control.id : '';
    if (typeof control?.requestId === 'string' && control.requestId.length > 0 && control.requestId.length <= 128
      && ['comment-create', 'comment-reply', 'suggestion-reply', 'discussion-message-update', 'discussion-message-delete'].includes(String(control.type))) {
      sendWithBackpressure(socket, JSON.stringify({ type: 'discussion-result', requestId: control.requestId,
        id, status: 'error', message }));
    } else if (control?.type === 'reservation-update' && typeof control.requestId === 'string'
      && control.requestId.length > 0 && control.requestId.length <= 128
      && typeof control.id === 'string' && control.id.length > 0 && control.id.length <= 128) {
      sendWithBackpressure(socket, JSON.stringify({ type: 'reservation-update-result', requestId: control.requestId,
        id: control.id, status: 'error',
        message: 'Не удалось изменить бронь. Проверьте права, исполнителя, примечание и выделение.' }));
    } else sendWithBackpressure(socket, JSON.stringify({ type: 'error', message }));
  };
  socket.on('message', (data, isBinary) => {
    if (isShuttingDown()) return;
    // Charge a fixed overhead per frame: empty frames still cost a queued task each.
    const queuedBytes = byteLength(data) + 1024;
    if ((socket.queuedInboundBytes ?? 0) + queuedBytes > MAX_QUEUED_INBOUND_BYTES
      || totalQueuedInboundBytes + queuedBytes > MAX_TOTAL_QUEUED_INBOUND_BYTES) {
      socket.close(1013, 'Inbound message queue limit exceeded');
      return;
    }
    socket.queuedInboundBytes = (socket.queuedInboundBytes ?? 0) + queuedBytes;
    totalQueuedInboundBytes += queuedBytes;
    socket.messageQueue = (socket.messageQueue ?? Promise.resolve()).then(async () => {
      let control: Record<string, unknown> | null = null;
      try {
        authoriseSession();
        const parsed: unknown = isBinary ? null : JSON.parse(data.toString('utf8'));
        if (!isBinary && !isRecord(parsed)) throw new Error('Invalid document control message');
        control = isBinary ? null : parsed as Record<string, unknown>;
        const blocked = writableError(isBinary, control);
        if (blocked) {
          respondError(control, blocked);
          return;
        }
        const recheckWritable = () => {
          authoriseSession();
          const message = writableError(isBinary, control);
          if (message) throw new Error(message);
        };
        consumeInboundBudget(socket, byteLength(data), isBinary);
        if (!isBinary && control?.type === 'sync-flush') {
          if (typeof control.requestId !== 'string' || !/^[0-9a-f-]{36}$/u.test(control.requestId)) {
            throw new Error('Invalid sync flush request');
          }
          await room.flush();
          sendWithBackpressure(socket, JSON.stringify({ type: 'sync-flushed', requestId: control.requestId }));
        } else if (isBinary) await room.receiveBinary(socket, data, recheckWritable);
        else if (control) await room.receiveJson(socket, control, recheckWritable);
      } catch (error) {
        console.error('[server] rejected a document message');
        try {
          respondError(control, error instanceof Error ? error.message : String(error));
        } catch {
          console.error('[server] could not report a rejected document message');
        }
        if (error instanceof ProtocolLimitError) {
          socket.close(error.closeCode, 'Protocol resource limit exceeded');
        }
      } finally {
        socket.queuedInboundBytes = Math.max(0, (socket.queuedInboundBytes ?? 0) - queuedBytes);
        totalQueuedInboundBytes = Math.max(0, totalQueuedInboundBytes - queuedBytes);
      }
    // A rejected link would skip every later message and, unhandled, end the process.
    }).catch(() => console.error('[server] document message queue failed'));
  });
}
