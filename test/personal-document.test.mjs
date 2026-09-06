import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { requestPersonalDocument, resetPersonalRequest, handlePersonalDocument, localFileText } from '../apps/agent/src/personal-document.mjs';

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
  assert.equal(localFileText(binding), null);
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

test('an invalidated in-flight projection is not published or materialised', () => {
  const binding = bindingFixture();
  requestPersonalDocument(binding);
  const first = binding.personalRequestId;
  requestPersonalDocument(binding);
  handlePersonalDocument(binding, { requestId: first, textBase64: Buffer.from('outdated').toString('base64') });
  assert.equal(binding.sent.length, 2);
  assert.equal(binding.personalText, 'previous personal');
  assert.equal(localFileText(binding), null);
  resetPersonalRequest(binding);
});

test('personal Git conflicts block mine materialisation but allow an explicit Git-only mode', () => {
  const binding = bindingFixture();
  binding.personalGitConflicts = [{ key: 'key' }];
  assert.equal(localFileText(binding), null);
  binding.personalMaterialisationMode = 'git';
  assert.equal(localFileText(binding), 'Git');
});
