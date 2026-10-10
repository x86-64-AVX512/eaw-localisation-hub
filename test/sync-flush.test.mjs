import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';
import { closeDocument, handleUnavailableTicketClose } from '../apps/agent/src/document-lifecycle.mts';
import { DocumentBinding } from '../apps/agent/src/document-binding.mjs';
import { forwardLocalUpdate, handleFlushAcknowledgement, handleSocketClose } from '../apps/agent/src/document-delivery.mts';
import { attachDocumentSocket } from '../apps/server/src/document-socket.mts';
import { createInboundBudget } from '../apps/server/src/protocol-limits.mts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('flush acknowledgement without a pending waiter cannot complete a missing request', () => {
  const binding = { flushWaiter: null };
  assert.equal(handleFlushAcknowledgement(binding, { type: 'sync-flushed' }), true);
  let completed = false;
  binding.flushWaiter = { id: 'expected', finish() { completed = true; } };
  assert.equal(handleFlushAcknowledgement(binding, { type: 'sync-flushed', requestId: 'other' }), true);
  assert.equal(completed, false);
  assert.equal(handleFlushAcknowledgement(binding, { type: 'sync-flushed', requestId: 'expected' }), true);
  assert.equal(completed, true);
});

test('sync flush acknowledgement follows the queued edit and durable room flush', async () => {
  const received = deferred();
  const durable = deferred();
  const messages = [];
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState: 1, bufferedAmount: 0, inboundBudget: createInboundBudget(),
    send(data) { messages.push(JSON.parse(data)); }, close() {},
  });
  attachDocumentSocket({
    socket, documentId: 'main:localisation/russian/a.yml',
    ticketStore: { documentWritable: () => true }, isShuttingDown: () => false,
    room: {
      clientWritable: () => true,
      async receiveBinary() { received.resolve(); await durable.promise; },
      async flush() { await durable.promise; },
    },
  });
  const requestId = crypto.randomUUID();
  socket.emit('message', Buffer.from([1, 2, 3]), true);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'sync-flush', requestId })), false);
  await received.promise;
  assert.deepEqual(messages, []);
  durable.resolve();
  await socket.messageQueue;
  assert.deepEqual(messages, [{ type: 'sync-flushed', requestId }]);
});

test('document socket rejects non-object control JSON before passing it to the room', async () => {
  const socket = new EventEmitter();
  const messages = [];
  let dispatched = false;
  Object.assign(socket, {
    readyState: 1, bufferedAmount: 0, inboundBudget: createInboundBudget(),
    send(data) { messages.push(JSON.parse(data)); }, close() {},
  });
  attachDocumentSocket({
    socket, documentId: 'main:localisation/russian/a.yml',
    ticketStore: { documentWritable: () => true }, isShuttingDown: () => false,
    room: {
      clientWritable: () => true, flush() {}, receiveBinary() {},
      receiveJson() { dispatched = true; },
    },
  });
  socket.emit('message', Buffer.from('[]'), false);
  await socket.messageQueue;
  assert.equal(dispatched, false);
  assert.match(messages[0].message, /Invalid document control message/u);
});

test('closing retains an unsent update and clears only one acknowledged as sent', async () => {
  const pending = new Map();
  function fixture(sent) {
    const document = new Y.Doc();
    document.getText('content').insert(0, 'last local edit');
    let socketClosed = false;
    return {
      binding: {
        documentId: `main:localisation/russian/${sent ? 'sent' : 'offline'}.yml`,
        document, localUpdatePending: true, pendingUpdateSent: sent,
        personalRequestTimer: null, variantRequests: new Map(), reconnectTimer: null,
        hub: {
          savePendingDocumentUpdate(id, update) { pending.set(id, Buffer.from(update)); },
          clearPendingDocumentUpdate(id) { pending.delete(id); },
        },
        flushToServer: async () => true,
        socket: { close() { socketClosed = true; } },
        localPresences: { clear() {} }, clients: new Set(), baseWrites: new Set(), undoManagers: new Map(),
      },
      wasClosed: () => socketClosed,
    };
  }
  const offline = fixture(false);
  await closeDocument(offline.binding);
  assert.equal(offline.wasClosed(), true);
  assert.ok(pending.has(offline.binding.documentId), 'a read-only Git connection did not deliver the edit');
  const sent = fixture(true);
  await closeDocument(sent.binding);
  assert.equal(sent.wasClosed(), true);
  assert.equal(pending.has(sent.binding.documentId), false);
});

