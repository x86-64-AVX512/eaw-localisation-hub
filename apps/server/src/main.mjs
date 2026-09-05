import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthError, AuthStore, bearerToken } from './auth.mjs';
import { AdminSessionStore } from './admin-session.mjs';
import { handleAdminHttp } from './admin-http.mjs';
import { DocumentRoom, closeDocumentRoomValidator } from './document-room.mjs';
import {
  ProtocolLimitError,
  byteLength,
  consumeInboundBudget,
  createInboundBudget,
  sendWithBackpressure,
  validDocumentId,
} from './protocol-limits.mjs';
import { minimisePersistedDocumentMetadata } from './room-metadata.mjs';
import { RoomRegistry } from './room-registry.mjs';
import { TicketStore } from './ticket-store.mjs'; import { handleTicketHttp } from './ticket-http.mjs';
import { TicketService } from './ticket-service.mjs'; import { GitCommitVerifier } from './git-commit-verifier.mjs';
import { GitBranchCache } from './git-branch-cache.mjs';
import { EventJournal } from './event-journal.mjs';
import {
  DISPLAY_VERSION,
  MAX_CONNECTIONS_PER_USER,
  MAX_CONNECTIONS_TOTAL,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '../../../packages/shared/src/constants.mjs';
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, '../../..');
function parseArguments(argv) {
  const result = {
    host: '127.0.0.1',
    port: 3210,
    data: path.join(projectRoot, 'data', 'prototype-server'),
    auth: 'required',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') result.host = argv[++index];
    else if (argument === '--port') result.port = Number(argv[++index]);
    else if (argument === '--data') result.data = path.resolve(argv[++index]);
    else if (argument === '--auth') result.auth = argv[++index];
    else if (argument === '--help') result.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  if (!['required', 'disabled'].includes(result.auth)) {
    throw new Error('Auth mode must be required or disabled');
  }
  return result;
}
async function atomicWrite(targetPath, data) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  try {
    await fs.rename(temporary, targetPath);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.rm(targetPath, { force: true });
    await fs.rename(temporary, targetPath);
  }
}
const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node apps/server/src/main.mjs [--host 127.0.0.1] [--port 3210] [--data PATH]');
  console.log('       [--auth required|disabled]');
  process.exit(0);
}

await fs.mkdir(options.data, { recursive: true });
await minimisePersistedDocumentMetadata(options.data, atomicWrite);
const authStore = new AuthStore(options.data, atomicWrite, options.auth);
const bootstrapInvite = await authStore.initialise();
const eventJournal = new EventJournal(options.data, atomicWrite);
await eventJournal.initialise();
const adminSessions = new AdminSessionStore(authStore);
const configuredGitRefresh = Number(process.env.EAW_HUB_GIT_REFRESH_MILLISECONDS ?? 60_000);
const gitRefreshMilliseconds = Number.isFinite(configuredGitRefresh) && configuredGitRefresh >= 250
  ? configuredGitRefresh : 60_000;
const canonicalSource = new GitBranchCache(
  options.data,
  process.env.EAW_HUB_CANONICAL_REPOSITORY || process.env.EAW_HUB_GITHUB_REPOSITORY,
  { refreshMilliseconds: gitRefreshMilliseconds },
);
const roomRegistry = new RoomRegistry(
  options.data,
  authStore,
  (dataDirectory, documentId, store, registry) => DocumentRoom.load(
    dataDirectory, documentId, store, registry, canonicalSource,
  ),
  atomicWrite,
  canonicalSource,
);
await roomRegistry.initialise();
roomRegistry.eventJournal = eventJournal;
const rooms = roomRegistry.rooms;
const ticketStore = new TicketStore(options.data, atomicWrite, new GitCommitVerifier(process.env.EAW_HUB_GITHUB_REPOSITORY));
ticketStore.eventJournal = eventJournal;
roomRegistry.ticketStore = ticketStore;
await ticketStore.initialise();
const ticketService = new TicketService(ticketStore, roomRegistry);

async function getRoom(documentId) {
  return roomRegistry.get(documentId);
}

async function broadcastDirectories() {
  const loadedRooms = await Promise.all([...rooms.values()]);
  for (const room of loadedRooms) room.broadcastDirectory();
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new AuthError('Request body is too large', 413, 'body_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthError('Request body must be valid JSON', 400, 'invalid_json');
  }
}

async function authenticatedUser(request, { admin = false, allowTemporaryPassword = false } = {}) {
  const user = await authStore.authenticate(bearerToken(request));
  if (!allowTemporaryPassword) authStore.requirePermanentPassword(user);
  if (admin) authStore.requireAdmin(user);
  return user;
}

