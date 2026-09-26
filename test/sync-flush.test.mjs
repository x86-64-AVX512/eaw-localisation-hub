import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';
import { closeDocument } from '../apps/agent/src/document-lifecycle.mts';
import { DocumentBinding } from '../apps/agent/src/document-binding.mjs';
import { handleFlushAcknowledgement } from '../apps/agent/src/document-delivery.mts';
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