test('a deleted ticket keeps a readable copy of all unconfirmed edits, including previously sent edits', async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-deleted-ticket-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const hub = Object.create(AgentHub.prototype);
  hub.options = { state, repo: state, server: 'ws://localhost:10443' };
  function ticket(sent) {
    const document = new Y.Doc();
    document.getText('content').insert(0, 'ticket text');
    const notices = [];
    const client = { kind: 'review', documents: new Map(), send(message) { notices.push(message); } };
    const binding = {
      ticketId: crypto.randomUUID(), relativePath: 'localisation/russian/a_l_russian.yml',
      document, localUpdatePending: true, pendingUpdateSent: sent, paused: false, flushWaiter: null,
      personalRequestTimer: null, variantRequests: new Map(), reconnectTimer: null, hub,
      flushToServer: async () => false, socket: { close() {} },
      localPresences: { clear() {} }, clients: new Set([client]), baseWrites: new Set(), undoManagers: new Map(),
    };
    binding.documentId = `ticket-${binding.ticketId}:${binding.relativePath}`;
    client.documents.set('C:/repo/a.yml', { binding, basePersistPromise: Promise.resolve() });
    return { binding, notices };
  }
  const recovery = path.join(state, 'git-recovery', 'deleted-ticket');
  for (const sent of [true, false]) {
    const { binding, notices } = ticket(sent);
    // A buffer restored from an earlier session must not survive the deletion either.
    hub.savePendingDocumentUpdate(binding.documentId, Y.encodeStateAsUpdate(binding.document));
    handleSocketClose(binding);
    assert.equal(handleUnavailableTicketClose(binding, 1001, 'Ticket deleted'), true);
    assert.deepEqual(notices.filter((item) => item.type === 'ticketUnavailable').map((item) => item.reason), ['deleted']);
    await closeDocument(binding);
    assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null,
      'an undeliverable buffer would block repository updates forever');
    const saved = fs.existsSync(recovery) ? fs.readdirSync(recovery) : [];
    assert.equal(saved.length, sent ? 1 : 2, 'send() is not proof of durable acknowledgement');
    for (const file of saved) assert.equal(fs.readFileSync(path.join(recovery, file), 'utf8'), 'ticket text');
    assert.ok(notices.some((item) => item.type === 'notice' && saved.some((file) => item.message.includes(file))));
  }
  // Any other close reason keeps the normal retry buffer.
  const { binding } = ticket(false);
  handleSocketClose(binding);
  assert.equal(handleUnavailableTicketClose(binding, 1006, ''), false);
  await closeDocument(binding);
  assert.ok(hub.loadPendingDocumentUpdate(binding.documentId));
});

function recoveryFixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-ticket-recovery-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const hub = Object.create(AgentHub.prototype);
  hub.options = { state, repo: state, server: 'ws://localhost:10443' };
  const document = new Y.Doc();
  hub.ticketRemovals = new Map();
  hub.documents = new Map();
  document.getText('content').insert(0, 'first edit');
  const notices = [];
  const client = { kind: 'review', documents: new Map(), send(message) { notices.push(message); } };
  const binding = {
    ticketId: crypto.randomUUID(), relativePath: 'localisation/russian/a_l_russian.yml',
    document, localUpdatePending: true, pendingUpdateSent: false, synced: true, gitWritable: true,
    paused: false, flushWaiter: null, personalRequestTimer: null, variantRequests: new Map(), reconnectTimer: null,
    hub, flushToServer: async () => false, socket: { readyState: 1, send() {}, close() {} },
    localPresences: { clear() {} }, clients: new Set([client]), baseWrites: new Set(), undoManagers: new Map(),
  };
  binding.documentId = `ticket-${binding.ticketId}:${binding.relativePath}`;
  client.documents.set('C:/repo/a.yml', { binding, basePersistPromise: Promise.resolve() });
  return { binding, hub, notices, recovery: path.join(state, 'git-recovery', 'deleted-ticket') };
}

test('a later unsent edit is recovered even when an earlier edit was sent on the same socket', async (t) => {
  const { binding, hub, recovery } = recoveryFixture(t);
  forwardLocalUpdate(binding, Y.encodeStateAsUpdate(binding.document), true);
  assert.equal(binding.pendingUpdateSent, true);
  binding.socket.readyState = 2;
  binding.document.getText('content').insert(10, ' + later unsent edit');
  forwardLocalUpdate(binding, Y.encodeStateAsUpdate(binding.document), true);
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await closeDocument(binding);
  assert.equal(fs.readFileSync(path.join(recovery, fs.readdirSync(recovery)[0]), 'utf8'), 'first edit + later unsent edit');
  assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null);
  assert.equal(binding.gitWritable, false);
});

