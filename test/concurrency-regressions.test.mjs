import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import * as Y from 'yjs';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';
import { TicketService } from '../apps/server/src/ticket-service.mjs';
import { RoomRegistry } from '../apps/server/src/room-registry.mjs';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { attachDocumentSocket } from '../apps/server/src/document-socket.mjs';
import { createInboundBudget } from '../apps/server/src/protocol-limits.mjs';
import { checkDiskChange } from '../apps/agent/src/disk-reconciliation.mjs';
import { DiffCache } from '../apps/agent/src/diff-cache.mjs';
import {
  localisationAuditCacheKey,
  prepareLocalisationAudit,
} from '../apps/agent/src/localisation-audit.mjs';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const b64 = (text) => Buffer.from(text).toString('base64');
const actor = { id: 'tester', displayName: 'Tester' };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function write(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}
class Room {
  constructor(text) { this.text = text; this.messageQueue = Promise.resolve(); }
  currentText() { return this.text; }
  prepareReplacement(text) { return { value: text, stateBytes: text.length }; }
  replacePrepared(prepared) { this.text = prepared.value; }
  async flush() { await this.messageQueue; }
}

test('ticket apply rechecks every room after all rooms are acquired and locked', async () => {
  const files = ['localisation/russian/a.yml', 'localisation/russian/b.yml'];
  const ticket = { id: 'ticket', files, baseBranch: 'main', baseCommit: 'a'.repeat(40), status: 'review' };
  const mainA = new Room('base-a');
  const mainB = new Room('base-b');
  const ticketA = new Room('ticket-a');
  const ticketB = new Room('ticket-b');
  const gate = deferred();
  const entered = deferred();
  const rooms = new Map([
    [`ticket-ticket:${files[0]}`, ticketA], [`main:${files[0]}`, mainA],
    [`ticket-ticket:${files[1]}`, ticketB], [`main:${files[1]}`, mainB],
  ]);
  const registry = {
    withRoomsLocked: RoomRegistry.prototype.withRoomsLocked,
    assertBatchStateBudget() {},
    async get(id) {
      if (id === `ticket-ticket:${files[1]}`) { entered.resolve(); await gate.promise; }
      return rooms.get(id);
    },
  };
  const service = new TicketService({
    get: () => ticket,
    async systemStatus() { throw new Error('must not apply'); },
  }, registry);
  const pending = service.apply(actor, ticket.id, { results: files.map((file, index) => ({
    path: file,
    ticketHash: hash(index ? 'ticket-b' : 'ticket-a'),
    mainHash: hash(index ? 'base-b' : 'base-a'),
    textBase64: b64(index ? 'merged-b' : 'merged-a'),
  })) });
  await entered.promise;
  mainA.text = 'new concurrent edit';
  gate.resolve();
  await assert.rejects(pending, /changed during apply/u);
  assert.equal(mainA.text, 'new concurrent edit');
});