async function authenticatedAdmin(request, { fresh = false } = {}) {
  return adminSessions.authenticate(bearerToken(request), { fresh });
}

async function authenticatedBackup(request) {
  const token = bearerToken(request);
  const actor = token.startsWith('eaw_backup_')
    ? authStore.authenticateBackupToken(token)
    : adminSessions.authenticate(token);
  authStore.requireAdmin(await actor);
  return actor;
}

function privateProxyAddress(value) {
  const address = String(value ?? '').toLowerCase().replace(/^::ffff:/u, '');
  if (address === '::1' || address === '127.0.0.1') return true;
  if (/^10\./u.test(address) || /^192\.168\./u.test(address)) return true;
  const match = /^172\.(\d{1,2})\./u.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^(?:fc|fd)[0-9a-f]{2}:/u.test(address);
}

function transientLoginSource(request) {
  const remote = String(request.socket.remoteAddress ?? 'unknown').slice(0, 128);
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  if (privateProxyAddress(remote) && forwarded && forwarded.length <= 128) return forwarded;
  return remote;
}

async function flushRooms() {
  const loadedRooms = await Promise.all([...rooms.values()]);
  await Promise.all(loadedRooms.map((room) => room.flush()));
  await authStore.flush();
  await eventJournal.flush();
}

async function disconnectAuthenticatedSockets(predicate, reason) {
  for (const room of await Promise.all([...rooms.values()])) {
    for (const socket of room.clients) {
      if (predicate(socket.identity) && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, reason);
      }
    }
  }
}