test('closing waits for the recovery copy and keeps the checkpoint until its write is complete', async (t) => {
  const { binding, hub, recovery } = recoveryFixture(t);
  const gate = deferred();
  const entered = deferred();
  const mkdir = fsPromises.mkdir;
  t.mock.method(fsPromises, 'mkdir', async (...args) => {
    if (args[0] === recovery) { entered.resolve(); await gate.promise; }
    return mkdir(...args);
  });
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket file removed');
  // The checkpoint is written synchronously, before Review can detach.
  assert.ok(hub.loadPendingDocumentUpdate(binding.documentId));
  const closing = closeDocument(binding);
  await entered.promise;
  assert.equal(binding.document.isDestroyed, false);
  assert.ok(hub.loadPendingDocumentUpdate(binding.documentId));
  gate.resolve();
  await closing;
  assert.equal(binding.document.isDestroyed, true);
  assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null);
  assert.equal(fs.readdirSync(recovery).length, 1);
});

test('recovery write failures retain the current CRDT checkpoint and report the error', async (t) => {
  const { binding, hub, notices, recovery } = recoveryFixture(t);
  t.mock.method(fsPromises, 'open', async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); });
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await closeDocument(binding);
  const restored = new Y.Doc();
  t.after(() => restored.destroy());
  Y.applyUpdate(restored, hub.loadPendingDocumentUpdate(binding.documentId));
  assert.equal(restored.getText('content').toString(), 'first edit');
  assert.deepEqual(fs.readdirSync(recovery), []);
  assert.ok(notices.some((item) => item.type === 'notice' && item.message.includes('Access denied')));
});

test('a recovery sync failure cannot retire the checkpoint or report success', async (t) => {
  const { binding, hub, notices } = recoveryFixture(t);
  const open = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args) => {
    const file = await open(...args);
    return {
      writeFile: (...values) => file.writeFile(...values),
      sync: async () => { throw Object.assign(new Error('No space left'), { code: 'ENOSPC' }); },
      close: () => file.close(),
    };
  });
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await closeDocument(binding);
  assert.ok(hub.loadPendingDocumentUpdate(binding.documentId));
  assert.ok(notices.some((item) => item.type === 'notice' && item.message.includes('No space left')));
  assert.ok(!notices.some((item) => item.type === 'notice' && item.message.includes('правки сохранены:')));
});

test('ticket deletion arriving during close waits for recovery rather than clearing its checkpoint on flush', async (t) => {
  const { binding, hub, recovery } = recoveryFixture(t);
  const gate = deferred();
  binding.pendingUpdateSent = true;
  binding.flushToServer = () => gate.promise;
  const closing = closeDocument(binding);
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  gate.resolve(true);
  await closing;
  assert.equal(fs.readFileSync(path.join(recovery, fs.readdirSync(recovery)[0]), 'utf8'), 'first edit');
  assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null);
});

test('a completed ticket recovery copy cannot remove a newer checkpoint', async (t) => {
  const { binding, hub, recovery } = recoveryFixture(t);
  const gate = deferred();
  const entered = deferred();
  const mkdir = fsPromises.mkdir;
  t.mock.method(fsPromises, 'mkdir', async (...args) => {
    if (args[0] === recovery) { entered.resolve(); await gate.promise; }
    return mkdir(...args);
  });
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await entered.promise;
  const newer = new Y.Doc();
  t.after(() => newer.destroy());
  newer.getText('content').insert(0, 'newer checkpoint');
  const update = Y.encodeStateAsUpdate(newer);
  hub.savePendingDocumentUpdate(binding.documentId, update);
  gate.resolve();
  await closeDocument(binding);
  assert.deepEqual(hub.loadPendingDocumentUpdate(binding.documentId), Buffer.from(update));
});

test('an edit landing after the deletion checkpoint replaces the copy instead of being dropped', async (t) => {
  const { binding, hub, notices, recovery } = recoveryFixture(t);
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  // Review has been told the ticket is gone, but a keystroke already in flight still arrives.
  binding.document.getText('content').insert(10, ' + typed after deletion');
  forwardLocalUpdate(binding, Y.encodeStateAsUpdate(binding.document), true);
  await closeDocument(binding);
  const saved = fs.readdirSync(recovery);
  assert.equal(saved.length, 1, 'one ticket keeps one copy and no temporary file');
  assert.equal(fs.readFileSync(path.join(recovery, saved[0]), 'utf8'), 'first edit + typed after deletion');
  assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null);
  assert.equal(notices.filter((item) => item.type === 'notice').length, 1, 'the same copy is announced once');
});

