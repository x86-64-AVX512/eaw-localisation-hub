import assert from 'node:assert/strict';
import test from 'node:test';
import { sendStartupChangedFiles } from '../apps/server/src/document-startup.mjs';
import { RoomRegistry } from '../apps/server/src/room-registry.mjs';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';

function fixture() {
  const sent = [], snapshot = { commit: 'new', blob: 'blob', branch: 'branch' };
  const socket = { readyState: 1, bufferedAmount: 0, localHead: 'old', changedFiles: [],
    send: (message) => sent.push(JSON.parse(message)) };
  const room = { gitBase: { ...snapshot }, clients: new Set([socket]),
    enqueueMessage: async (operation) => operation(),
    gitStatusFor: (client) => ({ type: 'git-status', status: 'branch-outdated', changedFiles: client.changedFiles }) };
  return { sent, snapshot, socket, room };
}

test('slow startup history is delivered later without changing write permission', async () => {
  const { sent, snapshot, socket, room } = fixture();
  let release;
  const source = { enabled: true, changedFilesSince: (_documentId, _localHead, options) => {
    assert.equal(options.remoteHead, snapshot.commit);
    return new Promise((resolve) => { release = resolve; });
  } };
  socket.gitWritable = true;
  const pending = sendStartupChangedFiles(source, 'branch:file', socket, room, snapshot);
  assert.deepEqual(sent, []);
  release(['localisation/russian/other.yml']); await pending;
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].changedFiles, ['localisation/russian/other.yml']);
  assert.equal(socket.gitWritable, true);
});

test('a current Git head requires no background history lookup', async () => {
  const { sent, snapshot, socket, room } = fixture();
  socket.localHead = snapshot.commit;
  await sendStartupChangedFiles({ enabled: true, changedFilesSince() { assert.fail('unnecessary lookup'); } },
    'branch:file', socket, room, snapshot);
  assert.deepEqual(sent, []);
});

test('late history never clears a conflict or updates a disconnected or changed snapshot', async () => {
  for (const mutate of [
    ({ room }) => { room.gitConflict = true; },
    ({ room }) => { room.gitBase.stale = true; },
    ({ room }) => { room.gitBase.commit = 'newer'; },
    ({ room }) => { room.gitBase.blob = 'another'; },
    ({ room }) => { room.clients.clear(); },
    ({ socket }) => { socket.readyState = 3; },
    ({ socket }) => { socket.localHead = 'changed'; },
  ]) {
    const state = fixture(); let release;
    const pending = sendStartupChangedFiles({ enabled: true,
      changedFilesSince: () => new Promise((resolve) => { release = resolve; }) },
    'branch:file', state.socket, state.room, state.snapshot);
    mutate(state); release(['localisation/russian/other.yml']); await pending;
    assert.deepEqual(state.sent, []);
  }
});

test('history failure leaves the validated document connected', async () => {
  const { sent, snapshot, socket, room } = fixture();
  await sendStartupChangedFiles({ enabled: true, changedFilesSince: async () => { throw new Error('offline'); } },
    'branch:file', socket, room, snapshot);
  assert.equal(room.clients.has(socket), true); assert.deepEqual(sent, []);
});

test('cold room reuses the connection-validated canonical snapshot', async (t) => {
  const snapshot = { commit: 'known', text: 'validated' }, applied = [];
  t.mock.method(DocumentRoom.prototype, 'loadFromDisk', async () => {});
  t.mock.method(DocumentRoom.prototype, 'applyCanonicalSnapshot', async (value) => { applied.push(value); });
  const source = { enabled: true, snapshot() { assert.fail('duplicate canonical lookup'); } };
  const registry = new RoomRegistry('unused', {}, null, async () => {});
  const room = await DocumentRoom.load('unused', 'branch:localisation/russian/a.yml', {}, registry, source, snapshot);
  t.after(() => room.destroy());
  assert.deepEqual(applied, [snapshot]);
});

test('room registry passes the supplied snapshot to a single shared cold loader', async () => {
  const snapshot = { commit: 'known' }; let loads = 0;
  const room = { stateBudgetBytes: 0, clients: new Set() };
  const registry = new RoomRegistry('unused', {}, async (_directory, _id, _store, _registry, supplied) => {
    loads += 1; assert.equal(supplied, snapshot); return room;
  }, async () => {});
  const id = 'branch:localisation/russian/a.yml';
  const results = await Promise.all([registry.get(id, snapshot), registry.get(id, snapshot)]);
  assert.equal(loads, 1); assert.deepEqual(results, [room, room]);
});
