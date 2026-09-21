import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  requestPersonalDocument, resetPersonalRequest, handlePersonalDocument,
  schedulePersonalDocumentRefresh, emitDocumentVariants,
  localFileText, replacePersonalDocument, setPersonalSelection,
} from '../apps/agent/src/personal-document.mjs';
import { variantTexts } from '../apps/review/src/document-variants.js';

function bindingFixture() {
  const sent = [];
  return {
    sent, synced: true, ticketId: '', personalReady: true, personalText: 'previous personal',
    personalRequestId: '', variantRequests: new Map(), clients: new Set(),
    text: { toString: () => 'somebody else’s shared text' },
    hub: { options: { user: 'Alice', color: '#fff' }, readGitHeadText: () => 'Git' },
    socket: { readyState: WebSocket.OPEN, send(value) { sent.push(JSON.parse(value)); } },
    initialiseAttachedClients() {},
  };
}

test('reconnect cancels a lost projection request and ignores its late response', () => {
  const binding = bindingFixture();
  requestPersonalDocument(binding);
  const oldId = binding.personalRequestId;
  assert.equal(localFileText(binding), 'previous personal', 'refresh keeps the last known projection visible');
  resetPersonalRequest(binding);
  requestPersonalDocument(binding);
  const newId = binding.personalRequestId;
  assert.notEqual(newId, oldId);
  handlePersonalDocument(binding, { requestId: oldId, textBase64: Buffer.from('stale').toString('base64') });
  assert.equal(binding.personalRequestId, newId);
  assert.equal(localFileText(binding), null);
  handlePersonalDocument(binding, { requestId: newId, textBase64: '' });
  assert.equal(binding.personalText, '');
  assert.equal(localFileText(binding), '', 'a valid empty projection never falls back to the shared document');
  resetPersonalRequest(binding);
});

test('a projection timeout retries with a new ID and stops when the binding closes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const binding = bindingFixture();
  requestPersonalDocument(binding);
  const oldId = binding.personalRequestId;
  t.mock.timers.tick(10_000);
  assert.equal(binding.sent.length, 2);
  assert.notEqual(binding.personalRequestId, oldId);
  binding.closing = true;
  resetPersonalRequest(binding);
  t.mock.timers.tick(30_000);
  assert.equal(binding.sent.length, 2);
});

test('an invalidated refresh keeps the last known projection usable', () => {
  const binding = bindingFixture();
  requestPersonalDocument(binding);
  const first = binding.personalRequestId;
  requestPersonalDocument(binding);
  handlePersonalDocument(binding, { requestId: first, textBase64: Buffer.from('outdated').toString('base64') });
  assert.equal(binding.sent.length, 2);
  assert.equal(binding.personalText, 'previous personal');
  assert.equal(localFileText(binding), 'previous personal');
  assert.equal(binding.personalReady, true);
  resetPersonalRequest(binding);
});

test('settled personal projections coalesce rapid edits while the initial projection starts immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const binding = bindingFixture();
  for (let index = 0; index < 20; index += 1) schedulePersonalDocumentRefresh(binding);
  assert.equal(binding.sent.length, 0);
  t.mock.timers.tick(249);
  assert.equal(binding.sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(binding.sent.length, 1);
  resetPersonalRequest(binding);
  binding.personalReady = false;
  schedulePersonalDocumentRefresh(binding);
  assert.equal(binding.sent.length, 2);
  resetPersonalRequest(binding);
});

test('continuous typing cannot postpone a settled personal projection forever', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const binding = bindingFixture();
  for (let index = 0; index < 20; index += 1) {
    schedulePersonalDocumentRefresh(binding);
    t.mock.timers.tick(100);
  }
  assert.equal(binding.sent.length, 1);
  resetPersonalRequest(binding);
});

test('unchanged Git and shared variants are sent once and later personal edits remain reconstructible', () => {
  const binding = bindingFixture();
  binding.relativePath = 'localisation/russian/file.yml';
  binding.hub.gitCommit = 'commit-one';
  const git = 'l_russian:\n a:0 "Гит"\n';
  let gitReads = 0;
  binding.hub.readGitHeadText = () => { gitReads += 1; return git; };
  binding.text = { toString: () => git };
  binding.personalText = git;
  const messages = [];
  const path = 'C:\\repo\\localisation\\russian\\file.yml';
  const state = { binding, initialised: true };
  binding.clients.add({ kind: 'review', documents: new Map([[path, state]]), send: (message) => messages.push(message) });
  emitDocumentVariants(binding);
  const first = messages.at(-1);
  assert.ok(first.sharedBase64);
  assert.ok(first.gitBase64);
  assert.ok(first.mineBase64);
  binding.personalText = git.replace('Гит', 'Мир');
  emitDocumentVariants(binding);
  const second = messages.at(-1);
  assert.equal(gitReads, 1);
  assert.equal(second.gitBase64, undefined);
  assert.equal(second.sharedBase64, undefined);
  assert.ok(second.minePatch);
  assert.deepEqual(variantTexts(variantTexts(null, first), second), {
    shared: git, mine: binding.personalText, git,
  });
  binding.hub.gitCommit = 'commit-two';
  emitDocumentVariants(binding);
  assert.equal(gitReads, 2);
});

