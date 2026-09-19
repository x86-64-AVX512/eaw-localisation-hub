import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  requestPersonalDocument, resetPersonalRequest, handlePersonalDocument,
  localFileText, replacePersonalDocument, setPersonalSelection,
} from '../apps/agent/src/personal-document.mjs';

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
