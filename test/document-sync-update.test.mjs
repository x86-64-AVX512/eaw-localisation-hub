import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { documentUpdateForServer } from '../apps/agent/src/document-sync-update.mjs';

function pair(t, text = 'l_russian:\n same:0 "One"\n same:0 "Two"\n') {
  const remote = new Y.Doc(), local = new Y.Doc();
  t.after(() => { remote.destroy(); local.destroy(); });
  remote.getText('content').insert(0, text);
  const snapshot = Y.encodeStateAsUpdate(remote);
  Y.applyUpdate(local, snapshot);
  return { remote, local, vector: Y.encodeStateVectorFromUpdate(snapshot) };
}

test('initial sync does not echo an unchanged full remote document', (t) => {
  const { local, vector } = pair(t, 'x'.repeat(900_000));
  assert.equal(documentUpdateForServer(local, vector, false), null);
  assert.equal(documentUpdateForServer(local, vector, true).length, 2);
});

test('remote deletion history alone is not uploaded again', (t) => {
  const { remote, local } = pair(t);
  remote.getText('content').delete(0, 1);
  const snapshot = Y.encodeStateAsUpdate(remote);
  Y.applyUpdate(local, snapshot);
  assert.equal(documentUpdateForServer(local, Y.encodeStateVectorFromUpdate(snapshot), false), null);
});

test('recovered offline inserts upload only missing structs and survive reconnect', (t) => {
  const { remote, local, vector } = pair(t, 'x'.repeat(900_000));
  local.getText('content').insert(100, 'Recovered');
  const update = documentUpdateForServer(local, vector, true);
  assert.ok(update && update.length < 200);
  Y.applyUpdate(remote, update);
  assert.equal(remote.getText('content').toString(), local.getText('content').toString());
  const nextVector = Y.encodeStateVectorFromUpdate(Y.encodeStateAsUpdate(remote));
  assert.equal(documentUpdateForServer(local, nextVector, true).length, 2);
});

test('delete-only recovery changes just the second duplicate despite identical state vectors', (t) => {
  const { remote, local, vector } = pair(t);
  const text = local.getText('content');
  text.delete(text.toString().indexOf(' same:0 "Two"'), ' same:0 "Two"\n'.length);
  assert.deepEqual(Y.encodeStateVector(local), vector);
  const update = documentUpdateForServer(local, vector, true);
  assert.ok(update);
  assert.equal(Y.decodeUpdate(update).structs.length, 0);
  Y.applyUpdate(remote, update);
  assert.equal(remote.getText('content').toString(), 'l_russian:\n same:0 "One"\n');
});

test('missing remote vector keeps the complete recovery fallback', (t) => {
  const { remote, local } = pair(t);
  local.getText('content').delete(0, 1);
  const update = documentUpdateForServer(local, null, true);
  assert.ok(update);
  Y.applyUpdate(remote, update);
  assert.equal(remote.getText('content').toString(), local.getText('content').toString());
});