test('a failed rewrite keeps the earlier copy and the newer checkpoint', async (t) => {
  const { binding, hub, notices, recovery } = recoveryFixture(t);
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await binding.ticketRecovery.attempt;
  binding.document.getText('content').insert(10, ' + later');
  const rename = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (String(to).startsWith(recovery)) throw Object.assign(new Error('File is locked'), { code: 'EBUSY' });
    return rename(from, to);
  });
  await closeDocument(binding);
  const saved = fs.readdirSync(recovery);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(recovery, saved[0]), 'utf8'), 'first edit');
  const restored = new Y.Doc();
  t.after(() => restored.destroy());
  Y.applyUpdate(restored, hub.loadPendingDocumentUpdate(binding.documentId));
  assert.equal(restored.getText('content').toString(), 'first edit + later');
  assert.ok(notices.some((item) => item.type === 'notice' && item.message.includes('File is locked')));
});

test('a ticket this user removed through the Agent leaves neither a copy, a notice nor a buffer', async (t) => {
  const { binding, hub, notices, recovery } = recoveryFixture(t);
  // A buffer restored from an earlier session must go as well.
  hub.savePendingDocumentUpdate(binding.documentId, Uint8Array.of(1, 2, 3));
  hub.ticketRemovals = new Map();
  hub.expectTicketRemoval([binding.documentId], 'Ticket deleted');
  handleSocketClose(binding);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  binding.document.getText('content').insert(0, 'late ');
  await closeDocument(binding);
  assert.equal(fs.existsSync(recovery), false);
  assert.equal(hub.loadPendingDocumentUpdate(binding.documentId), null);
  assert.deepEqual(notices.map((item) => item.type), ['ticketUnavailable']);
});

test('removal intent is recorded before the request, withdrawn on failure and expires', async () => {
  const { handleTicketReviewApi } = await import('../apps/agent/src/ticket-review-api.mjs');
  const hub = Object.create(AgentHub.prototype);
  hub.ticketRemovals = new Map();
  const id = crypto.randomUUID();
  const file = 'localisation/russian/a_l_russian.yml';
  const documentId = `ticket-${id}:${file}`;
  hub.documents = new Map([[documentId, { ticketId: id, relativePath: file, documentId }]]);
  const seen = [];
  let fail = false;
  hub.ticketRequest = async () => {
    seen.push(hub.ticketRemovals.has(documentId));
    if (fail) throw new Error('forbidden');
    return { ok: true };
  };
  const call = (method, suffix = '') => handleTicketReviewApi({
    request: { method }, requestUrl: new URL(`http://127.0.0.1/api/tickets/${id}${suffix}`),
    response: { end() {} }, authorised: () => true, hub, options: {}, secureHeaders() {},
    readJsonBody: async () => ({ files: ['localisation/russian/b_l_russian.yml'] }),
  });
  await call('DELETE');
  await call('PUT', '/files');
  assert.deepEqual(seen, [true, true], 'the server closes the rooms before it answers');
  assert.equal(hub.consumeTicketRemoval(documentId, 'Ticket file removed', Date.now() + 61_000), false);
  assert.equal(hub.consumeTicketRemoval(crypto.randomUUID(), 'Ticket deleted'), false);
  fail = true;
  await call('DELETE');
  assert.equal(hub.ticketRemovals.has(documentId), false, 'a refused deletion is not this user’s removal');
  await call('GET');
  assert.equal(hub.ticketRemovals.has(documentId), false);
});

async function ticketApiCall(hub, id, method, suffix = '', files = []) {
  const { handleTicketReviewApi } = await import('../apps/agent/src/ticket-review-api.mjs');
  return handleTicketReviewApi({
    request: { method }, requestUrl: new URL(`http://127.0.0.1/api/tickets/${id}${suffix}`),
    response: { end() {} }, authorised: () => true, hub, options: {}, secureHeaders() {},
    readJsonBody: async () => ({ files }),
  });
}

