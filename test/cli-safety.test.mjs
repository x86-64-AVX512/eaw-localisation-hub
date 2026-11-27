import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { WebSocketServer } from 'ws';
import { createCliApi } from '../apps/agent/src/cli-api.mjs';
import { createCliCommands } from '../apps/agent/src/cli-commands.mjs';
import { createSuggestionAnchors } from '../apps/agent/src/document-actions.mjs';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { RoomRegistry } from '../apps/server/src/room-registry.mjs';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';
import { PROTOCOL_VERSION } from '../packages/shared/src/constants.mts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
after(closeDocumentRoomValidator);

async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, target);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return address.port;
}

async function callCliApi(cli, port, method, route, body, bearer = 'review-token') {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const request = {
    method,
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      if (payload) yield Buffer.from(payload, 'utf8');
    },
  };
  let status = 200;
  let raw = '';
  const response = {
    destroyed: false,
    headersSent: false,
    setHeader() {},
    once() {},
    off() {},
    writeHead(code) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      raw += chunk;
    },
  };
  const readJsonBody = async () => (payload ? JSON.parse(payload) : {});
  await cli.handle(request, response, new URL(`http://127.0.0.1:${port}/api/cli/v1/${route}`), {
    port,
    reviewAuthorised: () => bearer === 'review-token',
    bearer,
    readJsonBody,
    secureHeaders: () => {},
  });
  return { status, value: raw ? JSON.parse(raw) : null };
}

test('CLI grant issuance refuses if the signed-in account changes during requireReviewAccess, but allows first sign-in', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-cli-grant-switch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const hub = {
    identity: { id: 'account-a', displayName: 'Alice', roles: ['translator'] },
    reviewAccess: 'allowed',
    sessionRevision: 1,
    options: { token: 'token-a', repo: root, workspace: 'general-dev', server: 'ws://127.0.0.1:1' },
    async requireReviewAccess() {
      this.identity = { id: 'account-b', displayName: 'Bob', roles: ['translator'] };
      this.sessionRevision += 1;
      this.options.token = 'token-b';
    },
  };
  const cli = await createCliApi(hub, root);
  t.after(() => cli.close());

  await callCliApi(cli, 4567, 'PUT', 'settings', { mode: 'write' });
  const switched = await callCliApi(cli, 4567, 'POST', 'grants', { minutes: 15, label: 'Agent' });
  assert.equal(switched.status, 409);
  assert.equal(switched.value.error.code, 'ACCOUNT_CHANGED');
  assert.deepEqual((await callCliApi(cli, 4567, 'GET', 'grants')).value.data.grants, []);

  // Signed-out -> signed-in during requireReviewAccess must still succeed.
  hub.identity = null;
  hub.reviewAccess = 'denied';
  hub.options.token = '';
  hub.requireReviewAccess = async function () {
    this.identity = { id: 'account-b', displayName: 'Bob', roles: ['translator'] };
    this.reviewAccess = 'allowed';
    this.sessionRevision += 1;
    this.options.token = 'token-b';
  };
  const fresh = await callCliApi(cli, 4567, 'POST', 'grants', { minutes: 15, label: 'Agent' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.value.ok, true);
  assert.ok(fresh.value.data.token.startsWith('eaw1.4567.'));
});

