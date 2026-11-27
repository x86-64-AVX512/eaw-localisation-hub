import { WebSocket, WebSocketServer } from 'ws';
import { AuthError, bearerToken } from './auth.mjs';
import { sendStartupChangedFiles } from './document-startup.mjs';
import { attachDocumentSocket } from './document-socket.mts';
import { DocumentRoom } from './document-room.mjs';
import { ProtocolLimitError, createInboundBudget, sendWithBackpressure, validDocumentId } from './protocol-limits.mts';
import {
  MAX_CONNECTIONS_PER_USER,
  MAX_CONNECTIONS_TOTAL,
  MAX_MESSAGE_BYTES,
} from '../../../packages/shared/src/constants.mts';

export function attachServerWebSockets({
  httpServer,
  authStore,
  ticketStore,
  roomRegistry,
  canonicalSource,
  getRoom,
  isShuttingDown,
}) {
  const websocketServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
  let cliReaders = 0;

  async function openReadOnlyDocument(socket, documentId) {
    if (cliReaders >= 4) throw new ProtocolLimitError('Too many CLI document readers', 1013);
    cliReaders++;
    let room;
    let transient = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (room?.clients.has(socket)) room.removeClient(socket);
      if (transient) room?.destroy();
      cliReaders--;
    };
    try {
      const existing = roomRegistry.rooms.get(documentId);
      transient = !existing;
      room = existing
        ? await existing
        : await DocumentRoom.load(roomRegistry.dataDirectory, documentId, authStore, roomRegistry, null, null, true);
      if (socket.readyState !== WebSocket.OPEN) {
        release();
        return;
      }
      authoriseSocket(socket);
      ticketStore.assertDocumentAccess(documentId);
      socket.inboundBudget = createInboundBudget();
      room.addClient(socket);
      attachDocumentSocket({
        socket,
        documentId,
        room,
        ticketStore,
        isShuttingDown,
        authoriseSession: () => {
          authoriseSocket(socket);
          ticketStore.assertDocumentAccess(documentId);
        },
      });
      socket.once('close', release);
    } catch (error) {
      release();
      throw error;
    }
  }
  function rejectUninitialisedDocument(socket) {
    const code = 'DOCUMENT_NOT_INITIALISED';
    const message = 'Open the document in Review to initialise its shared text first.';
    sendWithBackpressure(socket, JSON.stringify({ type: 'error', code, message }));
    socket.close(1008, code);
  }

  async function hasInitialisedDocument(documentId) {
    const existing = roomRegistry.rooms.get(documentId);
    if (existing) {
      const room = await existing;
      return room.hasStoredState && !room.destroyed;
    }
    return roomRegistry.hasSavedState(documentId);
  }

  async function disconnectAuthenticatedSockets(predicate, reason, closeCode = 1008) {
    for (const socket of websocketServer.clients) {
      if (predicate(socket.identity) && socket.readyState === WebSocket.OPEN) {
        socket.close(closeCode, reason);
      }
    }
  }

  function authoriseSocket(socket) {
    try {
      const active = authStore.requireActiveSession(socket.identity?.sessionId);
      if (active) authStore.requirePermanentPassword(active.user);
      return active;
    } catch (error) {
      socket.close(1008, error.message);
      throw error;
    }
  }

  function watchSocketExpiry(socket) {
    let timer;
    const schedule = () => {
      try {
        const active = authoriseSocket(socket);
        if (!active || socket.readyState !== WebSocket.OPEN) return;
        const delay = Date.parse(active.session.expiresAt) - authStore.now();
        timer = setTimeout(schedule, Math.max(1, Math.min(delay, 2_147_483_647)));
        timer.unref();
      } catch {
        /* authoriseSocket already closed the connection */
      }
    };
    socket.once('close', () => clearTimeout(timer));
    schedule();
  }

  authStore.onSessionChange = () => {
    for (const socket of websocketServer.clients) {
      if (!socket.identity || socket.readyState !== WebSocket.OPEN) continue;
      try {
        authoriseSocket(socket);
      } catch {
        /* connection closed */
      }
    }
  };

  websocketServer.on('connection', async (socket, request) => {
    socket.on('error', () => console.error('[server] websocket error'));
    try {
      if (websocketServer.clients.size > MAX_CONNECTIONS_TOTAL) {
        throw new ProtocolLimitError('Server connection limit reached', 1013);
      }
      socket.identity = await authStore.authenticate(bearerToken(request));
      authStore.requirePermanentPassword(socket.identity);
      const userConnections = [...websocketServer.clients].filter(
        (client) => client !== socket && client.identity?.id === socket.identity.id,
      ).length;
      if (userConnections >= MAX_CONNECTIONS_PER_USER) {
        throw new ProtocolLimitError('Account connection limit reached', 1013);
      }
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      watchSocketExpiry(socket);
      if (url.searchParams.get('watchSession') === '1') {
        socket.on('message', () => socket.close(1003, 'Unexpected session watcher message'));
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'session-active' }));
        return;
      }
      const documentId = url.searchParams.get('document');
      if (!validDocumentId(documentId)) throw new ProtocolLimitError('Missing or invalid document id');
      if (roomRegistry.isUnavailableBranch(documentId)) {
        const branch = documentId.split(':', 1)[0];
        throw new ProtocolLimitError(
          roomRegistry.mergedBranches.has(branch) ? 'Branch merged into general-dev' : 'Branch merge is in progress',
          roomRegistry.mergedBranches.has(branch) ? 4002 : 1013,
        );
      }
      ticketStore.assertDocumentAccess(documentId);
      const automation = url.searchParams.get('automation');
      socket.automationWrites = automation === 'write';
      socket.automation = automation === '1' || socket.automationWrites;
      if (socket.automation && !socket.automationWrites) {
        await openReadOnlyDocument(socket, documentId);
        return;
      }
      if (socket.automationWrites) {
        if (!(await hasInitialisedDocument(documentId))) {
          rejectUninitialisedDocument(socket);
          return;
        }
      } else {
        await ticketStore.noteParticipant(documentId, socket.identity);
      }
      socket.localHead = String(url.searchParams.get('head') ?? '').toLowerCase();
      socket.localBlob = String(url.searchParams.get('blob') ?? '').toLowerCase();
      const canonicalSnapshot = canonicalSource.enabled
        ? await canonicalSource.snapshot(documentId, { force: true })
        : null;
      if (canonicalSource.enabled && socket.automationWrites && !(await hasInitialisedDocument(documentId))) {
        rejectUninitialisedDocument(socket);
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      authoriseSocket(socket);
      ticketStore.assertDocumentAccess(documentId);
      socket.changedFiles = [];
      const room = await getRoom(documentId, canonicalSnapshot);
      if (room.destroyed) throw new ProtocolLimitError('The document room has closed', 1013);
      if (canonicalSnapshot) await room.applyCanonicalSnapshot(canonicalSnapshot);
      if (socket.readyState !== WebSocket.OPEN) return;
      authoriseSocket(socket);
      socket.room = room;
      socket.inboundBudget = createInboundBudget();
      room.addClient(socket);

      attachDocumentSocket({
        socket,
        documentId,
        room,
        ticketStore,
        noteParticipant: () => ticketStore.noteParticipant(documentId, socket.identity),
        isShuttingDown,
        authoriseSession: () => {
          authoriseSocket(socket);
          if (socket.automationWrites) ticketStore.assertDocumentAccess(documentId);
        },
      });
      socket.on('close', () => room.removeClient(socket));
      if (!socket.automation)
        void sendStartupChangedFiles(canonicalSource, documentId, socket, room, canonicalSnapshot);
    } catch (error) {
      if (!(error instanceof AuthError)) console.error('[server] connection failed');
      const closeCode =
        error instanceof ProtocolLimitError ? error.closeCode : error instanceof AuthError ? 1008 : 1011;
      socket.close(closeCode, error.message || 'Server error');
    }
  });

  return { websocketServer, disconnectAuthenticatedSockets };
}