test('continuous edits do not indefinitely prevent the initial personal projection', () => {
  const binding = bindingFixture();
  binding.personalReady = false;
  requestPersonalDocument(binding);
  for (let index = 0; index < 20; index += 1) {
    const requestId = binding.personalRequestId;
    requestPersonalDocument(binding);
    handlePersonalDocument(binding, {
      requestId, textBase64: Buffer.from(`projection ${index}`).toString('base64'),
    });
  }
  assert.equal(binding.personalReady, true);
  assert.equal(binding.personalText, 'projection 0', 'the first successful response unblocks initialisation');
  assert.equal(binding.sent.length, 21);
  handlePersonalDocument(binding, {
    requestId: binding.personalRequestId, textBase64: Buffer.from('latest').toString('base64'),
  });
  assert.equal(binding.personalText, 'latest', 'a quiet refresh catches up to the latest projection');
  resetPersonalRequest(binding);
});

test('personal Git conflicts block mine materialisation but allow an explicit Git-only mode', () => {
  const binding = bindingFixture();
  binding.personalGitConflicts = [{ key: 'key' }];
  assert.equal(localFileText(binding), null);
  binding.personalMaterialisationMode = 'git';
  assert.equal(localFileText(binding), 'Git');
});

test('a local rollback replaces and refreshes the personal projection', () => {
  const binding = bindingFixture();
  binding.personalGitConflicts = [{ key: 'key' }];
  assert.equal(replacePersonalDocument(binding, 'Git'), true);
  assert.deepEqual(binding.personalGitConflicts, []);
  assert.equal(binding.sent[0].type, 'personal-projection-set');
  assert.equal(binding.sent[0].text, 'Git');
  assert.equal(binding.sent[1].type, 'personal-projection-get');
  resetPersonalRequest(binding);
});

test('one shared localisation key can be included without changing its neighbours or shared text', () => {
  const git = 'l_russian:\n a:0 "Git A"\n b:0 "Git B"\n';
  const shared = 'l_russian:\n a:0 "Shared A"\n b:0 "Shared B"\n';
  const binding = bindingFixture();
  const scheduled = [], synced = [], savedModes = [];
  binding.gitWritable = true;
  binding.personalMaterialisationMode = 'mine';
  binding.personalText = git;
  binding.text = { toString: () => shared };
  binding.hub.readGitHeadText = () => git;
  binding.hub.savePersonalMode = (_path, mode) => { savedModes.push(mode); return Promise.resolve(); };
  binding.relativePath = 'localisation/russian/file.yml';
  binding.personalSelectionRevision = 'selection-1';
  binding.personalSelectionGit = git;
  binding.personalSelectionShared = shared;
  const client = {
    kind: 'review', closed: false, send() {},
    documents: new Map(),
    scheduleMaterialisation(path) { scheduled.push(path); },
  };
  const absolutePath = 'C:\\repo\\localisation\\russian\\file.yml';
  client.documents.set(absolutePath, { binding, initialised: true });
  binding.clients.add(client);
  binding.syncClientView = (_client, path) => synced.push(path);

  assert.equal(setPersonalSelection(binding, absolutePath, 'key:a', true, 'stale-selection'), false);
  assert.equal(binding.personalText, git);
  assert.equal(setPersonalSelection(binding, absolutePath, 'key:a', true, 'selection-1'), true);
  assert.equal(binding.text.toString(), shared, 'the collaborative document is not changed');
  assert.equal(binding.personalText, 'l_russian:\n a:0 "Shared A"\n b:0 "Git B"\n');
  assert.equal(binding.sent[0].type, 'personal-projection-set');
  assert.equal(binding.sent[0].text, binding.personalText);
  assert.deepEqual(savedModes, ['mine']);
  assert.deepEqual(scheduled, [absolutePath]);
  assert.deepEqual(synced, [absolutePath]);
  resetPersonalRequest(binding);
});