async function handleHttp(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      version: DISPLAY_VERSION,
      protocol: PROTOCOL_VERSION,
      auth: options.auth,
      rooms: rooms.size,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/git/head') {
    await authenticatedUser(request);
    const branch = String(url.searchParams.get('branch') ?? '');
    if (!validDocumentId(`${branch}:localisation/russian/__head__.yml`)) {
      throw new AuthError('Git branch is invalid', 400, 'invalid_branch');
    }
    if (!canonicalSource.enabled) {
      sendJson(response, 200, { branch, commit: '', checkedAt: Date.now(), disabled: true });
      return;
    }
    sendJson(response, 200, await canonicalSource.head(branch));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    const actor = await authenticatedUser(request);
    sendJson(response, 200, eventJournal.list(actor.id, url.searchParams.get('after'), url.searchParams.get('limit')));
    return;
  }
  if (await handleTicketHttp({
    request, response, url,
    readJsonBody: (incoming) => readJsonBody(incoming, 12 * 1024 * 1024),
    authenticatedUser, sendJson, ticketStore, ticketService,
  })) return;
  if (request.method === 'POST' && url.pathname === '/api/auth/redeem') {
    const body = await readJsonBody(request);
    const result = await authStore.redeem(
      body.inviteCode,
      body.displayName,
      body.password,
    );
    await broadcastDirectories();
    sendJson(response, 201, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await authStore.login(
      body.displayName,
      body.password,
      transientLoginSource(request),
    ));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    sendJson(response, 200, { user: await authenticatedUser(request, { allowTemporaryPassword: true }) });
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/api/auth/training') {
    const actor = await authenticatedUser(request);
    const body = await readJsonBody(request);
    sendJson(response, 200, { user: await authStore.updateTrainingProgress(actor, body.segmentId, body.revision) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/users/directory') {
    const actor = await authenticatedUser(request);
    sendJson(response, 200, { users: authStore.directory(actor) });
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/api/auth/avatar') {
    const actor = await authenticatedUser(request);
    const body = await readJsonBody(request);
    const user = await authStore.updateAvatar(actor, body.avatarBase64);
    await broadcastDirectories();
    sendJson(response, 200, { user });
    return;
  }
  if (request.method === 'DELETE' && url.pathname === '/api/auth/avatar') {
    const actor = await authenticatedUser(request);
    const user = await authStore.updateAvatar(actor, '');
    await broadcastDirectories();
    sendJson(response, 200, { user });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = bearerToken(request);
    let sessionId = null;
    try {
      sessionId = (await authStore.authenticate(token)).sessionId;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    await authStore.logout(token);
    if (sessionId) await disconnectAuthenticatedSockets(
      (identity) => identity?.sessionId === sessionId, 'Session logged out',
    );
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/password/change') {
    const actor = await authenticatedUser(request, { allowTemporaryPassword: true });
    const body = await readJsonBody(request);
    const user = await authStore.changePassword(actor, body.currentPassword, body.newPassword);
    await disconnectAuthenticatedSockets(
      (identity) => identity?.id === user.id && identity?.sessionId !== actor.sessionId,
      'Password changed',
    );
    sendJson(response, 200, { user });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/password/recover') {
    const body = await readJsonBody(request);
    const result = await authStore.recoverPassword(
      body.displayName,
      body.recoveryCode,
      body.newPassword,
      transientLoginSource(request),
    );
    await disconnectAuthenticatedSockets((identity) => identity?.id === result.user.id, 'Password recovered');
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/recovery/issue') {
    const actor = await authenticatedUser(request);
    sendJson(response, 201, await authStore.issueRecoveryCode(actor));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/recovery/confirm') {
    const actor = await authenticatedUser(request);
    const body = await readJsonBody(request);
    sendJson(response, 200, { user: await authStore.confirmRecoveryCode(actor, body.recoveryCode) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/recovery/discard') {
    const actor = await authenticatedUser(request);
    sendJson(response, 200, { user: await authStore.discardPendingRecoveryCode(actor) });
    return;
  }
  if (await handleAdminHttp({
    request, response, url, authStore, adminSessions, authenticatedUser,
    authenticatedAdmin, authenticatedBackup, readJsonBody, transientLoginSource,
    sendJson, disconnectAuthenticatedSockets, rooms, dataDirectory: options.data,
    atomicWrite, broadcastDirectories, flushRooms,
  })) return;
  sendJson(response, 404, { error: 'Not found', code: 'not_found' });
}

const httpServer = http.createServer((request, response) => {
  handleHttp(request, response).catch((error) => {
    const status = error instanceof AuthError ? error.status : 500;
    if (status >= 500) console.error('[server] HTTP request failed');
    if (!response.headersSent) {
      sendJson(response, status, {
        error: status >= 500 ? 'Internal server error' : error.message,
        code: error.code ?? 'internal_error',
      });
    } else response.destroy();
  });
});

const websocketServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
websocketServer.on('connection', async (socket, request) => {
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
    const documentId = url.searchParams.get('document');
    if (!validDocumentId(documentId)) throw new ProtocolLimitError('Missing or invalid document id');
    ticketStore.assertDocumentAccess(documentId);
    await ticketStore.noteParticipant(documentId, socket.identity);
    const room = await getRoom(documentId);
    socket.localHead = String(url.searchParams.get('head') ?? '').toLowerCase();
    socket.localBlob = String(url.searchParams.get('blob') ?? '').toLowerCase();
    socket.changedFiles = canonicalSource.enabled
      ? await canonicalSource.changedFilesSince(documentId, socket.localHead).catch(() => [])
      : [];
    socket.room = room;
    socket.inboundBudget = createInboundBudget();
    room.addClient(socket);

    socket.on('message', async (data, isBinary) => {
      try {
        const control = isBinary ? null : JSON.parse(data.toString('utf8'));
        if (!ticketStore.documentWritable(documentId)
          && (isBinary || !['presence', 'history-get'].includes(control?.type))) {
          sendWithBackpressure(socket, JSON.stringify({ type: 'error', message: 'Ticket is read-only' }));
          return;
        }
        if (!room.clientWritable(socket)
          && (isBinary || !['presence', 'history-get', 'git-conflict-resolve'].includes(control?.type))) {
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
        if (error instanceof ProtocolLimitError) socket.close(error.closeCode, 'Protocol resource limit exceeded');
      }
    });
    socket.on('close', () => room.removeClient(socket));
    socket.on('error', () => console.error('[server] websocket error'));
  } catch (error) {
    if (!(error instanceof AuthError)) console.error('[server] connection failed');
    const closeCode = error instanceof ProtocolLimitError
      ? error.closeCode
      : error instanceof AuthError ? 1008 : 1011;
    socket.close(closeCode, error.message || 'Server error');
  }
});

await new Promise((resolve) => httpServer.listen(options.port, options.host, resolve));
console.log(`[server] EaW Localisation Hub ${DISPLAY_VERSION}`);
console.log(`[server] listening on http://${options.host}:${options.port}`);
console.log(`[server] authentication: ${options.auth}`);
if (bootstrapInvite) {
  console.log('[server] bootstrap administrator invitation file created');
}

async function shutdown(signal) {
  console.log(`[server] ${signal}: flushing ${rooms.size} room(s)`);
  websocketServer.close();
  await flushRooms();
  await roomRegistry.close();
  await closeDocumentRoomValidator();
  await new Promise((resolve) => httpServer.close(resolve));
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