test('ticket rebase verifies the new Git base before replacing room text', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-rebase-order-'));
  try {
    const file = 'localisation/russian/a.yml';
    const store = new TicketStore(temporary, write);
    const ticket = await store.create(actor, {
      title: 'Test', baseBranch: 'main', baseCommit: 'a'.repeat(40), files: [file],
    });
    store.commitVerifier = { async verify() { throw new Error('Git verifier unavailable'); } };
    const room = new Room('old text');
    const service = new TicketService(store, {
      async get() { return room; }, assertBatchStateBudget() {},
    });
    await assert.rejects(service.rebase(actor, ticket.id, {
      baseBranch: 'main', baseCommit: 'b'.repeat(40),
      results: [{ path: file, ticketHash: hash('old text'), textBase64: b64('rebased text') }],
    }), /Git verifier unavailable/u);
    assert.equal(room.text, 'old text');
    assert.equal(store.get(ticket.id).baseCommit, 'a'.repeat(40));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('deleting a room wins over an already running persistence write', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-delete-persist-'));
  const gate = deferred();
  const entered = deferred();
  const id = 'ticket-test:localisation/russian/a.yml';
  const digest = hash(id);
  const registry = new RoomRegistry(temporary, {}, null, async (target, value) => {
    entered.resolve();
    await gate.promise;
    await write(target, value);
  });
  const room = {
    hash: digest, clients: new Set(), destroyed: false,
    destroy() { this.destroyed = true; },
    updatePath: path.join(temporary, 'documents', `${digest}.update`),
    metadataPath: path.join(temporary, 'documents', `${digest}.json`),
    historyPath: path.join(temporary, 'documents', `${digest}.history.json`),
  };
  registry.rooms.set(id, room);
  const pending = registry.persistRoom(room, Buffer.from('update'), '{}', '{}');
  try {
    await entered.promise;
    const deletion = registry.deleteDocuments([id]);
    gate.resolve();
    await Promise.all([pending, deletion]);
    await assert.rejects(fs.access(room.updatePath), { code: 'ENOENT' });
    await assert.rejects(fs.access(room.metadataPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(room.historyPath), { code: 'ENOENT' });
    assert.equal(registry.persisted.has(digest), false);
  } finally {
    gate.resolve();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('a detached binding ignores a disk read that completes late', async () => {
  const gate = deferred();
  const absolutePath = 'C:\\repo\\localisation\\russian\\a.yml';
  const before = 'l_russian:\n key:0 "old"\n';
  const external = 'l_russian:\n key:0 "new"\n';
  const state = { diskBase: before, materialisationExpected: null };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  let merged = false;
  const binding = {
    ticketId: '', paused: false, synced: true, gitWritable: true,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => before },
    readDiskText: () => gate.promise,
    localFileText: () => before,
    text: { toString: () => before },
    finishExternalMerge() { merged = true; },
  };
  state.binding = binding;
  const pending = checkDiskChange(binding, client, absolutePath, state);
  binding.paused = true;
  client.documents.delete(absolutePath);
  gate.resolve(external);
  await pending;
  assert.equal(merged, false);
});

test('localisation audit value and cache key come from the same file snapshot', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-snapshot-'));
  try {
    const ru = 'localisation/russian/a.yml';
    const en = 'localisation/english/a.yml';
    await write(path.join(temporary, ru), 'l_russian:\n key:0 "translation"\n');
    await write(path.join(temporary, en), 'l_english:\n key:0 "original"\n');
    const prepared = await prepareLocalisationAudit(temporary, ru);
    await write(path.join(temporary, en), 'l_english:\n key:0 "CHANGED"\n');
    const cache = new DiffCache(path.join(temporary, 'cache'));
    await cache.set('localisation-audit', prepared.cacheKey, prepared.create());
    assert.equal((await cache.get('localisation-audit', prepared.cacheKey)).rows[0].english.text, 'original');
    assert.notEqual(await localisationAuditCacheKey(temporary, ru), prepared.cacheKey);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('queued CRDT updates are re-authorised immediately before application', async () => {
  const registry = { persistedBytesFor: () => 0, assertStateBudget() {} };
  const room = new DocumentRoom(os.tmpdir(), 'ticket-test:localisation/russian/a.yml', 'test', { required: false }, registry);
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState: 1, bufferedAmount: 0, gitWritable: true,
    inboundBudget: createInboundBudget(), send() {}, close() {},
  });
  let writable = true;
  attachDocumentSocket({
    socket, documentId: room.documentId, room,
    ticketStore: { documentWritable: () => writable }, isShuttingDown: () => false,
  });
  const gate = deferred();
  const entered = deferred();
  room.enqueueMessage(() => gate.promise);
  const receiveBinary = room.receiveBinary.bind(room);
  room.receiveBinary = (...args) => { entered.resolve(); return receiveBinary(...args); };
  const source = new Y.Doc();
  source.getText('content').insert(0, 'late edit');
  try {
    socket.emit('message', Buffer.from(Y.encodeStateAsUpdate(source)), true);
    await entered.promise;
    writable = false;
    socket.gitWritable = false;
    gate.resolve();
    await socket.messageQueue;
    assert.equal(room.currentText(), '');
  } finally {
    gate.resolve();
    room.destroy();
    source.destroy();
    await closeDocumentRoomValidator();
  }
});
