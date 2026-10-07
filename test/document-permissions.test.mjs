import assert from 'node:assert/strict';
import os from 'node:os';
import { test, after } from 'node:test';
import * as Y from 'yjs';
import { canEditDocument, canDecideSuggestions, documentControlAllowed } from '../packages/shared/src/document-permissions.mts';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';
import { TicketService } from '../apps/server/src/ticket-service.mjs';
import { currentDocumentActor } from '../apps/server/src/document-actor.mjs';

after(closeDocumentRoomValidator);
const contributor = { id: 'contributor', displayName: 'Contributor', roles: ['mod-contributor'] };
const russian = 'localisation/russian/test_l_russian.yml';
const english = 'localisation/english/test_l_english.yml';

test('queued document checks use current account roles, not the old socket snapshot', () => {
  const user = { id: 'contributor', roles: ['translator'], enabled: true };
  const store = { required: true, state: { users: [user] } };
  const old = { ...user };
  user.roles = ['mod-contributor'];
  assert.equal(canEditDocument(currentDocumentActor(store, old), russian), false);
  assert.equal(canEditDocument(currentDocumentActor(store, old), english), true);
  user.enabled = false;
  assert.throws(() => currentDocumentActor(store, old), { status: 403 });
});

test('English-only role is additive and validates paths, including replacement files', () => {
  for (const file of [english, `branch:${english}`, `ticket-123:${english}`, 'localisation/replace/english/test.yml']) {
    assert.equal(canEditDocument(contributor, file), true, file);
  }
  for (const file of [russian, `branch:${russian}`, 'localisation/english/../russian/test.yml', 'other/english/test.yml']) {
    assert.equal(canEditDocument(contributor, file), false, file);
  }
  assert.equal(canDecideSuggestions(contributor), false);
  for (const role of ['translator', 'senior translator', 'admin', 'trainee-translator', 'translation-editor']) {
    const combined = { roles: ['mod-contributor', role] };
    assert.equal(canEditDocument(combined, russian), true);
    assert.equal(canDecideSuggestions(combined), true);
  }
});

test('Russian discussions and reading remain available but every mutation control is rejected', () => {
  for (const type of ['presence', 'comment-create', 'comment-reply', 'suggestion-reply', 'history-get', 'personal-projection-get', 'disk-merge-check', 'sync-flush']) {
    assert.equal(documentControlAllowed(contributor, russian, type), true, type);
  }
  for (const type of ['history-restore', 'git-conflict-resolve', 'personal-projection-set', 'personal-projection-resolve', 'suggestion-create', 'suggestion-update', 'reservation-create', 'suggestion-accept', 'suggestion-reject', 'suggestion-revert']) {
    assert.equal(documentControlAllowed(contributor, russian, type), false, type);
  }
  assert.equal(documentControlAllowed(contributor, english, 'suggestion-create'), true);
  assert.equal(documentControlAllowed(contributor, english, 'suggestion-accept'), false);
});

test('server rejects forged Russian CRDT edits and restoration before changing state', async () => {
  const room = new DocumentRoom(os.tmpdir(), `branch:${russian}`, 'permissions-test', { required: false }, {
    persistedBytesFor: () => 0, assertStateBudget() {},
  });
  const socket = { readyState: 1, identity: contributor, send() {}, bufferedAmount: 0 };
  const document = new Y.Doc();
  try {
    document.getText('content').insert(0, 'forged');
    await assert.rejects(room.applyBinary(socket, Y.encodeStateAsUpdate(document)), /English localisation/u);
    assert.equal(room.currentText(), '');
    await room.applyBinary(socket, Uint8Array.of(0, 0));
  for (const type of ['history-restore', 'suggestion-accept', 'git-conflict-resolve', 'reservation-update']) {
      assert.throws(() => room.applyJson(socket, { type, id: 'fake' }), /English localisation|translation role/u);
    }
    assert.equal(room.currentText(), '');
  } finally { document.destroy(); room.destroy(); }
});

