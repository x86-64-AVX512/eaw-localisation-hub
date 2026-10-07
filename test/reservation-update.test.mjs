import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { updateReservation } from '../apps/server/src/reservation-update.mjs';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { minimalReservation } from '../apps/server/src/room-metadata.mjs';
import { updateReservation as agentUpdate } from '../apps/agent/src/document-actions.mjs';
import { DocumentBinding } from '../apps/agent/src/document-binding.mjs';
import { resolveReviewAnchors } from '../apps/agent/src/review-document.mjs';
import { createReviewDocument } from '../apps/review/src/review-document.ts';
import { validateClientMessage, validateServerMessage } from '../packages/shared/src/protocol-schema.mts';
import { attachDocumentSocket } from '../apps/server/src/document-socket.mts';
import { ProtocolLimitError, createInboundBudget } from '../apps/server/src/protocol-limits.mts';

after(closeDocumentRoomValidator);
const source = 'l_russian:\n first:0 "Первый"\n duplicate:0 "Один"\n duplicate:0 "Два"\n last:0 "Последний"\n';
const encode = (position) => Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
function range(text, start, end) {
  return { startRelative: encode(Y.createRelativePositionFromTypeIndex(text, start, -1)),
    endRelative: encode(Y.createRelativePositionFromTypeIndex(text, end, 0)) };
}
function harness() {
  const document = new Y.Doc(); const text = document.getText('content'); text.insert(0, source);
  const broadcasts = [], replies = [];
  const room = Object.assign(Object.create(DocumentRoom.prototype), {
    document, documentId: 'branch:localisation/russian/file.yml', messageQueue: Promise.resolve(),
    registry: { isUnavailableBranch: () => false },
    authStore: { required: true, findDirectoryUser: (_actor, id) => id === 'bob'
      ? { id, displayName: 'Bob', color: '#abcdef' } : null },
    reservations: [{ id: 'stable', revision: 1, createdById: 'alice', createdBy: 'Alice',
      assigneeId: 'alice', assignee: 'Alice', color: '#112233', comment: 'Original',
      ...range(text, source.indexOf(' first'), source.indexOf(' duplicate')), initialKeys: ['first'] }],
    assertMetadataBudget() {}, writes: 0, schedulePersist() { this.writes++; },
    broadcastReservations() { broadcasts.push(structuredClone(this.reservations)); },
  });
  const socket = { readyState: 1, bufferedAmount: 0, identity: { id: 'bob', roles: ['translator'] },
    send: (json) => replies.push(validateServerMessage(JSON.parse(json))) };
  return { room, text, socket, broadcasts, replies };
}
const command = (fields = {}) => ({ type: 'reservation-update', id: 'stable', requestId: 'request', expectedRevision: 1, ...fields });

test('server updates metadata in place, canonicalises assignee and preserves identity, author and anchors', () => {
  const { room, socket, broadcasts } = harness(); const previous = structuredClone(room.reservations[0]);
  assert.deepEqual(updateReservation(room, socket, command({ assigneeId: 'bob', assignee: 'Forged',
    assigneeColor: '#000000', comment: '', createdBy: 'Forged', id: 'stable' })), { status: 'saved', revision: 2 });
  const updated = room.reservations[0];
  assert.equal(updated.id, previous.id); assert.equal(updated.createdBy, 'Alice'); assert.equal(updated.createdById, 'alice');
  assert.equal(updated.assignee, 'Bob'); assert.equal(updated.color, '#abcdef'); assert.equal(updated.comment, '');
  assert.equal(updated.startRelative, previous.startRelative); assert.equal(updated.endRelative, previous.endRelative);
  assert.deepEqual(updated.initialKeys, ['first']); assert.equal(room.reservations.length, 1);
  assert.equal(room.writes, 1); assert.equal(broadcasts.length, 1);
  assert.equal(minimalReservation(updated).revision, 2);
});

test('server changes range using canonical keys including duplicate occurrences, and clears orphaned status', () => {
  const { room, text, socket } = harness(); room.reservations[0].orphaned = true;
  updateReservation(room, socket, command({ ...range(text, source.indexOf(' duplicate'), source.indexOf(' last')),
    initialKeys: ['forged'] }));
  assert.deepEqual(room.reservations[0].initialKeys, ['duplicate', 'duplicate']);
  assert.equal(room.reservations[0].orphaned, undefined);
});

test('orphaned reservation can change note without losing recovery keys or inventing a range', () => {
  const { room, socket } = harness(); room.reservations[0].orphaned = true;
  updateReservation(room, socket, command({ comment: 'Still needed' }));
  assert.equal(room.reservations[0].orphaned, true); assert.deepEqual(room.reservations[0].initialKeys, ['first']);
});

