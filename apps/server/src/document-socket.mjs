import {
  ProtocolLimitError,
  byteLength,
  consumeInboundBudget,
  sendWithBackpressure,
} from './protocol-limits.mjs';

export function attachDocumentSocket({
  socket, documentId, room, ticketStore, isShuttingDown,
}) {
  const writableError = (isBinary, control) => {
    if (!ticketStore.documentWritable(documentId)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get'].includes(control?.type))) {
      return 'Ticket is read-only';
    }
    if (!room.clientWritable(socket)
      && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'git-conflict-resolve'].includes(control?.type))) {
      return 'The local Git version of this file is not canonical';
    }
    return '';
  };
  socket.messageQueue = Promise.resolve();
  socket.on('message', (data, isBinary) => {
    if (isShuttingDown()) return;
    socket.messageQueue = socket.messageQueue.then(async () => {
      try {
        const control = isBinary ? null : JSON.parse(data.toString('utf8'));
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
        if (isBinary) await room.receiveBinary(socket, data, recheckWritable);
        else await room.receiveJson(socket, control, recheckWritable);
      } catch (error) {
        console.error('[server] rejected a document message');
        sendWithBackpressure(socket, JSON.stringify({ type: 'error', message: error.message }));
        if (error instanceof ProtocolLimitError) {
          socket.close(error.closeCode, 'Protocol resource limit exceeded');
        }
      }
    });
  });
}