test('removing file A never discards edits of kept file B subsequently removed by someone else', async (t) => {
  const a = recoveryFixture(t);
  const b = recoveryFixture(t);
  b.binding.ticketId = a.binding.ticketId;
  b.binding.relativePath = 'localisation/russian/b_l_russian.yml';
  b.binding.documentId = `ticket-${b.binding.ticketId}:${b.binding.relativePath}`;
  b.binding.hub = a.hub;
  a.hub.documents.set(a.binding.documentId, a.binding);
  a.hub.documents.set(b.binding.documentId, b.binding);
  a.hub.ticketRequest = async () => {
    assert.equal(a.hub.ticketRemovals.has(a.binding.documentId), true);
    assert.equal(a.hub.ticketRemovals.has(b.binding.documentId), false);
    handleUnavailableTicketClose(a.binding, 1001, 'Ticket file removed');
    return { ticket: { files: [b.binding.relativePath] } };
  };
  await ticketApiCall(a.hub, a.binding.ticketId, 'PUT', '/files', [b.binding.relativePath]);
  handleUnavailableTicketClose(b.binding, 1001, 'Ticket file removed');
  await Promise.all([closeDocument(a.binding), closeDocument(b.binding)]);
  assert.equal(a.binding.ticketRemovedLocally, true);
  assert.equal(b.binding.ticketRemovedLocally, false);
  const saved = fs.readdirSync(a.recovery);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].startsWith('b_l_russian.yml.'));
  assert.equal(fs.readFileSync(path.join(a.recovery, saved[0]), 'utf8'), 'first edit');
  assert.ok(!a.notices.some((item) => item.type === 'notice'));
  assert.ok(b.notices.some((item) => item.type === 'notice'));
  assert.equal(a.hub.ticketRemovals.size, 0);
});

test('adding files with Windows path separators does not mark any retained document for deletion', async (t) => {
  const { binding, hub, recovery } = recoveryFixture(t);
  hub.documents.set(binding.documentId, binding);
  hub.ticketRequest = async () => {
    assert.equal(hub.ticketRemovals.size, 0);
    return { ok: true };
  };
  await ticketApiCall(hub, binding.ticketId, 'PUT', '/files', [
    binding.relativePath.replaceAll('/', '\\'), 'localisation/russian/new_l_russian.yml',
  ]);
  handleUnavailableTicketClose(binding, 1001, 'Ticket deleted');
  await closeDocument(binding);
  assert.equal(binding.ticketRemovedLocally, false);
  assert.equal(fs.readdirSync(recovery).length, 1);
});

test('file-removal intent cannot suppress recovery for a different close reason or survive room recreation', (t) => {
  const { binding, hub } = recoveryFixture(t);
  t.after(() => binding.document.destroy());
  hub.expectTicketRemoval([binding.documentId], 'Ticket file removed');
  assert.equal(hub.consumeTicketRemoval(binding.documentId, 'Ticket deleted'), false);
  assert.equal(hub.ticketRemovals.size, 0);
  hub.expectTicketRemoval([binding.documentId], 'Ticket file removed');
  assert.equal(hub.consumeTicketRemoval(binding.documentId, 'Ticket file removed'), true);
  assert.equal(hub.consumeTicketRemoval(binding.documentId, 'Ticket file removed'), false);
});

test('withdrawing an overlapping request removes only that request and expired intents are pruned', (t) => {
  const { binding, hub } = recoveryFixture(t);
  t.after(() => binding.document.destroy());
  const withdraw = hub.expectTicketRemoval([binding.documentId], 'Ticket deleted', 1000);
  hub.expectTicketRemoval([binding.documentId], 'Ticket deleted', 2000);
  withdraw();
  assert.equal(hub.consumeTicketRemoval(binding.documentId, 'Ticket deleted', 2001), true);
  hub.expectTicketRemoval([binding.documentId], 'Ticket deleted', 1000);
  hub.expectTicketRemoval(['another-document'], 'Ticket deleted', 62_000);
  assert.equal(hub.ticketRemovals.has(binding.documentId), false);
  assert.equal(hub.consumeTicketRemoval('another-document', 'Ticket deleted', 62_001), true);
});

