import assert from 'node:assert/strict';
import test from 'node:test';
import { applySyncedMessage } from '../apps/agent/src/git-document-state.mjs';

test('Agent exposes a canonical conflict received in the initial room sync', async () => {
  const sent = [];
  const binding = {
    ticketId: 'skip-personal-file-recovery',
    clients: new Set(),
    hub: { updateIdentity() {}, updateDirectory() {} },
    requestPersonalDocument() {},
    localPresences: { replay() {} },
    initialiseAttachedClients() {},
    scheduleRefresh() {},
    emitDocumentStatus() {},
  };
  const client = {
    documents: new Map([['C:\\test.yml', { binding }]]),
    send(message) { sent.push(message); },
  };
  binding.clients.add(client);
  applySyncedMessage(binding, {
    canSeed: false,
    git: {
      status: 'conflict',
      conflicts: [{
        key: 'same_key', label: 'same_key', detail: 'Both sides changed it',
        baseLine: 'same_key: "Base"',
        collaborativeLine: 'same_key: "Shared"',
        externalLine: 'same_key: "Git"',
      }],
    },
    reservations: [], commentThreads: [], suggestions: [], history: [], presences: [], directory: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [
    { type: 'externalConflictReset', path: 'C:\\test.yml', source: 'canonical' },
    {
      type: 'externalConflict', path: 'C:\\test.yml', source: 'canonical',
      key: 'same_key', label: 'same_key', detail: 'Both sides changed it',
      baseLine: 'same_key: "Base"', collaborativeLine: 'same_key: "Shared"', externalLine: 'same_key: "Git"',
    },
  ]);
});