test('legacy reservations start at revision zero and stale/deleted updates never recreate them', () => {
  const { room, socket } = harness(); delete room.reservations[0].revision;
  room.reservations[0] = minimalReservation(room.reservations[0]);
  assert.equal(room.reservations[0].revision, 0);
  assert.equal(updateReservation(room, socket, command({ expectedRevision: 0, comment: 'Migrated' })).revision, 1);
  assert.equal(updateReservation(room, socket, command({ expectedRevision: 0, comment: 'Stale' })).status, 'stale');
  assert.equal(room.reservations[0].comment, 'Migrated'); assert.equal(room.writes, 1);
  room.reservations = [];
  assert.equal(updateReservation(room, socket, command()).status, 'deleted'); assert.deepEqual(room.reservations, []);
});

test('invalid ranges, unavailable assignees, byte limits and metadata budget failures are atomic', () => {
  const { room, text, socket } = harness(); const previous = structuredClone(room.reservations);
  const other = new Y.Doc(); other.getText('content').insert(0, 'foreign');
  for (const fields of [
    { startRelative: 'bad', endRelative: 'bad' }, { startRelative: room.reservations[0].startRelative },
    range(other.getText('content'), 0, 5), range(text, 0, 2), range(text, 1, 1),
    { assigneeId: 'missing' }, { comment: 'Ж'.repeat(513) }, { comment: 'bad\ncontrol' }, { expectedRevision: -1 },
  ]) {
    assert.throws(() => updateReservation(room, socket, command(fields)));
    assert.deepEqual(room.reservations, previous);
  }
  room.assertMetadataBudget = () => { throw new Error('budget'); };
  assert.throws(() => updateReservation(room, socket, command({ comment: 'New' })), /budget/);
  assert.deepEqual(room.reservations, previous); assert.equal(room.writes, 0); other.destroy();
});

test('queued updates return correlated results: only one concurrent edit wins and permission failure confirms rejection', async () => {
  const { room, socket, replies } = harness();
  await Promise.all([
    room.receiveJson(socket, command({ requestId: 'one', comment: 'Winner' })),
    room.receiveJson(socket, command({ requestId: 'two', comment: 'Loser' })),
  ]);
  assert.deepEqual(replies.map(({ requestId, status }) => [requestId, status]), [['one', 'saved'], ['two', 'stale']]);
  assert.equal(room.reservations[0].comment, 'Winner'); assert.equal(room.writes, 1);
  socket.identity.roles = ['mod-contributor'];
  await room.receiveJson(socket, command({ requestId: 'denied', expectedRevision: 2, comment: 'Denied' }));
  assert.equal(replies.at(-1).status, 'error'); assert.equal(room.reservations[0].comment, 'Winner');
});

test('update audit records the actual editor and original owner without changing the creator', async () => {
  const { room, socket } = harness(); const audit = [];
  room.commentThreads = []; room.suggestions = []; room.actorFor = (peer) => peer.identity;
  room.registry.auditLog = { async run(actor, action, documentId, details, operation) {
    audit.push({ actor, action, documentId, details }); return operation();
  } };
  await room.receiveJson(socket, command({ comment: 'Edited', createdById: 'bob', createdBy: 'Bob' }));
  assert.equal(audit[0].actor.id, 'bob'); assert.equal(audit[0].action, 'reservation-update');
  assert.equal(audit[0].details.ownerId, 'alice'); assert.equal(room.reservations[0].createdById, 'alice');
});

test('completion audit failure confirms an applied save and protocol limits still reach the socket handler', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { room, socket, replies } = harness();
  room.commentThreads = []; room.suggestions = []; room.actorFor = (peer) => peer.identity;
  room.registry.auditLog = { async run(_actor, _action, _documentId, _details, operation) {
    await operation(); throw new Error('audit storage unavailable');
  } };
  await room.receiveJson(socket, command({ comment: 'Saved' }));
  assert.equal(replies.at(-1).status, 'saved'); assert.equal(replies.at(-1).revision, 2);
  assert.equal(room.reservations[0].comment, 'Saved');
  room.registry.auditLog = { async run() { throw new ProtocolLimitError('limit', 1009); } };
  await assert.rejects(room.receiveJson(socket, command({ expectedRevision: 2, comment: 'Limited' })), ProtocolLimitError);
  assert.equal(room.reservations[0].comment, 'Saved');
});