test('CLI binds revisions to documentId across branches and does not fail already-saved writes on late workspace changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-cli-branch-'));
  const repo = path.join(root, 'repo');
  const relative = 'localisation/russian/branch_l_russian.yml';
  const source = 'l_russian:\n KEY_ONE:0 "Одинаковый текст"\n';
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
  await fs.writeFile(path.join(repo, relative), source);
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'branch-a');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init');

  let onWriteReceived = null;
  const httpServer = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ ok: true, version: '0.8.9-beta.5', protocol: PROTOCOL_VERSION, cliAutomation: true }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const documentId = url.searchParams.get('document');
    const automationWrites = url.searchParams.get('automation') === 'write';
    const doc = new Y.Doc();
    doc.getText('content').insert(0, source);
    socket.send(Y.encodeStateAsUpdate(doc), { binary: true });
    socket.send(
      JSON.stringify({
        type: 'synced',
        protocol: PROTOCOL_VERSION,
        version: '0.8.9-beta.5',
        documentId,
        canSeed: false,
        reservations: [],
        commentThreads: [],
        suggestions: [],
        history: [],
        historyHeadId: '',
        presences: [],
        directory: [],
        identity: { id: 'u1', displayName: 'Alice', roles: ['translator'], avatarBase64: '' },
        automationReadOnly: !automationWrites,
        automationWrites,
        initialised: true,
      }),
    );
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString('utf8'));
      const expected = crypto.createHash('sha256').update(`${documentId}\0${source}`).digest('hex');
      if (msg.expectedRevision !== expected) {
        socket.send(
          JSON.stringify({ type: 'discussion-result', requestId: msg.requestId, id: msg.id, status: 'stale' }),
        );
        return;
      }
      onWriteReceived?.();
      socket.send(JSON.stringify({ type: 'discussion-result', requestId: msg.requestId, id: msg.id, status: 'saved' }));
    });
    socket.once('close', () => doc.destroy());
  });
  const port = await listen(httpServer);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const hub = {
    identity: { id: 'u1', displayName: 'Alice', roles: ['translator'] },
    options: { repo, workspace: 'branch-a', server: `ws://127.0.0.1:${port}`, token: 'tok' },
    serverSupportsCli: true,
    workspaceTransitioning: false,
    workspaceBlocked: false,
    gitOperationInProgress: () => false,
    ensureCliServerSupport: async () => true,
    englishOriginal: async () => ({ commit: '0'.repeat(40), matches: [] }),
  };
  const commands = createCliCommands(hub);
  const grant = { id: crypto.randomUUID(), scope: 'propose', expiresAt: Date.now() + 60_000 };
  const signal = new AbortController().signal;

  const readA = await commands.execute(grant, { command: 'read', file: relative, key: 'KEY_ONE' }, () => {}, signal);
  assert.ok(readA.revision);

  // Switch branch to branch-b with identical file text: revision from branch-a must be rejected as STALE_REVISION.
  hub.options.workspace = 'branch-b';
  await assert.rejects(
    () =>
      commands.execute(
        grant,
        {
          command: 'comment',
          file: relative,
          key: 'KEY_ONE',
          revision: readA.revision,
          text: 'Hello',
          requestId: crypto.randomUUID(),
        },
        () => {},
        signal,
      ),
    (error) => error.code === 'STALE_REVISION',
  );
  await assert.rejects(
    () =>
      commands.execute(
        grant,
        {
          command: 'reserve',
          file: relative,
          key: 'KEY_ONE',
          revision: readA.revision,
          requestId: crypto.randomUUID(),
        },
        () => {},
        signal,
      ),
    (error) => error.code === 'STALE_REVISION',
  );

  // If workspace starts switching AFTER the write reaches the server, a confirmed save must return saved, not WORKSPACE_CHANGED.
  hub.options.workspace = 'branch-a';
  onWriteReceived = () => {
    hub.workspaceTransitioning = true;
    hub.options.workspace = 'branch-b';
  };
  const saved = await commands.execute(
    grant,
    {
      command: 'comment',
      file: relative,
      key: 'KEY_ONE',
      revision: readA.revision,
      text: 'Saved before switch',
      requestId: crypto.randomUUID(),
    },
    () => {},
    signal,
  );
  assert.equal(saved.status, 'saved');
  assert.equal(saved.workspace, 'branch-a');
});

test('deleted comments, suggestions and reservations stay tombstoned across server restart on CLI retries', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-cli-tombstones-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));

  const documentId = 'general-dev:localisation/russian/tombstone_l_russian.yml';
  const source = 'l_russian:\n TOMB_KEY:0 "Текст"\n';
  const actor = { id: 'u1', displayName: 'Alice', color: '#6aa9ff', roles: ['translator'] };
  const authStore = {
    required: true,
    findDirectoryUser: () => actor,
    directory: () => [actor],
  };

  const makeRegistry = () => {
    const registry = new RoomRegistry(data, authStore, null, atomicWrite);
    registry.ticketStore = { mutable: () => null };
    return registry;
  };

  let registry = makeRegistry();
  await registry.initialise();
  t.after(() => registry.close());
  let room = await DocumentRoom.load(data, documentId, authStore, registry);
  room.document.getText('content').insert(0, source);
  const text = room.document.getText('content');
  const revision = room.automationRevision(source);
  const valueStart = source.indexOf('Текст');
  const valueEnd = valueStart + 'Текст'.length;
  const lineStart = source.indexOf(' TOMB_KEY');
  const lineEnd = source.indexOf('\n', lineStart);
  const valueAnchors = createSuggestionAnchors(text, valueStart, valueEnd);
  const lineAnchors = createSuggestionAnchors(text, lineStart, lineEnd);

  const socket = {
    identity: actor,
    readyState: 1,
    bufferedAmount: 0,
    automation: true,
    automationWrites: true,
    send() {},
  };

  const commentId = crypto.randomUUID();
  const suggestionId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();

  const commentPayload = {
    type: 'comment-create',
    id: commentId,
    messageId: commentId,
    requestId: commentId,
    body: 'Initial comment',
    expectedRevision: revision,
    ...valueAnchors,
  };
  const suggestionPayload = {
    type: 'suggestion-create',
    id: suggestionId,
    requestId: suggestionId,
    expectedRevision: revision,
    originalText: 'Текст',
    replacementText: 'Новый текст',
    ...valueAnchors,
  };
  const reservationPayload = {
    type: 'reservation-create',
    id: reservationId,
    requestId: reservationId,
    comment: 'Mine',
    initialKeys: ['TOMB_KEY'],
    expectedRevision: revision,
    ...lineAnchors,
  };

  assert.equal(room.applyJson(socket, commentPayload).status, 'saved');
  assert.equal(room.applyJson(socket, suggestionPayload).status, 'saved');
  assert.equal(room.applyJson(socket, reservationPayload).status, 'saved');

  // Human deletes all three objects in Review.
  room.applyJson(socket, { type: 'comment-delete', id: commentId });
  room.applyJson(socket, { type: 'suggestion-delete', id: suggestionId });
  room.applyJson(socket, { type: 'reservation-delete', id: reservationId });
  await room.persist();
  room.destroy();
  await registry.close();

  // Simulate full server restart and reload room from disk.
  registry = makeRegistry();
  await registry.initialise();
  room = await DocumentRoom.load(data, documentId, authStore, registry);
  t.after(() => room.destroy());

  assert.equal(room.applyJson(socket, commentPayload).status, 'deleted');
  assert.equal(room.applyJson(socket, suggestionPayload).status, 'deleted');
  assert.equal(room.applyJson(socket, reservationPayload).status, 'deleted');
  assert.equal(room.commentThreads.length, 0);
  assert.equal(room.suggestions.length, 0);
  assert.equal(room.reservations.length, 0);
});

