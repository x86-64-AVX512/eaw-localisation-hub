import {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function attachDocumentSocket({
  socket, documentId, room, ticketStore, isShuttingDown,
}: DocumentSocketOptions): void {
  const writableError = (isBinary: boolean, control: Record<string, unknown> | null): string => {
    const controlType = typeof control?.type === 'string' ? control.type : '';
    if (!ticketStore.documentWritable(documentId)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'sync-flush'].includes(controlType))) {
      return 'Ticket is read-only';
    }
    if (!room.clientWritable(socket)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'git-conflict-resolve', 'sync-flush'].includes(controlType))) {
      return 'The local Git version of this file is not canonical';
    }
    return '';
  };
  socket.messageQueue = Promise.resolve();
  socket.on('message', (data, isBinary) => {
    if (isShuttingDown()) return;
    socket.messageQueue = (socket.messageQueue ?? Promise.resolve()).then(async () => {
      try {
        const parsed: unknown = isBinary ? null : JSON.parse(data.toString('utf8'));
        if (!isBinary && !isRecord(parsed)) throw new Error('Invalid document control message');
        const control = isBinary ? null : parsed as Record<string, unknown>;
        const blocked = writableError(isBinary, control);
        if (blocked) {
          sendWithBackpressure(socket, JSON.stringify({ type: 'error', message: blocked }));
          return;
        }
        const recheckWritable = () => {
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
        sendWithBackpressure(socket, JSON.stringify({ type: 'error',
          message: error instanceof Error ? error.message : String(error) }));
        if (error instanceof ProtocolLimitError) {
          socket.close(error.closeCode, 'Protocol resource limit exceeded');
        }
      }
    });
  });
}
