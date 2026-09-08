import {
  ProtocolLimitError,
  byteLength,
  consumeInboundBudget,
  sendWithBackpressure,
} from './protocol-limits.mjs';

export function attachDocumentSocket({
  socket, documentId, room, ticketStore, isShuttingDown,
}) {
  socket.messageQueue = Promise.resolve();
  socket.on('message', (data, isBinary) => {
    if (isShuttingDown()) return;
    socket.messageQueue = socket.messageQueue.then(async () => {
      try {
        const control = isBinary ? null : JSON.parse(data.toString('utf8'));
        if (!ticketStore.documentWritable(documentId)
          && (isBinary || !['presence', 'history-get', 'personal-projection-get'].includes(control?.type))) {
          sendWithBackpressure(socket, JSON.stringify({ type: 'error', message: 'Ticket is read-only' }));
          return;
        }
        if (!room.clientWritable(socket)
          && (isBinary || !['presence', 'history-get', 'personal-projection-get', 'git-conflict-resolve'].includes(control?.type))) {
          sendWithBackpressure(socket, JSON.stringify({
            type: 'error', message: 'The local Git version of this file is not canonical',
          }));
          return;
        }
        consumeInboundBudget(socket, byteLength(data), isBinary);
        if (isBinary) await room.receiveBinary(socket, data);
        else await room.receiveJson(socket, control);
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
