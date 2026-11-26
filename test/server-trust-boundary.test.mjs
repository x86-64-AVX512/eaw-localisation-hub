import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { attachDocumentSocket } from '../apps/server/src/document-socket.mts';
import { createInboundBudget, MAX_QUEUED_INBOUND_BYTES } from '../apps/server/src/protocol-limits.mts';
import { DocumentHistory } from '../apps/server/src/document-history.mjs';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';
import { CrdtUpdateValidator, CrdtValidationError } from '../apps/server/src/crdt-validator.mjs';
import { updateReservation } from '../apps/server/src/reservation-update.mjs';

function documentSocket(room) {
  const socket = new EventEmitter();
  const messages = [];
  const closes = [];
  Object.assign(socket, {
    readyState: 1,
    bufferedAmount: 0,
    inboundBudget: createInboundBudget(),
    send(data) {
      messages.push(JSON.parse(data));
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  });
  attachDocumentSocket({
    socket,
    documentId: 'main:localisation/russian/a.yml',
    ticketStore: { documentWritable: () => true },
    isShuttingDown: () => false,
    authoriseSession() {},
    room: { clientWritable: () => true, flush() {}, receiveBinary() {}, ...room },
  });
  return { socket, messages, closes };
}

test('an error reply for a deeply nested id neither crashes the process nor stalls the socket queue', async () => {
  let handled = 0;
  const { socket, messages } = documentSocket({
    receiveJson(_socket, control) {
      handled += 1;
      if (control.type === 'comment-create') throw new Error('Discussion id is missing or exceeds the protocol limit');
    },
  });
  const depth = 200_000;
  const nested = `{"type":"comment-create","requestId":"r","id":${'['.repeat(depth)}${']'.repeat(depth)}}`;
  assert.throws(() => JSON.stringify(JSON.parse(nested)), RangeError, 'fixture must overflow JSON.stringify');
  socket.emit('message', Buffer.from(nested), false);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'presence' })), false);
  await socket.messageQueue;
  assert.equal(handled, 2, 'the message after the failed reply is still processed');
  assert.deepEqual(messages[0], {
    type: 'discussion-result',
    requestId: 'r',
    id: '',
    status: 'error',
    message: 'Discussion id is missing or exceeds the protocol limit',
  });
});

test('frames waiting behind a slow room are bounded before they reach the inbound budget', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const { socket, closes } = documentSocket({
    async receiveBinary() {
      await blocked;
    },
  });
  const frame = Buffer.alloc(4 * 1024 * 1024);
  const cost = frame.length + 1024;
  const frames = Math.floor(MAX_QUEUED_INBOUND_BYTES / cost);
  for (let index = 0; index < frames; index += 1) socket.emit('message', frame, true);
  assert.deepEqual(closes, []);
  socket.emit('message', frame, true);
  assert.deepEqual(closes, [{ code: 1013, reason: 'Inbound message queue limit exceeded' }]);
  release();
  await socket.messageQueue;
  assert.equal(socket.queuedInboundBytes, 0);
});

test('history JSON keeps replacement patterns in author names literal and reloads', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-dollar-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  const history = new DocumentHistory(target);
  history.ensureBaseline('l_russian:\n key:0 "A"\n');
  for (const name of ["Va$'ya", 'Pe$`tya', 'Ko$&lya', 'Ma$$ha']) {
    history.record(`l_russian:\n key:0 "${name}"\n`, { id: name, displayName: name }, 'edit', { coalesce: false });
  }
  await fs.writeFile(target, await history.serialiseAsync());
  const reloaded = new DocumentHistory(target);
  await reloaded.load();
  assert.deepEqual(
    reloaded.entries.slice(1).map((entry) => entry.author),
    ["Va$'ya", 'Pe$`tya', 'Ko$&lya', 'Ma$$ha'],
  );
});