test('CLI rejects a legacy server via /health before opening a WebSocket to the document room', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-cli-legacy-server-'));
  const repo = path.join(root, 'repo');
  const relative = 'localisation/russian/legacy_l_russian.yml';
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
  await fs.writeFile(path.join(repo, relative), 'l_russian:\n LEGACY_KEY:0 "Text"\n');

  let websocketConnections = 0;
  const httpServer = http.createServer((request, response) => {
    if (request.url === '/health') {
      // Legacy EHSP 21 server: no cliAutomation flag.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: '0.8.9-beta.4', protocol: PROTOCOL_VERSION }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', () => {
    websocketConnections += 1;
  });
  const port = await listen(httpServer);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const hub = {
    identity: { id: 'u1', displayName: 'Alice', roles: ['translator'] },
    options: { repo, workspace: 'general-dev', server: `ws://127.0.0.1:${port}`, token: 'tok' },
    serverSupportsCli: null,
    workspaceTransitioning: false,
    workspaceBlocked: false,
    gitOperationInProgress: () => false,
    async ensureCliServerSupport(signal) {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
      const payload = await response.json();
      this.serverSupportsCli = payload.cliAutomation === true;
      return this.serverSupportsCli;
    },
  };
  const commands = createCliCommands(hub);
  const grant = { id: crypto.randomUUID(), scope: 'read', expiresAt: Date.now() + 60_000 };

  await assert.rejects(
    () => commands.execute(grant, { command: 'read', file: relative }, () => {}, new AbortController().signal),
    (error) => error.code === 'UNSUPPORTED_SERVER',
  );
  assert.equal(websocketConnections, 0);
});

test('TicketStore.noteParticipant retries disk persistence after a transient write failure', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-participant-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));

  let failNextWrite = false;
  const flakyWrite = async (target, content) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('disk temporarily unavailable');
    }
    await atomicWrite(target, content);
  };

  const store = new TicketStore(data, flakyWrite);
  await store.initialise();
  const creator = { id: 'alice', displayName: 'Alice' };
  const contributor = { id: 'bob', displayName: 'Bob' };
  const ticket = await store.create(creator, {
    title: 'Participant durability',
    baseBranch: 'general-dev',
    baseCommit: 'a'.repeat(40),
    files: ['localisation/russian/p_l_russian.yml'],
  });
  const documentId = `ticket-${ticket.id}:localisation/russian/p_l_russian.yml`;

  failNextWrite = true;
  await assert.rejects(() => store.noteParticipant(documentId, contributor), /disk temporarily unavailable/);
  // Retry with the same participant must persist the dirty ticket store instead of returning early.
  await store.noteParticipant(documentId, contributor);

  const reloaded = new TicketStore(data, atomicWrite);
  await reloaded.initialise();
  assert.deepEqual(reloaded.get(ticket.id).participantIds, ['alice', 'bob']);
});

test('CLI --help --json returns the standard { ok: true, data: { help } } envelope', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['apps/agent/src/cli.mjs', '--help', '--json'], {
    cwd: projectRoot,
    windowsHide: true,
    timeout: 5000,
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.match(parsed.data.help, /Usage: eaw-hub/u);
});
