import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MAX_CRDT_UPDATE_BYTES } from '../packages/shared/src/constants.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function spawnServer(port, dataDirectory) {
  return spawn(process.execPath, [
    'apps/server/src/main.mjs', '--port', String(port), '--data', dataDirectory, '--auth', 'disabled',
  ], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve(data));
        });
        request.on('error', reject);
      });
      if (JSON.parse(body).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error('Server did not become healthy');
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function connectDocument(port, documentId) {
  return new Promise((resolve, reject) => {
    const document = new Y.Doc();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?document=${encodeURIComponent(documentId)}`);
    let synced = null;
    socket.on('message', (data, isBinary) => {
      if (isBinary) Y.applyUpdate(document, new Uint8Array(data));
      else {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'synced') {
          synced = message;
          resolve({ document, socket, synced });
        }
      }
    });
    socket.on('error', reject);
  });
}

function encodedRelative(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

function waitForJson(socket, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error('Timed out waiting for server JSON message'));
    }, timeout);
    const receive = (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString('utf8'));
      if (message.type === 'error') {
        clearTimeout(timer);
        socket.off('message', receive);
        reject(new Error(`Server rejected test message: ${message.message}`));
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(message);
    };
    socket.on('message', receive);
  });
}

test('server restores CRDT text, reservations, comments, and suggestions after restart', { timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-persist-'));
  const dataDirectory = path.join(temporary, 'data');
  const documentId = 'country-branch:localisation/russian/prototype_l_russian.yml';
  const port = await freePort();
  let server;
  let first;
  let second;
  try {
    server = spawnServer(port, dataDirectory);
    await waitForHealth(port);
    first = await connectDocument(port, documentId);
    const text = first.document.getText('content');
    const expected = 'l_russian:\r\n prototype_key:0 "Сохранено"\r\n';
    text.insert(0, expected);
    first.socket.send(Y.encodeStateAsUpdate(first.document));
    const start = Y.createRelativePositionFromTypeIndex(text, expected.indexOf('prototype_key'), 0);
    const end = Y.createRelativePositionFromTypeIndex(text, expected.length - 2, 0);
    first.socket.send(JSON.stringify({
      type: 'reservation-create',
      id: 'persistent-reservation',
      assignee: 'Alice',
      createdBy: 'Alice',
      color: '#ff6677',
      startRelative: encodedRelative(start),
      endRelative: encodedRelative(end),
      initialKeys: ['prototype_key'],
    }));
    const valueStartIndex = expected.indexOf('"Сохранено"');
    const valueEndIndex = valueStartIndex + '"Сохранено"'.length;
    const valueStart = encodedRelative(Y.createRelativePositionFromTypeIndex(text, valueStartIndex, -1));
    const valueEnd = encodedRelative(Y.createRelativePositionFromTypeIndex(text, valueEndIndex, 0));
    const commentReview = waitForJson(first.socket, (message) => message.type === 'review'
      && message.commentThreads?.some((item) => item.id === 'persistent-comment'));
    first.socket.send(JSON.stringify({
      type: 'comment-create', id: 'persistent-comment', messageId: 'persistent-comment-message',
      author: 'Alice', color: '#ff6677', body: 'Постоянный комментарий', startRelative: valueStart, endRelative: valueEnd,
    }));
    await commentReview;
    const createdReplacement = '"Предложено"';
    const createdTrace = JSON.stringify([[-1, createdReplacement.length]]);
    const suggestionReview = waitForJson(first.socket, (message) => message.type === 'review'
      && message.suggestions?.some((item) => item.id === 'persistent-suggestion'));
    first.socket.send(JSON.stringify({
      type: 'suggestion-create', id: 'persistent-suggestion', author: 'Alice', color: '#ff6677',
      startRelative: valueStart, endRelative: valueEnd,
      originalText: '"Сохранено"', replacementText: createdReplacement, traceJson: createdTrace,
    }));
    const createdSuggestion = (await suggestionReview).suggestions
      .find((item) => item.id === 'persistent-suggestion');
    assert.equal(createdSuggestion.traceJson, createdTrace);
    const liveDraftReview = waitForJson(first.socket, (message) => message.type === 'review'
      && message.suggestions?.some((item) => item.id === 'persistent-suggestion'));
    first.socket.send(JSON.stringify({
      type: 'suggestion-update', id: 'persistent-suggestion', author: 'Alice', color: '#ff6677',
      startRelative: valueStart, endRelative: valueEnd,
      originalText: createdSuggestion.originalText, replacementText: '"Live draft"',
      traceJson: JSON.stringify([[-1, '"Live draft"'.length]]),
    }));
    const liveDraft = await liveDraftReview;
    assert.equal(liveDraft.suggestions.find((item) => item.id === 'persistent-suggestion').replacementText, '"Live draft"');
    const restoredDraftReview = waitForJson(first.socket, (message) => message.type === 'review'
      && message.suggestions?.some((item) => item.id === 'persistent-suggestion'));
    first.socket.send(JSON.stringify({
      type: 'suggestion-update', id: 'persistent-suggestion', author: 'Alice', color: '#ff6677',
      startRelative: valueStart, endRelative: valueEnd,
      originalText: createdSuggestion.originalText, replacementText: createdSuggestion.replacementText,
      traceJson: createdTrace,
    }));
    await restoredDraftReview;
    const acceptedReview = waitForJson(first.socket, (message) => message.type === 'review'
      && message.suggestions?.some((item) => item.id === 'persistent-suggestion' && item.status === 'accepted'));
    first.socket.send(JSON.stringify({ type: 'suggestion-accept', id: 'persistent-suggestion', author: 'Bob' }));
    await acceptedReview;
    assert.equal(text.toString(), expected.replace('"Сохранено"', '"Предложено"'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    first.socket.close();
    await stopServer(server);

    const metadataFile = (await fs.readdir(path.join(dataDirectory, 'documents')))
      .find((name) => /^[0-9a-f]{64}\.json$/u.test(name));
    const metadataPath = path.join(dataDirectory, 'documents', metadataFile);
    const legacyMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    legacyMetadata.documentId = documentId;
    legacyMetadata.savedAt = '2025-01-01T00:00:00.000Z';
    legacyMetadata.reservations[0].createdBy = 'Alice';
    legacyMetadata.reservations[0].createdAt = '2025-01-01T00:00:00.000Z';
    await fs.writeFile(metadataPath, JSON.stringify(legacyMetadata));

    server = spawnServer(port, dataDirectory);
    await waitForHealth(port);
    const minimisedMetadata = await fs.readFile(metadataPath, 'utf8');
    for (const forbidden of ['documentId', 'savedAt']) {
      assert.equal(minimisedMetadata.includes(forbidden), false, `metadata retained ${forbidden}`);
    }
    assert.equal(Object.hasOwn(JSON.parse(minimisedMetadata).reservations[0], 'createdAt'), false,
      'reservation retained legacy createdAt');
    second = await connectDocument(port, documentId);
    assert.equal(second.document.getText('content').toString(), expected.replace('"Сохранено"', '"Предложено"'));
    assert.equal(second.synced.reservations.length, 1);
    assert.equal(second.synced.reservations[0].id, 'persistent-reservation');
    assert.equal(second.synced.reservations[0].assignee, 'Alice');
    assert.equal(second.synced.reservations[0].createdBy, 'Alice');
    assert.equal(second.synced.commentThreads.length, 1);
    assert.equal(second.synced.commentThreads[0].messages[0].body, 'Постоянный комментарий');
    assert.equal(second.synced.commentThreads[0].color, '#ff6677');
    assert.equal(second.synced.commentThreads[0].messages[0].color, '#ff6677');
    assert.equal(second.synced.suggestions.length, 1);
    assert.equal(second.synced.suggestions[0].status, 'accepted');
    assert.equal(second.synced.suggestions[0].decidedBy, 'Bob');
    assert.equal(second.synced.suggestions[0].color, '#ff6677');
    assert.equal(second.synced.suggestions[0].traceJson, createdTrace);
    assert.ok(second.synced.history.length >= 2);
    const baseline = second.synced.history.find((entry) => entry.reason === 'baseline');
    const historicalVersion = waitForJson(second.socket, (message) => message.type === 'history-version'
      && message.id === baseline.id);
    second.socket.send(JSON.stringify({ type: 'history-get', id: baseline.id }));
    assert.equal(Buffer.from((await historicalVersion).textBase64, 'base64').toString('utf8'), expected);
    const restoredHistory = waitForJson(second.socket, (message) => message.type === 'history'
      && message.entries[0]?.reason === 'restore');
    second.socket.send(JSON.stringify({
      type: 'history-restore', id: baseline.id, headId: second.synced.historyHeadId,
      author: 'Bob', color: '#6699ff',
    }));
    const restored = await restoredHistory;
    assert.equal(restored.entries[0].author, 'Bob');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(second.document.getText('content').toString(), expected);
    assert.equal(second.synced.commentThreads.length, 1, 'text restoration does not remove comments');
  } finally {
    first?.socket.close();
    second?.socket.close();
    await stopServer(server);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('server rejects invalid room identifiers and oversized Yjs updates without exiting', { timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-limits-'));
  const port = await freePort();
  let server;
  let valid;
  try {
    server = spawnServer(port, path.join(temporary, 'data'));
    await waitForHealth(port);

    const invalid = new WebSocket(
      `ws://127.0.0.1:${port}/?document=${encodeURIComponent('branch:localisation/russian/../escape.yml')}`,
    );
    const [invalidCode] = await once(invalid, 'close');
    assert.equal(invalidCode, 1008);

    valid = await connectDocument(port, 'branch:localisation/russian/limits_l_russian.yml');
    const closed = once(valid.socket, 'close');
    valid.socket.send(Buffer.alloc(MAX_CRDT_UPDATE_BYTES + 1));
    const [limitCode] = await closed;
    assert.equal(limitCode, 1008);
    await waitForHealth(port);
    assert.equal(server.exitCode, null);
  } finally {
    valid?.socket.close();
    await stopServer(server);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('one Agent connection keeps several Review/plugin presences and removes all on disconnect', { timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-multi-presence-'));
  const port = await freePort();
  const documentId = 'branch:localisation/russian/presence_l_russian.yml';
  let server;
  let producer;
  let observer;
  let snapshot;
  let afterOffline;
  try {
    server = spawnServer(port, path.join(temporary, 'data'));
    await waitForHealth(port);
    producer = await connectDocument(port, documentId);
    observer = await connectDocument(port, documentId);
    const firstSeen = waitForJson(observer.socket, (message) => message.type === 'presence'
      && message.clientId === 'plugin-client');
    producer.socket.send(JSON.stringify({
      type: 'presence', clientId: 'plugin-client', user: 'Alice', color: '#ff6677',
      caretRelative: 'AA==', anchorRelative: 'AA==',
    }));
    await firstSeen;
    const secondSeen = waitForJson(observer.socket, (message) => message.type === 'presence'
      && message.clientId === 'review-client');
    producer.socket.send(JSON.stringify({
      type: 'presence', clientId: 'review-client', user: 'Alice', color: '#ff6677',
      caretRelative: 'AA==', anchorRelative: 'AA==',
    }));
    await secondSeen;

    snapshot = await connectDocument(port, documentId);
    assert.deepEqual(
      snapshot.synced.presences.map(({ clientId }) => clientId).sort(),
      ['plugin-client', 'review-client'],
    );
    const pluginLeft = waitForJson(observer.socket, (message) => message.type === 'presence-left'
      && message.clientId === 'plugin-client');
    producer.socket.send(JSON.stringify({ type: 'presence', clientId: 'plugin-client', offline: true }));
    await pluginLeft;
    afterOffline = await connectDocument(port, documentId);
    assert.deepEqual(afterOffline.synced.presences.map(({ clientId }) => clientId), ['review-client']);

    const reviewLeft = waitForJson(observer.socket, (message) => message.type === 'presence-left'
      && message.clientId === 'review-client');
    producer.socket.close();
    await reviewLeft;
  } finally {
    producer?.socket.close();
    observer?.socket.close();
    snapshot?.socket.close();
    afterOffline?.socket.close();
    await stopServer(server);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