test('an unreadable history file is set aside instead of making the room unopenable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-broken-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  await fs.writeFile(target, '{"schema":5,"entries":[{"id":"1","author":"Va,"ownership":[]}');
  const warning = t.mock.method(console, 'warn', () => {});
  const history = new DocumentHistory(target);
  await history.load();
  assert.deepEqual(history.entries, []);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(
    (await fs.readdir(directory)).some((name) => name.startsWith('history.json.unreadable-')),
    true,
  );
});

function restoreRoom() {
  const document = new Y.Doc();
  const text = document.getText('content');
  text.insert(0, 'l_russian:\n key:0 "Old"\n');
  const history = new DocumentHistory('unused');
  history.ensureBaseline(text.toString());
  const old = history.headId();
  const room = Object.assign(Object.create(DocumentRoom.prototype), {
    document,
    history,
    destroyed: false,
    documentId: 'main:localisation/russian/a.yml',
    authStore: { required: false },
    registry: { assertStateBudget() {} },
  });
  return { room, text, old };
}

test('history restore refuses when the live text moved past an unrecorded head', () => {
  const { room, text, old } = restoreRoom();
  // An edit that history did not record (e.g. above its size limit) leaves the head id unchanged.
  text.insert(text.length, ' fresh:0 "Newer"\n');
  const socket = { readyState: 1, identity: { id: 'alice' } };
  assert.throws(
    () => room.applyJson(socket, { type: 'history-restore', id: old, headId: old }),
    /Document changed after the history view was opened/u,
  );
  assert.match(text.toString(), /Newer/u);
});

test('CRDT validator rejects root types other than the shared content text', async (t) => {
  const validator = new CrdtUpdateValidator({ maximumStateBytes: 1024 * 1024 });
  t.after(() => validator.close());
  const document = new Y.Doc();
  document.getText('content').insert(0, 'l_russian:\n');
  document.getMap('hidden').set('payload', 'x'.repeat(1024));
  await assert.rejects(() => validator.validate(Y.encodeStateAsUpdate(document)), CrdtValidationError);
  document.destroy();
});

test('a reservation update rejects a range whose derived key exceeds the create limit', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const longKey = 'k'.repeat(300);
  text.insert(0, `l_russian:\n ${longKey}:0 "Value"\n`);
  const relative = (index, assoc) =>
    Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc))).toString('base64');
  const start = text.toString().indexOf(` ${longKey}`);
  const reservation = {
    id: 'r1',
    revision: 0,
    assigneeId: 'alice',
    assignee: 'Alice',
    color: '#123456',
    createdById: 'alice',
    createdBy: 'Alice',
    comment: '',
    initialKeys: ['short'],
    startRelative: relative(0, 0),
    endRelative: relative(1, -1),
  };
  const room = {
    document,
    reservations: [reservation],
    assertMetadataBudget() {},
    schedulePersist() {},
    broadcastReservations() {},
    authStore: { required: false },
  };
  assert.throws(
    () =>
      updateReservation(
        room,
        { identity: { id: 'alice', roles: ['translator'] } },
        {
          id: 'r1',
          expectedRevision: 0,
          startRelative: relative(start, 0),
          endRelative: relative(text.length, -1),
        },
      ),
    /Reservation key is too long/u,
  );
  assert.deepEqual(room.reservations[0].initialKeys, ['short']);
});

test('the room metadata budget measures the exact persisted form', () => {
  const room = Object.assign(Object.create(DocumentRoom.prototype), {
    reservations: [],
    commentThreads: [
      { id: 't', messages: Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, body: 'x' })) },
    ],
    suggestions: [],
    gitBase: null,
  });
  assert.equal(
    room.metadataJson(),
    JSON.stringify(
      { schema: 3, reservations: [], commentThreads: room.commentThreads, suggestions: [], gitBase: null },
      null,
      2,
    ),
  );
  assert.ok(
    room.metadataJson().length > JSON.stringify({ commentThreads: room.commentThreads }).length * 1.2,
    'indentation is part of the measured size',
  );
});

test('a room saved with a foreign root before the root check still accepts ordinary text edits', async (t) => {
  const validator = new CrdtUpdateValidator({ maximumStateBytes: 1024 * 1024 });
  t.after(() => validator.close());
  const legacy = new Y.Doc();
  legacy.getText('content').insert(0, 'l_russian:\n');
  legacy.getMap('legacy').set('payload', 'x');
  const base = Y.encodeStateAsUpdate(legacy);
  const client = new Y.Doc();
  Y.applyUpdate(client, base);
  client.getText('content').insert(client.getText('content').length, ' key:0 "A"\n');
  const edit = Y.encodeStateAsUpdate(client, Y.encodeStateVectorFromUpdate(base));
  assert.ok((await validator.validate(edit, base)).stateBytes > 0);
  client.getMap('fresh').set('payload', 'y');
  await assert.rejects(
    () => validator.validate(Y.encodeStateAsUpdate(client, Y.encodeStateVectorFromUpdate(base)), base),
    CrdtValidationError,
  );
  legacy.destroy();
  client.destroy();
});