test('a locally requested whole-ticket deletion marks all its open documents but no other ticket', async (t) => {
  const { binding, hub } = recoveryFixture(t);
  t.after(() => binding.document.destroy());
  const anotherPath = 'localisation/russian/b_l_russian.yml';
  const anotherId = `ticket-${binding.ticketId}:${anotherPath}`;
  const foreignId = `ticket-${crypto.randomUUID()}:${anotherPath}`;
  hub.documents = new Map([
    [binding.documentId, binding],
    [anotherId, { ticketId: binding.ticketId, relativePath: anotherPath, documentId: anotherId }],
    [foreignId, { ticketId: crypto.randomUUID(), relativePath: anotherPath, documentId: foreignId }],
  ]);
  hub.ticketRequest = async () => {
    assert.deepEqual([...hub.ticketRemovals.keys()], [binding.documentId, anotherId]);
    return { ok: true };
  };
  await ticketApiCall(hub, binding.ticketId, 'DELETE');
  assert.equal(hub.consumeTicketRemoval(binding.documentId, 'Ticket deleted'), true);
  assert.equal(hub.consumeTicketRemoval(anotherId, 'Ticket deleted'), true);
  assert.equal(hub.consumeTicketRemoval(foreignId, 'Ticket deleted'), false);
});

test('a locked buffer during own deletion cannot throw from socket close and retains the latest edits', async (t) => {
  const { binding, hub, notices, recovery } = recoveryFixture(t);
  const target = hub.pendingDocumentUpdatePath(binding.documentId);
  hub.savePendingDocumentUpdate(binding.documentId, Y.encodeStateAsUpdate(binding.document));
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === target) throw Object.assign(new Error('Buffer is locked'), { code: 'EACCES' });
    return unlink(file);
  });
  // Disconnected notification recipients must not turn the handled I/O error into a crash.
  binding.clients.add({ kind: 'extension', documents: new Map(), send() { throw new Error('Peer disconnected'); } });
  hub.expectTicketRemoval([binding.documentId], 'Ticket deleted');
  assert.doesNotThrow(() => handleUnavailableTicketClose(binding, 1001, 'Ticket deleted'));
  binding.document.getText('content').insert(10, ' + latest');
  await closeDocument(binding);
  const restored = new Y.Doc();
  t.after(() => restored.destroy());
  Y.applyUpdate(restored, hub.loadPendingDocumentUpdate(binding.documentId));
  assert.equal(restored.getText('content').toString(), 'first edit + latest');
  assert.equal(binding.document.isDestroyed, true);
  assert.equal(fs.existsSync(recovery), false);
  assert.equal(notices.filter((item) => item.type === 'notice').length, 1);
  assert.ok(notices.some((item) => item.message?.includes('Buffer is locked')));
});

test('a discard failure followed by a checkpoint failure still retains the older buffer and reports both', async (t) => {
  const { binding, hub, notices } = recoveryFixture(t);
  const original = Y.encodeStateAsUpdate(binding.document);
  hub.savePendingDocumentUpdate(binding.documentId, original);
  hub.discardPendingDocumentUpdate = () => { throw new Error('Access denied'); };
  hub.savePendingDocumentUpdate = () => { throw new Error('No space left'); };
  hub.expectTicketRemoval([binding.documentId], 'Ticket deleted');
  assert.doesNotThrow(() => handleUnavailableTicketClose(binding, 1001, 'Ticket deleted'));
  await closeDocument(binding);
  assert.deepEqual(hub.loadPendingDocumentUpdate(binding.documentId), Buffer.from(original));
  const errors = notices.filter((item) => item.type === 'notice');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes('Access denied'));
  assert.ok(errors[0].message.includes('No space left'));
});

test('an older closing binding cannot remove a newer pending snapshot', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-pending-update-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const hub = Object.create(AgentHub.prototype);
  hub.options = { state, repo: state, server: 'ws://localhost:10443' };
  const id = 'main:localisation/russian/a.yml';
  const older = Buffer.from([1, 2, 3]);
  const newer = Buffer.from([4, 5, 6]);
  hub.savePendingDocumentUpdate(id, older);
  hub.savePendingDocumentUpdate(id, newer);
  assert.equal(hub.clearPendingDocumentUpdate(id, older), false);
  assert.deepEqual(hub.loadPendingDocumentUpdate(id), newer);
  assert.equal(hub.clearPendingDocumentUpdate(id, newer), true);
  assert.equal(hub.loadPendingDocumentUpdate(id), null);
});

test('external merge forwards the personal text and user notice', () => {
  const sent = [];
  const state = {};
  const client = { documents: new Map([['file', state]]), send(message) { sent.push(message); } };
  const binding = { clients: new Set([client]), applyMergedText() {} };
  state.binding = binding;
  DocumentBinding.prototype.finishExternalMerge.call(
    binding, client, 'file', state, 'shared', 'personal', 'merge complete',
  );
  assert.equal(binding.personalText, 'personal');
  assert.equal(sent.find((message) => message.type === 'notice').message, 'merge complete');
});