test('transport rejects read-only Git/ticket updates with correlated errors before invoking the room', async () => {
  for (const blockedBy of ['git', 'ticket']) {
    const replies = []; let invoked = false;
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, inboundBudget: createInboundBudget(),
      send: (value) => replies.push(validateServerMessage(JSON.parse(value))), close() {} });
    attachDocumentSocket({ socket, documentId: 'branch:localisation/russian/file.yml',
      room: { clientWritable: () => blockedBy !== 'git', receiveJson: () => { invoked = true; } },
      ticketStore: { documentWritable: () => blockedBy !== 'ticket' }, isShuttingDown: () => false });
    socket.emit('message', Buffer.from(JSON.stringify(command())), false); await socket.messageQueue;
    assert.equal(invoked, false); assert.equal(replies[0].type, 'reservation-update-result');
    assert.equal(replies[0].requestId, 'request'); assert.equal(replies[0].status, 'error');
  }
});

test('client schema bounds update fields and preserves compatibility with old server envelopes', () => {
  const update = { type: 'reservationUpdate', path: 'C:/repo/file.yml', id: 'stable', requestId: 'one',
    expectedRevision: 0, comment: 'Edited' };
  assert.equal(validateClientMessage(update), update);
  assert.doesNotThrow(() => validateClientMessage({ ...update, startByte: 0, endByte: 20, reviewAnchors: '{}' }));
  for (const expectedRevision of [-1, 0.5, '1']) assert.throws(() => validateClientMessage({ ...update, expectedRevision }));
  assert.throws(() => validateServerMessage({ type: 'reservation-update-result', id: 'stable', requestId: 'one', status: 'saved' }));
  assert.throws(() => validateServerMessage({ type: 'reservation-update-result', id: 'stable', requestId: 'one', status: 'oops' }));
});

test('Agent sends only an update, preserves absent range, and returns unsupported/offline/deleted/stale errors', () => {
  const { room, text } = harness(); const sent = [], replies = [];
  const binding = { synced: true, reservationUpdates: true, text, reservations: new Map([['stable', room.reservations[0]]]),
    requireState: () => ({ mirror: source }), socket: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) }, emitReservations() {} };
  const client = { send: (value) => replies.push(value) };
  agentUpdate(binding, client, 'C:/repo/file.yml', command({ comment: 'Changed' }));
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'reservation-update');
  assert.equal(sent[0].startRelative, undefined); assert.equal(sent[0].id, 'stable');
  agentUpdate(binding, client, 'C:/repo/file.yml', command({ startByte: 0 }));
  assert.equal(replies.at(-1).status, 'error');
  binding.synced = false; agentUpdate(binding, client, 'x', command()); assert.equal(replies.at(-1).status, 'error');
  binding.synced = true; binding.reservationUpdates = false;
  agentUpdate(binding, client, 'x', command()); assert.equal(replies.at(-1).status, 'error');
  binding.reservationUpdates = true; agentUpdate(binding, client, 'x', command({ expectedRevision: 0 }));
  assert.equal(replies.at(-1).status, 'stale');
  binding.reservations.clear(); agentUpdate(binding, client, 'x', command()); assert.equal(replies.at(-1).status, 'deleted');
  assert.equal(sent.length, 1);
});

test('Agent forwards server confirmation only to Review peers bound to the same document', () => {
  const sent = [], other = {};
  const binding = Object.create(DocumentBinding.prototype);
  binding.clients = [{ kind: 'review', documents: new Map([['right', { binding }], ['wrong', { binding: other }]]),
    send: (message) => sent.push(message) }];
  binding.receiveServerMessage({ type: 'reservation-update-result', requestId: 'one', id: 'stable', status: 'saved', revision: 2 });
  assert.equal(sent.length, 1); assert.equal(sent[0].path, 'right'); assert.equal(sent[0].type, 'reservationUpdateResult');
});

test('chosen range follows CRDT prefix edits but rejects changes within the chosen text', () => {
  const { room, text } = harness(); const browser = createReviewDocument({ send() {}, onText() {} });
  browser.receive({ documentId: room.documentId, path: 'x', updateBase64: Buffer.from(Y.encodeStateAsUpdate(room.document)).toString('base64') });
  const start = source.indexOf(' duplicate'), end = source.indexOf(' last');
  const selected = browser.anchor({ type: 'reservationUpdate', startByte: Buffer.byteLength(source.slice(0, start)),
    endByte: Buffer.byteLength(source.slice(0, end)) });
  const binding = { documentId: room.documentId, document: room.document, text };
  const client = { kind: 'review', reviewCrdt: true };
  text.insert(0, '# prefix\n');
  const resolved = resolveReviewAnchors(binding, client, selected);
  assert.equal(resolved.startByte, selected.startByte + 9);
  text.insert(start + 9 + 15, 'changed');
  assert.equal(resolveReviewAnchors(binding, client, selected), null); browser.dispose();
});