test('reservations loaded from older data drop keys that Agent would reject', async () => {
  const { minimalReservation } = await import('../apps/server/src/room-metadata.mjs');
  const loaded = minimalReservation({
    id: 'r',
    startRelative: 's',
    endRelative: 'e',
    initialKeys: ['ok', 'k'.repeat(5000)],
  });
  assert.deepEqual(loaded.initialKeys, ['ok']);
});

test('resolving a discussion at the metadata limit is refused and rolled back', async () => {
  const { applyDiscussionControl } = await import('../apps/server/src/discussion-control.mjs');
  const thread = { id: 't', authorId: 'alice', status: 'open', messages: [] };
  const room = {
    commentThreads: [thread],
    suggestions: [],
    actorFor: (socket) => socket.identity,
    assertMetadataBudget() {
      if (thread.status === 'resolved') throw new Error('Room metadata exceeds the persistence limit');
    },
    notifyTicketOwner() {},
    schedulePersist() {},
    broadcastReview() {},
  };
  assert.throws(
    () =>
      applyDiscussionControl(
        room,
        { identity: { id: 'alice' } },
        { type: 'comment-status', id: 't', status: 'resolved' },
      ),
    /persistence limit/u,
  );
  assert.equal(thread.status, 'open');
});

test('only the newest unreadable history copy is kept', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-aside-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  t.mock.method(console, 'warn', () => {});
  for (let round = 0; round < 3; round += 1) {
    await fs.writeFile(target, '{broken');
    await new DocumentHistory(target).load();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await fs.readdir(directory)).filter((name) => name.startsWith('history.json.unreadable-')).length, 1);
});

test('queued frames across all sockets share one memory bound', async () => {
  const { MAX_TOTAL_QUEUED_INBOUND_BYTES } = await import('../apps/server/src/protocol-limits.mts');
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const frame = Buffer.alloc(4 * 1024 * 1024);
  const cost = frame.length + 1024;
  const perSocket = Math.floor(MAX_QUEUED_INBOUND_BYTES / cost);
  const sockets = [];
  let queued = 0;
  while (queued + cost <= MAX_TOTAL_QUEUED_INBOUND_BYTES) {
    const entry = documentSocket({
      async receiveBinary() {
        await blocked;
      },
    });
    sockets.push(entry);
    for (let index = 0; index < perSocket && queued + cost <= MAX_TOTAL_QUEUED_INBOUND_BYTES; index += 1) {
      entry.socket.emit('message', frame, true);
      queued += cost;
    }
  }
  assert.ok(sockets.every(({ closes }) => closes.length === 0));
  const extra = documentSocket({ receiveBinary() {} });
  extra.socket.emit('message', frame, true);
  assert.deepEqual(extra.closes, [{ code: 1013, reason: 'Inbound message queue limit exceeded' }]);
  release();
  await Promise.all(sockets.map(({ socket }) => socket.messageQueue));
});

test('empty frames are charged a per-frame cost so they cannot queue without bound', () => {
  const { socket, closes } = documentSocket({
    receiveBinary() {
      return new Promise(() => {});
    },
  });
  const limit = Math.floor(MAX_QUEUED_INBOUND_BYTES / 1024);
  for (let index = 0; index < limit; index += 1) socket.emit('message', Buffer.alloc(0), true);
  assert.deepEqual(closes, []);
  socket.emit('message', Buffer.alloc(0), true);
  assert.equal(closes.length, 1);
});

test('a history version too large for one frame is refused without closing the socket', () => {
  // About 9.6 MB of UTF-8: within the room limit, but over one frame once base64-encoded.
  const big = `l_russian:\n key:0 "${'я'.repeat(4_800_000)}"\n`;
  const history = new DocumentHistory('unused');
  history.ensureBaseline(big);
  const sent = [];
  const room = Object.assign(Object.create(DocumentRoom.prototype), {
    history,
    destroyed: false,
    documentId: 'main:localisation/russian/a.yml',
    authStore: { required: false },
  });
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    identity: { id: 'alice' },
    send(value) {
      sent.push(value);
    },
    close() {
      throw new Error('socket must stay open');
    },
  };
  assert.throws(() => room.applyJson(socket, { type: 'history-get', id: history.headId() }), /too large to display/u);
  assert.deepEqual(sent, []);
});
