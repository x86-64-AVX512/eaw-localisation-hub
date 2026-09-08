import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDiskChange, finishExternalMerge, reconcileInitialDisk, resolveExternalConflict,
} from '../apps/agent/src/disk-reconciliation.mjs';

function localClient(path, state) {
  const sent = [];
  return {
    sent,
    documents: new Map([[path, state]]),
    send(message) { sent.push(message); },
  };
}

test('resolved disk conflict is removed from every local view of the file', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const binding = {
    clients: new Set(),
    personalText: '', personalReady: false,
    applyMergedText(text) { this.applied = text; },
  };
  const firstState = { binding, pendingExternal: {}, diskBase: 'old' };
  const secondState = { binding, pendingExternal: {}, diskBase: 'old' };
  const first = localClient(absolutePath, firstState);
  const second = localClient(absolutePath, secondState);
  binding.clients.add(first);
  binding.clients.add(second);

  finishExternalMerge(binding, first, absolutePath, firstState, 'shared', 'personal', 'done');

  for (const state of [firstState, secondState]) {
    assert.equal(state.pendingExternal, null);
    assert.equal(state.diskBase, 'personal');
    assert.equal(state.materialisationExpected, 'personal');
  }
  for (const client of [first, second]) {
    assert.ok(client.sent.some((message) => message.type === 'externalConflictReset'
      && message.source === 'disk'));
  }
  assert.equal(binding.personalText, 'personal');
  assert.equal(binding.applied, 'shared');
});

test('opening a file never materialises another author shared edits', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const previousPersonal = 'l_russian:\n mine:0 "Mine"\n other:0 "Git"\n';
  const shared = previousPersonal.replace('other:0 "Git"', 'other:0 "Dogoo"');
  const state = {
    initialReconciled: false, hasPersistedBase: true,
    diskBase: previousPersonal, mirror: previousPersonal, pendingExternal: null,
  };
  const client = localClient(absolutePath, state);
  const binding = {
    ticketId: '', clients: new Set([client]), personalText: previousPersonal, personalReady: true,
    text: { toString: () => shared },
    localFileText() { return this.personalText; },
    applyMergedText(text) { this.applied = text; },
    persistBaseSnapshot(_state, text) { this.persisted = text; },
    finishExternalMerge(...args) { return finishExternalMerge(this, ...args); },
    emitExternalConflicts() { throw new Error('unexpected conflict'); },
  };
  state.binding = binding;

  reconcileInitialDisk(binding, client, absolutePath, state);

  assert.equal(binding.personalText, previousPersonal);
  assert.equal(binding.applied, shared);
  assert.equal(state.diskBase, previousPersonal);
  assert.equal(binding.persisted, previousPersonal);
  assert.equal(client.sent.some((message) => message.type === 'saveRequested'), false);
});

test('opening a file repairs a previously materialised foreign shared edit', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const personal = 'l_russian:\n mine:0 "Mine"\n other:0 "Git"\n';
  const leaked = personal.replace('other:0 "Git"', 'other:0 "Dogoo"');
  const state = {
    initialReconciled: false, hasPersistedBase: true,
    diskBase: leaked, mirror: leaked, pendingExternal: null,
  };
  const client = localClient(absolutePath, state);
  const binding = {
    ticketId: '', clients: new Set([client]), personalText: personal, personalReady: true,
    text: { toString: () => leaked },
    localFileText() { return this.personalText; },
    applyMergedText(text) { this.applied = text; },
    finishExternalMerge(...args) { return finishExternalMerge(this, ...args); },
    emitExternalConflicts() { throw new Error('unexpected conflict'); },
  };
  state.binding = binding;

  reconcileInitialDisk(binding, client, absolutePath, state);

  assert.equal(binding.personalText, personal);
  assert.doesNotMatch(binding.personalText, /Dogoo/u);
  assert.equal(binding.applied, leaked);
  assert.equal(state.diskBase, personal);
  assert.equal(state.materialisationExpected, personal);
  assert.equal(client.sent.some((message) => message.type === 'saveRequested'), true);
});

test('external disk edits join the shared document without copying foreign edits into the personal file', async () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const previousPersonal = 'l_russian:\n mine:0 "Mine"\n other:0 "Git"\n';
  const external = previousPersonal.replace('mine:0 "Mine"', 'mine:0 "Local"');
  const shared = previousPersonal.replace('other:0 "Git"', 'other:0 "Dogoo"');
  const expectedShared = external.replace('other:0 "Git"', 'other:0 "Dogoo"');
  const state = {
    diskBase: previousPersonal, pendingExternal: null, binding: null,
    materialisationExpected: null, materialisationDeadline: 0, materialisationMismatch: null,
  };
  const client = localClient(absolutePath, state);
  const binding = {
    ticketId: '', paused: false, synced: true, gitWritable: true,
    clients: new Set([client]), personalText: previousPersonal, personalReady: true,
    text: { toString: () => shared },
    hub: { gitOperationInProgress: () => false },
    async readDiskText() { return external; },
    localFileText() { return this.personalText; },
    applyMergedText(text) { this.applied = text; },
    persistBaseSnapshot() {},
    finishExternalMerge(...args) { return finishExternalMerge(this, ...args); },
    emitExternalConflicts() { throw new Error('unexpected conflict'); },
  };
  state.binding = binding;

  await checkDiskChange(binding, client, absolutePath, state);

  assert.equal(binding.applied, expectedShared);
  assert.equal(binding.personalText, external);
  assert.doesNotMatch(binding.personalText, /Dogoo/u);
  assert.equal(state.diskBase, external);
  assert.equal(state.materialisationExpected, external);
});

test('a full Git rollback changes only the personal projection', async () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const git = 'l_russian:\n mine:0 "Git"\n other:0 "Git"\n';
  const personal = git.replace('mine:0 "Git"', 'mine:0 "Mine"');
  const shared = personal.replace('other:0 "Git"', 'other:0 "Dogoo"');
  const state = {
    diskBase: personal, pendingExternal: null, binding: null,
    materialisationExpected: null, materialisationDeadline: 0, materialisationMismatch: null,
  };
  const client = localClient(absolutePath, state);
  const binding = {
    relativePath: 'localisation/russian/test.yml', ticketId: '', paused: false,
    synced: true, gitWritable: true, clients: new Set([client]), personalText: personal,
    text: { toString: () => shared },
    hub: {
      gitOperationInProgress: () => false,
      readGitHeadText: () => git,
    },
    async readDiskText() { return git; },
    localFileText() { return this.personalText; },
    replacePersonalDocument(text) { this.personalText = text; this.replaced = text; },
    applyMergedText(text) { this.applied = text; },
    persistBaseSnapshot(_state, text) { this.persisted = text; },
  };
  state.binding = binding;

  await checkDiskChange(binding, client, absolutePath, state);

  assert.equal(binding.replaced, git);
  assert.equal(binding.applied, undefined, 'shared document must remain untouched');
  assert.equal(binding.text.toString(), shared);
  assert.equal(state.diskBase, git);
  assert.match(client.sent.find(({ type }) => type === 'notice').message, /только к вашему локальному файлу/u);
});

test('disk conflict resolver ignores explicitly canonical conflicts', () => {
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const state = { pendingExternal: {}, binding: null };
  const client = localClient(absolutePath, state);
  const binding = {
    requireState: () => state,
  };
  state.binding = binding;
  assert.equal(resolveExternalConflict(binding, client, absolutePath, {
    source: 'canonical', key: 'key', choice: 'external',
  }), false);
});