test('contributors can create tickets but cannot manage others, approve or apply them', async () => {
  const store = new TicketStore(os.tmpdir(), async () => {});
  const input = { title: 'Example', baseBranch: 'branch', baseCommit: 'a'.repeat(40), files: [english] };
  const own = await store.create(contributor, input);
  const other = await store.create({ id: 'translator', roles: ['translator'] }, input);
  await store.update(contributor, own.id, { status: 'review' });
  await assert.rejects(store.update(contributor, own.id, { status: 'ready' }), { status: 403 });
  await assert.rejects(store.update(contributor, other.id, { title: 'Hijacked' }), { status: 403 });
  const service = new TicketService(store, { deleteDocuments() { throw new Error('Must not delete'); } });
  await assert.rejects(service.apply(contributor, own.id, {}), { status: 403 });
  await assert.rejects(service.delete(contributor, other.id), { status: 403 });
  const ru = await store.create(contributor, { ...input, files: [russian] });
  await assert.rejects(service.rebase(contributor, ru.id, {}), { status: 403 });
});

test('English CRDT is allowed and an in-flight Russian write rechecks changed roles', async () => {
  const registry = { persistedBytesFor: () => 0, assertStateBudget() {} };
  const document = new Y.Doc(); document.getText('content').insert(0, 'English content');
  const room = new DocumentRoom(os.tmpdir(), `branch:${english}`, 'permissions-en', { required: false }, registry);
  const russianRoom = new DocumentRoom(os.tmpdir(), `branch:${russian}`, 'permissions-ru', { required: false }, registry);
  try {
    const socket = { readyState: 1, identity: contributor, send() {}, bufferedAmount: 0 };
    await room.applyBinary(socket, Y.encodeStateAsUpdate(document));
    assert.equal(room.currentText(), 'English content');
    let rechecks = 0;
    const changingSocket = { ...socket, identity: { id: 'changing', roles: ['translator'] } };
    await assert.rejects(russianRoom.applyBinary(changingSocket, Y.encodeStateAsUpdate(document), () => {
      if (++rechecks === 2) changingSocket.identity = contributor;
    }), /English localisation/u);
    assert.equal(russianRoom.currentText(), '');
  } finally { document.destroy(); room.destroy(); russianRoom.destroy(); }
});

for (const scenario of ['apply', 'rebase-russian', 'rebase-other-ticket']) {
  test(`queued ticket ${scenario} rechecks current roles before replacing documents`, async () => {
    const user = { id: contributor.id, roles: ['translator'], enabled: true };
    const actor = { ...user };
    const file = scenario === 'rebase-other-ticket' ? english : russian;
    const store = new TicketStore(os.tmpdir(), async () => {});
    const ticket = await store.create(scenario === 'rebase-other-ticket' ? { id: 'other' } : actor, {
      title: 'Queued', baseBranch: 'branch', baseCommit: 'a'.repeat(40), files: [file],
    });
    let replacements = 0;
    const room = {
      currentText: () => 'original', hasAuthoritativeState: () => true,
      prepareReplacement() { throw new Error('Must reject before preparing a replacement'); },
      replacePrepared() { replacements++; },
    };
    const service = new TicketService(store, {
      authStore: { required: true, state: { users: [user] } },
      async get() { return room; },
      withRoomsLocked(_rooms, operation) { user.roles = ['mod-contributor']; return operation(); },
    });
    const snapshot = await service.snapshot(ticket.id);
    const body = { baseBranch: 'branch', baseCommit: 'b'.repeat(40), results: [{
      ...snapshot.files[0], textBase64: Buffer.from('changed').toString('base64'),
    }] };
    await assert.rejects(scenario === 'apply'
      ? service.apply(actor, ticket.id, body)
      : service.rebase(actor, ticket.id, body), { status: 403 });
    assert.equal(replacements, 0);
    assert.equal(store.get(ticket.id).baseCommit, 'a'.repeat(40));
  });
}
