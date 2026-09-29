import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { WebSocket } from 'ws';
import { encodeMergeText, decodeMergeText } from '../packages/shared/src/merge-wire.mts';
import { MAX_MESSAGE_BYTES, MAX_ROOM_STATE_BYTES } from '../packages/shared/src/constants.mts';
import { validateServerMessage } from '../packages/shared/src/protocol-schema.mts';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';
import { requestDiskMergeCheck, receiveDiskMergeResult } from '../apps/agent/src/disk-merge-request.mjs';

function wire(sharedText) {
  const room = { destroyed: false, document: { getText: () => ({ toString: () => sharedText }) } };
  const binding = { synced: true, text: { toString: () => sharedText }, diskMergeRequests: new Map() };
  const serverSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send(payload) {
    assert.ok(Buffer.byteLength(payload) <= MAX_MESSAGE_BYTES);
    receiveDiskMergeResult(binding, validateServerMessage(JSON.parse(payload)));
  } };
  binding.socket = { readyState: WebSocket.OPEN, send(payload, callback) {
    assert.ok(Buffer.byteLength(payload) <= MAX_MESSAGE_BYTES);
    DocumentRoom.prototype.applyJson.call(room, serverSocket, JSON.parse(payload));
    callback?.();
  } };
  return binding;
}

test('merge patches round-trip Unicode, empty text, unchanged text and compressed insertion', () => {
  for (const [previous, next] of [['Привет 🦄', 'Привет 🐴'], ['Привет', ''], ['', 'Привет'],
    ['одинаково', 'одинаково'], ['x', 'x\uFEFFтекст'], ['', 'Привет 🦄\n'.repeat(10000)]]) {
    assert.equal(decodeMergeText(previous, encodeMergeText(previous, next)), next);
  }
  assert.equal(encodeMergeText('', 'А'.repeat(10000)).encoding, 'gzip');
});

test('patch decoder rejects invalid UTF-8, base64, byte boundaries and gzip bombs', () => {
  const patch = { positionByte: 0, deleteBytes: 0, insertBase64: '', encoding: 'utf8' };
  assert.throws(() => decodeMergeText('Я', { ...patch, positionByte: 1 }), /splits/);
  assert.throws(() => decodeMergeText('', { ...patch, insertBase64: '/w==' }), /encoded data/);
  assert.throws(() => decodeMergeText('', { ...patch, insertBase64: 'AA=A' }), /base64/);
  assert.throws(() => decodeMergeText('', { ...patch, deleteBytes: -1 }), /fields/);
  assert.throws(() => decodeMergeText('', { ...patch, encoding: 'gzip',
    insertBase64: gzipSync(Buffer.alloc(MAX_ROOM_STATE_BYTES + 1)).toString('base64') }));
});

test('large non-compressible insertion is decoded without recursive base64 regex', () => {
  const text = crypto.randomBytes(1024 * 1024).toString('hex');
  assert.equal(decodeMergeText('', encodeMergeText('', text)), text);
});

test('5 MiB disk check and successful response round-trip through production wire handlers', async () => {
  const base = 'l_russian:\n large:0 "' + 'а'.repeat(2.5 * 1024 * 1024) + '"\n other:0 "Git"\n';
  const shared = base.replace('"Git"', '"Чужое"');
  const external = base.replace('large:', 'renamed:');
  const binding = wire(shared);
  const result = await requestDiskMergeCheck(binding, base, external, base);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.sharedText, external.replace('"Git"', '"Чужое"'));
  assert.equal(result.personalText, external);
  assert.equal(binding.diskMergeRequests.size, 0);
});

test('server ignores disk choices without the exact confirmed merge revision', async () => {
  const base = 'l_russian:\n key:0 "Git"\n';
  const shared = base.replace('Git', 'Shared');
  const external = base.replace('Git', 'Disk');
  const binding = wire(shared);
  const conflict = await requestDiskMergeCheck(binding, base, external, base);
  assert.equal(conflict.conflicts.length, 1);
  const choice = new Map([['key', 'external']]);
  const stale = await requestDiskMergeCheck(binding, base, external, base, choice, false, 'stale');
  assert.equal(stale.conflicts.length, 1);
  assert.equal(stale.conflicts[0].conflictId, conflict.conflicts[0].conflictId);
  const resolved = await requestDiskMergeCheck(binding, base, external, base, choice, false, conflict.mergeRevision);
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(resolved.sharedText, external);
});

test('initial-state conflict previews stay bounded for a large Cyrillic document', async () => {
  const shared = 'l_russian:\n key:0 "' + 'Я'.repeat(1024 * 1024) + '"\n';
  const external = shared.replace('key:', 'new:');
  const binding = wire(shared);
  const result = await requestDiskMergeCheck(binding, shared, external, shared, new Map(), true);
  assert.equal(result.conflicts[0].key, '__initial_state__');
  assert.ok(Buffer.byteLength(result.conflicts[0].collaborativeLine) < 64 * 1024);
  const resolved = await requestDiskMergeCheck(binding, shared, external, shared,
    new Map([['__initial_state__', 'external']]), true, result.mergeRevision);
  assert.equal(resolved.sharedText, external);
  assert.equal(resolved.personalText, external);
});
