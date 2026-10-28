import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { requestAgentJson } from '../apps/agent/src/agent-http.mjs';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';
import { DocumentBinding } from '../apps/agent/src/document-binding.mjs';
import { PROTOCOL_VERSION } from '../packages/shared/src/constants.mts';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

async function until(predicate, description, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, description);
    await delay(10);
  }
}

test('HTTP deadline covers missing headers and stalled JSON bodies without retrying writes', async t => {
  const requests = [];
  const { url } = await fixture(t, (req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    if (req.url === '/body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
  });
  const options = { server: url, token: 'fixture-token', httpTimeoutMilliseconds: 120 };
  for (const route of ['/headers', '/body']) {
    const start = Date.now();
    await assert.rejects(requestAgentJson(options, route, { method: 'POST', body: '{}' }), /Результат операции не подтверждён/u);
    assert.ok(Date.now() - start < 1500);
  }
  assert.deepEqual(requests, ['/headers', '/body'].map(url => ({ url, method: 'POST', authorization: 'Bearer fixture-token' })));
});

test('account refresh has a single in-flight request and shutdown cancels it', async t => {
  const requests = [];
  const { url } = await fixture(t, req => requests.push(req.url));
  const hub = Object.create(AgentHub.prototype);
  Object.assign(hub, { options: { server: url, token: 'fixture-token' }, requestController: new AbortController(), clients: new Set(), documents: new Map() });
  const first = hub.refreshAccountStatus();
  assert.equal(hub.refreshAccountStatus(), first);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await until(() => requests.length === 2, 'both account probes reached the server');
  const start = Date.now(); await hub.close(); await rejected;
  assert.ok(Date.now() - start < 1000);
  await hub.refreshAccountStatus();
  assert.deepEqual(requests.sort(), ['/api/auth/me', '/health']);
});

test('an explicit caller abort cancels an HTTP body read', async t => {
  const { url } = await fixture(t, (req, res) => { res.writeHead(200); res.write('{'); });
  const controller = new AbortController();
  const request = requestAgentJson({ server: url }, '/body', { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort(); await rejected;
});

function documentFixture(t, url, policy = {}) {
  const saved = new Map();
  const hub = {
    options: { server: url, token: 'fixture-token', connectionPolicy: { handshakeMs: 100, syncMs: 150, pingMs: 60, pongMs: 80, ...policy } },
    loadPendingDocumentUpdate: id => saved.get(id),
    savePendingDocumentUpdate: (id, update) => saved.set(id, update),
    clearPendingDocumentUpdate: id => saved.delete(id),
    updateIdentity() {}, updateDirectory() {},
  };
  const ticketId = '11111111-1111-4111-8111-111111111111';
  const relativePath = 'localisation/russian/fixture.yml';
  const binding = new DocumentBinding(hub, `ticket-${ticketId}:${relativePath}`, relativePath, ticketId);
  t.after(async () => { await binding.close(); binding.socket?.terminate(); });
  return { binding, saved };
}

function syncedMessage() {
  return JSON.stringify({ type: 'synced', protocol: PROTOCOL_VERSION, version: '0.8.9F1',
    documentId: 'fixture', canSeed: false, reservations: [], commentThreads: [], suggestions: [],
    presences: [], directory: [], identity: null });
}

test('a silent WebSocket handshake times out and does not block local edits or shutdown', async t => {
  const { url } = await fixture(t, () => {});
  const { binding, saved } = documentFixture(t, url);
  const socket = binding.socket;
  binding.text.insert(0, 'offline local edit');
  await until(() => socket.readyState === 3 && binding.reconnectTimer, 'handshake timeout schedules recovery');
  assert.equal(binding.synced, false);
  await binding.close();
  const restored = new Y.Doc(); t.after(() => restored.destroy());
  Y.applyUpdate(restored, saved.get(binding.documentId));
  assert.equal(restored.getText('content').toString(), 'offline local edit');
});

test('a WebSocket that opens without syncing is retried and local edits reach the recovered room', async t => {
  const { server, url } = await fixture(t);
  const wss = new WebSocketServer({ server });
  const remote = new Y.Doc(); t.after(() => remote.destroy());
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  let connections = 0;
  wss.on('connection', socket => {
    connections++;
    if (connections === 1) return;
    socket.on('message', (data, binary) => { if (binary) Y.applyUpdate(remote, new Uint8Array(data)); });
    socket.send(Y.encodeStateAsUpdate(remote));
    socket.send(syncedMessage());
  });
  const { binding } = documentFixture(t, url);
  binding.text.insert(0, 'kept through reconnect');
  await until(() => connections >= 2 && binding.synced && remote.getText('content').toString() === 'kept through reconnect', 'recovery delivers local edits');
  assert.equal(binding.reconnectDelay, 500);
  assert.equal(binding.localUpdatePending, true, 'send is not a durable acknowledgement');
  binding.text.insert(binding.text.length, ' + after reconnect');
  await until(() => remote.getText('content').toString().endsWith(' + after reconnect'), 'new edits continue after recovery');
  await delay(300);
  assert.equal(connections, 2, 'a synced peer answering pings must stay connected');
  assert.equal(binding.synced, true);
});

test('heartbeat detects a half-open peer after initial sync', async t => {
  const { server, url } = await fixture(t);
  const wss = new WebSocketServer({ server, autoPong: false });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  wss.on('connection', socket => socket.send(syncedMessage()));
  const { binding } = documentFixture(t, url, { syncMs: 500 });
  const socket = binding.socket;
  await until(() => binding.synced, 'initial sync succeeds');
  await until(() => socket.readyState === 3 && binding.reconnectTimer, 'missing pong schedules reconnect');
  assert.equal(binding.synced, false);
});

test('authorization refusal stays paused instead of retrying around server permissions', async t => {
  const { server, url } = await fixture(t);
  const wss = new WebSocketServer({ server });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  wss.on('connection', socket => socket.close(1008, 'Authentication failed'));
  const { binding } = documentFixture(t, url);
  await until(() => binding.paused, 'server refusal pauses the document');
  assert.equal(binding.reconnectTimer, null);
  assert.equal(binding.synced, false);
});

test('a slow but progressing HTTP body and a long server operation are not cut off', async t => {
  const { url } = await fixture(t, async (req, res) => {
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const body = JSON.stringify({ text: 'x'.repeat(2000) });
      for (let index = 0; index < body.length; index += 200) { res.write(body.slice(index, index + 200)); await delay(60); }
      res.end();
    } else { await delay(400); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"applied":true}'); }
  });
  const options = { server: url, token: 'fixture-token', httpTimeoutMilliseconds: 120 };
  assert.equal((await requestAgentJson(options, '/slow-body')).text.length, 2000);
  await assert.rejects(requestAgentJson(options, '/apply', { method: 'POST', body: '{}' }), /не подтверждён/u);
  assert.deepEqual(await requestAgentJson(options, '/apply', { method: 'POST', body: '{}', timeoutMilliseconds: 2000 }), { applied: true });
});

// Writes one unmasked server frame byte range by byte range, like a weak link would.
async function sendSlowFrame(socket, opcode, payload, pieces = 20, pause = 35) {
  const header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  const frame = Buffer.concat([header, payload]);
  const step = Math.ceil(frame.length / pieces);
  for (let index = 0; index < frame.length; index += step) { socket._socket.write(frame.subarray(index, index + step)); await delay(pause); }
}

test('a large frame arriving slowly survives the sync and heartbeat limits', async t => {
  const { server, url } = await fixture(t);
  const wss = new WebSocketServer({ server, autoPong: false });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  const remote = new Y.Doc(); t.after(() => remote.destroy());
  remote.getText('content').insert(0, 'large '.repeat(20000));
  let connections = 0, peer;
  wss.on('connection', async socket => {
    connections++; peer = socket;
    await sendSlowFrame(socket, 2, Buffer.from(Y.encodeStateAsUpdate(remote)));
    socket.send(syncedMessage());
  });
  const { binding } = documentFixture(t, url);
  await until(() => binding.synced, 'a 700 ms initial transfer completes despite a 150 ms sync limit');
  assert.equal(binding.text.toString(), remote.getText('content').toString());
  const later = new Y.Doc(); t.after(() => later.destroy());
  later.getText('content').insert(0, 'more '.repeat(20000));
  await sendSlowFrame(peer, 2, Buffer.from(Y.encodeStateAsUpdate(later)));
  assert.equal(binding.synced, true, 'unanswered pings during a transfer do not drop the connection');
  assert.equal(connections, 1);
});
