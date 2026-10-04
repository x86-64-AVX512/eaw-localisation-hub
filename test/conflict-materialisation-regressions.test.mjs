import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { DocumentHistory } from '../apps/server/src/document-history.mjs';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';
import { evaluateDiskMerge } from '../apps/server/src/disk-merge.mjs';
import { checkDiskChange, finishExternalMerge, confirmDiskMaterialisation,
  resolveExternalConflict, emitExternalConflicts, retryPendingDiskMerges } from '../apps/agent/src/disk-reconciliation.mjs';
import { writeTrackedTextFile } from '../packages/shared/src/text.mts';
import { requestDiskMergeCheck, receiveDiskMergeResult } from '../apps/agent/src/disk-merge-request.mjs';
import { setLocalisationSelection, localisationVariantConflicts, localisationSelectionChanges } from '../packages/shared/src/merge.mts';
import { mergeConflictId, mergeStateRevision } from '../packages/shared/src/merge-state.mts';

const actor = { id: 'alice', displayName: 'Alice' };
const single = 'l_russian:\n key:0 "Git"\n other:0 "Unchanged"\n';
const duplicate = 'l_russian:\n repeated:0 "One"\n repeated:0 "Two"\n other:0 "Unchanged"\n';

test('partial BAR deletion -> personal projection -> unchecked keys writes exact Git without changing shared text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-partial-key-'));
  const absolutePath = path.join(root, 'localisation/russian/bar_l_russian.yml');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const git = 'l_russian:\n before:0 "Before"\n\n BAR_friend_white_star_is_helping_tooltip:0 "White Star is here to help her brother."\n BAR_fix_the_climate_tooltip:0 "Effects of Barrad climate will be less severe."\n\n\n after:0 "After"\n sp_bar_magical_reactor:0 "One"\n sp_bar_magical_reactor:0 "Two"\n';
  const shared = git.replace(' BAR_friend_white_star_is_helping_tooltip:0 "White Star is here to help her brother."\n BAR_fix_the_climate_tooltip:0 "Effects of Barrad climate will be less severe."', ' BAR_friend_white_star_is_helping_tooltip:');
  const history = new DocumentHistory(path.join(root, 'history.json'));
  history.ensureBaseline(git);
  history.record(shared, actor);
  try {
    let local = history.personalProjection(actor.id, git);
    assert.equal(local, shared);
    await fs.writeFile(absolutePath, local);
    for (const key of ['BAR_friend_white_star_is_helping_tooltip', 'BAR_fix_the_climate_tooltip']) {
      const previous = local;
      local = setLocalisationSelection(git, shared, local, `key:${key}`, false);
      history.replacePersonalProjection(actor, local, git);
      assert.equal(history.personalProjection(actor.id, git), local, 'server confirmation retains the checkbox choice');
      await writeTrackedTextFile(root, absolutePath, local, { expectedText: previous });
    }
    assert.equal(local, git);
    assert.equal((await fs.readFile(absolutePath, 'utf8')).replace(/^\uFEFF/u, ''), git);
    assert.equal(history.text(history.entries.at(-1).id), shared, 'checkboxes must not change the canonical document');
    assert.ok(localisationSelectionChanges(git, shared, local).entries.every(({ state }) => state === 'excluded'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('deleted group with blank and ASCII suffix keeps its layout through server confirmation and disk writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-deleted-group-'));
  const absolutePath = path.join(root, 'localisation/russian/bar_l_russian.yml');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const block = ' company:0 "Company"\n description:0 "Description"\n\n progress: "Progress"\n pending: "Pending"\n';
  const git = `l_russian:\n before:0 "Before"\n${block}\n\n # ASCII heading\n # #### ###\n\n\n after:0 "After"\n repeated:0 "One"\n repeated:0 "Two"\n`;
  const shared = git.replace(block, '');
  const history = new DocumentHistory(path.join(root, 'history.json'));
  history.ensureBaseline(git); history.record(shared, actor);
  try {
    let local = history.personalProjection(actor.id, git);
    assert.equal(local, shared);
    await fs.writeFile(absolutePath, local);
    for (const include of [false, true, false]) {
      for (const key of ['pending', 'description', 'company', 'progress']) {
        const previous = local;
        local = setLocalisationSelection(git, shared, local, `key:${key}`, include);
        history.replacePersonalProjection(actor, local, git);
        assert.equal(history.personalProjection(actor.id, git), local, 'server confirmation cannot move the restored group');
        await writeTrackedTextFile(root, absolutePath, local, { expectedText: previous });
      }
      assert.equal(local, include ? shared : git);
      assert.equal((await fs.readFile(absolutePath, 'utf8')).replace(/^\uFEFF/u, ''), local);
    }
    assert.equal(history.text(history.entries.at(-1).id), shared);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function rebaseDuplicate() {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(duplicate);
  history.replacePersonalProjection(actor, duplicate.replace('"One"', '"Mine"'), duplicate);
  const next = duplicate.replace(' other:', ' repeated:0 "Three"\n other:');
  history.updateGitBase(next);
  return { history, next };
}

test('A1: accepting collaborative conflict result must permit writing over the checked disk version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-'));
  const absolutePath = path.join(root, 'localisation/russian/audit_l_russian.yml');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const mine = single.replace('"Git"', '"Mine"');
  const external = single.replace('"Git"', '"Disk"');
  await fs.writeFile(absolutePath, external);
  const state = { diskBase: single, pendingExternal: { base: single, external } };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  const binding = { clients: new Set([client]), applyMergedText() {}, replacePersonalDocument() {} };
  state.binding = binding;
  finishExternalMerge(binding, client, absolutePath, state, mine, mine, 'resolved');
  try {
    await assert.doesNotReject(writeTrackedTextFile(root, absolutePath, mine, { expectedText: state.diskBase }));
    assert.equal(await fs.readFile(absolutePath, 'utf8'), mine);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('A2: chosen collaborative version must survive the disk check after that rejected write', async () => {
  const absolutePath = path.join(os.tmpdir(), 'eaw-audit-virtual.yml');
  const mine = single.replace('"Git"', '"Mine"');
  const external = single.replace('"Git"', '"Disk"');
  let shared = mine;
  const state = { diskBase: single, pendingExternal: { base: single, external }, materialisationExpected: null };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  const binding = {
    clients: new Set([client]), synced: true, gitWritable: true, personalText: mine,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => single },
    text: { toString: () => shared }, localFileText() { return this.personalText; },
    async readDiskText() { return external; },
    applyMergedText(value) { shared = value; },
    replacePersonalDocument(value) { this.personalText = value; },
    persistBaseSnapshot() {},
    emitExternalConflicts() {},
    finishExternalMerge(...args) { return finishExternalMerge(this, ...args); },
    async requestDiskMergeCheck(baseText, externalText, personalText, resolutions) {
      return { sharedHash: crypto.createHash('sha256').update(shared).digest('hex'), stale: false,
        ...evaluateDiskMerge({ baseText, externalText, personalText, sharedText: shared,
          resolutions: Object.fromEntries(resolutions) }) };
    },
  };
  state.binding = binding;
  finishExternalMerge(binding, client, absolutePath, state, mine, mine, 'resolved');
  // ReviewClient.materialiseNow clears these after EAW_EXTERNAL_CHANGE.
  state.materialisationExpected = null;
  state.materialisationDeadline = 0;
  await checkDiskChange(binding, client, absolutePath, state);
  assert.equal(shared, mine, 'the old external text must not replace the explicit choice');
});

test('B1: choosing Git for a duplicate-count conflict must actually retain the complete Git side', () => {
  const { history, next } = rebaseDuplicate();
  const conflict = history.personalGitConflicts(actor.id).find(({ key }) => key === '__duplicate_keys__');
  assert.ok(conflict);
  assert.equal(history.resolvePersonalGitConflict(actor.id, conflict.key, 'git', conflict.id), true);
  assert.equal(history.personalProjection(actor.id, next), next);
});

test('B2: unresolved duplicate-count conflict must survive an unrelated subsequent Git update', () => {
  const { history, next } = rebaseDuplicate();
  assert.ok(history.personalGitConflicts(actor.id).some(({ key }) => key === '__duplicate_keys__'));
  history.updateGitBase(next.replace('"Unchanged"', '"New upstream value"'));
  assert.ok(history.personalGitConflicts(actor.id).some(({ key }) => key === '__duplicate_keys__'));
});

test('C: sequential edits through unique -> duplicated -> unique must not create phantom declarations', () => {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(single);
  const first = single.replace('"Git"', '"Mine"');
  history.record(first, actor);
  const second = first.replace(' other:', ' key:0 "Temporary duplicate"\n other:');
  history.record(second, actor);
  const third = first.replace('"Mine"', '"Final"');
  history.record(third, actor);
  assert.equal(history.personalProjection(actor.id, single), third);
});

test('D: a delayed canonical conflict choice must not resolve a newer Git snapshot', () => {
  const shared = single.replace('"Git"', '"Mine"');
  const oldGit = single.replace('"Git"', '"Git version seen by user"');
  const newGit = single.replace('"Git"', '"Unseen newer Git version"');
  const room = {
    destroyed: false, gitConflict: true, gitBase: { text: single },
    pendingGitSnapshot: { text: newGit, blob: 'new-blob', commit: 'new-commit' },
    gitConflictResolutions: {}, document: { getText: () => ({ toString: () => shared }) },
    gitConflicts: [{ key: 'key' }],
    broadcastGitConflict() {}, finishCanonicalSnapshot(snapshot, merged) { this.accepted = { snapshot, merged }; },
  };
  const socket = { readyState: WebSocket.OPEN };
  // A valid choice for the old conflict must not be valid for the newer Git text.
  assert.notEqual(oldGit, newGit);
  DocumentRoom.prototype.applyJson.call(room, socket, {
    type: 'git-conflict-resolve', key: 'key', choice: 'external',
    conflictId: mergeConflictId(mergeStateRevision(single, shared, oldGit), 'key'),
  });
  assert.equal(room.accepted, undefined, 'stale choice must be rejected or re-confirmed');
});

test('E: an external change observed offline must be checked after reconnection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-offline-'));
  const absolutePath = path.join(root, 'audit.yml');
  const external = single.replace('"Git"', '"Disk"');
  await fs.writeFile(absolutePath, external);
  let requested = 0;
  const state = { diskBase: single, pendingExternal: null, materialisationExpected: null, diskSignature: '' };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  const binding = {
    synced: false, gitWritable: true, clients: new Set([client]),
    text: { toString: () => single }, localFileText: () => single,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => single },
    readDiskText: () => fs.readFile(absolutePath, 'utf8'),
    async requestDiskMergeCheck() { requested += 1; return { conflicts: [{ key: 'key' }],
      sharedHash: crypto.createHash('sha256').update(single).digest('hex') }; },
    emitExternalConflicts() {},
  };
  state.binding = binding;
  try {
    await checkDiskChange(binding, client, absolutePath, state);
    binding.synced = true;
    await checkDiskChange(binding, client, absolutePath, state);
    assert.equal(requested, 1, 'unchanged disk signature must not suppress the unprocessed offline change');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('F: a supported 5 MiB document must fit a server disk-merge request', async () => {
  const text = 'l_russian:\n key:0 "' + 'a'.repeat(5 * 1024 * 1024) + '"\n';
  const binding = { synced: true, text: { toString: () => text }, diskMergeRequests: new Map() };
  binding.socket = { readyState: WebSocket.OPEN, send(payload, callback) {
    const request = JSON.parse(payload);
    queueMicrotask(() => receiveDiskMergeResult(binding, {
      type: 'disk-merge-result', requestId: request.requestId, stale: false, conflicts: [],
    }));
    callback?.();
  } };
  await assert.doesNotReject(requestDiskMergeCheck(binding, text, text.replace('key:', 'changed:'), text));
});

test('G: excluding deletion of the last key must remove its empty-line placeholder', () => {
  const base = duplicate + ' tail:0 "Last"\n';
  const shared = base.replace(' tail:0 "Last"', '');
  assert.equal(setLocalisationSelection(base, shared, shared, 'key:tail', false), base);
});

test('H: inserting before the first keyed record must terminate even without a language header', () => {
  const probe = fileURLToPath(new URL('./fixtures/merge-head-insertion.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [probe], { timeout: 1000, maxBuffer: 4096, encoding: 'utf8' });
  assert.equal(result.error?.code, undefined, `merge did not finish: ${result.error?.code}`);
  assert.equal(result.status, 0, result.stderr);
});

test('duplicate-count conflicts and both whole-file choices survive durable history reload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-duplicate-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { history, next } = rebaseDuplicate();
  const oldId = history.personalGitConflicts(actor.id)[0].id;
  const newest = next.replace('"Unchanged"', '"New Git"');
  history.updateGitBase(newest);
  const target = path.join(root, 'history.json');
  await fs.writeFile(target, await history.serialiseAsync());
  for (const choice of ['mine', 'git']) {
    const restored = new DocumentHistory(target);
    await restored.load();
    const conflict = restored.personalGitConflicts(actor.id)[0];
    assert.equal(conflict.id, history.personalGitConflicts(actor.id)[0].id);
    assert.equal(conflict.key, '__duplicate_keys__');
    assert.equal(conflict.mineGzipBase64, undefined, 'internal snapshots must not reach the wire');
    assert.notEqual(conflict.id, oldId);
    assert.equal(restored.resolvePersonalGitConflict(actor.id, conflict.key, choice, oldId), false);
    assert.equal(restored.resolvePersonalGitConflict(actor.id, conflict.key, choice, conflict.id), true);
    assert.deepEqual(restored.personalGitConflicts(actor.id), []);
    assert.equal(restored.personalProjection(actor.id, newest), choice === 'git'
      ? newest : duplicate.replace('"One"', '"Mine"'));
  }
});

test('an asynchronous save retains the duplicate conflict snapshot it started with', async () => {
  const { history, next } = rebaseDuplicate();
  const before = history.personalGitConflicts(actor.id)[0].id;
  const saving = history.serialiseAsync();
  history.record(duplicate.replace('"One"', '"New mine"'), actor);
  const saved = JSON.parse(await saving);
  const stored = saved.rebaseConflicts.find(({ authorId }) => authorId === actor.id).conflicts[0];
  assert.equal(crypto.createHash('sha256').update(JSON.stringify([next, stored])).digest('hex'), before);
  assert.notEqual(history.personalGitConflicts(actor.id)[0].id, before);
});

test('adding a duplicate never attributes an unchanged occurrence from another author', () => {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(single);
  const shared = single.replace('"Git"', '"Alice"');
  history.record(shared, actor);
  history.record(shared.replace(' other:', ' key:0 "Bob"\n other:'), { id: 'bob', displayName: 'Bob' });
  assert.equal(history.personalProjection('bob', single), single.replace(' other:', ' key:0 "Bob"\n other:'));
  assert.equal(history.personalProjection(actor.id, single), shared);
});

test('a shared key that became unique still uses its Git occurrence ID for personal conflicts', () => {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(duplicate);
  const unique = duplicate.replace(' repeated:0 "Two"\n', '');
  history.record(unique, actor);
  history.record(unique.replace('"One"', '"Bob"'), { id: 'bob', displayName: 'Bob' });
  assert.equal(history.authorVariants.get('bob').has('repeated'), false);
  assert.equal(history.authorVariants.get('bob').get('occ:1:repeated'), ' repeated:0 "Bob"');
  const legacy = new Map([['alice', new Map([['repeated', ' repeated:0 "Alice"']])],
    ['bob', history.authorVariants.get('bob')]]);
  assert.deepEqual(localisationVariantConflicts(duplicate, legacy).map(({ key }) => key), ['occ:1:repeated']);
});

test('legacy mixed bare/occurrence IDs reload without a phantom third declaration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-mixed-ids-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'history.json');
  const history = new DocumentHistory(target);
  history.ensureBaseline(duplicate);
  history.authorVariants.set(actor.id, new Map([['repeated', ' repeated:0 "Obsolete"'],
    ['occ:1:repeated', ' repeated:0 "Mine"']]));
  await fs.writeFile(target, history.serialise());
  const restored = new DocumentHistory(target);
  await restored.load();
  assert.equal(restored.personalProjection(actor.id, duplicate), duplicate.replace('"One"', '"Mine"'));
  assert.equal(restored.authorVariants.get(actor.id).has('repeated'), false);
});

test('restoring the first key removes only its placeholder and preserves real blank lines', () => {
  for (const base of [' first:0 "First"\n other:0 "Other"\n',
    '\n first:0 "First"\n other:0 "Other"\n',
    '# Comment\n first:0 "First"\n\n other:0 "Other"\n']) {
    const deleted = base.replace(' first:0 "First"', '');
    assert.equal(setLocalisationSelection(base, deleted, deleted, 'key:first', false), base);
  }
});

test('old partial canonical choices cannot be carried into a newer shared revision', () => {
  const base = 'l_russian:\n first:0 "Git"\n second:0 "Git"\n';
  const shared = base.replaceAll('Git', 'Mine');
  const upstream = base.replaceAll('Git', 'New');
  const revision = mergeStateRevision(base, shared, upstream);
  const room = { destroyed: false, gitConflict: true, gitBase: { text: base },
    pendingGitSnapshot: { text: upstream }, gitConflictRevision: 'older-shared-revision',
    gitConflictResolutions: { first: 'external' }, gitConflicts: [{ key: 'first' }, { key: 'second' }],
    document: { getText: () => ({ toString: () => shared }) },
    broadcastGitConflict(_snapshot, conflicts) { this.remaining = conflicts; },
    finishCanonicalSnapshot() { this.accepted = true; } };
  DocumentRoom.prototype.applyJson.call(room, { readyState: WebSocket.OPEN }, {
    type: 'git-conflict-resolve', key: 'second', choice: 'external',
    conflictId: mergeConflictId(revision, 'second'),
  });
  assert.equal(room.accepted, undefined);
  assert.deepEqual(room.remaining.map(({ key }) => key), ['first']);
});

test('confirmed disk choice writes the checked file, updates both views, and survives the next poll', { timeout: 5000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-resolved-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolutePath = path.join(root, 'localisation/russian/test_l_russian.yml');
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const mine = duplicate.replace('"One"', '"Mine"');
  const external = duplicate.replace('"One"', '"Disk"');
  let shared = mine.replace('"Unchanged"', '"Other author"');
  await fs.writeFile(absolutePath, external);
  const state = { diskBase: duplicate, materialisationExpected: null, diskSignature: '' };
  const secondState = { ...state };
  const sent = [];
  let saveRequested;
  const readyToSave = new Promise((resolve) => { saveRequested = resolve; });
  const client = { documents: new Map([[absolutePath, state]]), send(m) {
    sent.push(m);
    if (m.type === 'saveRequested') saveRequested();
  } };
  const secondClient = { documents: new Map([[absolutePath, secondState]]), send() {} };
  const binding = { clients: new Set([client, secondClient]), synced: true, gitWritable: true,
    personalText: mine, hub: { gitOperationInProgress: () => false, readGitHeadText: () => duplicate },
    text: { toString: () => shared }, localFileText() { return this.personalText; },
    readDiskText: () => fs.readFile(absolutePath, 'utf8'), requireState: () => state,
    applyMergedText(text) { shared = text; }, replacePersonalDocument(text) { this.personalText = text; },
    persistBaseSnapshot() {},
    emitExternalConflicts(...args) { emitExternalConflicts(this, ...args); },
    finishExternalMerge(...args) { finishExternalMerge(this, ...args); },
    async requestDiskMergeCheck(baseText, externalText, personalText, resolutions) {
      return { sharedHash: crypto.createHash('sha256').update(shared).digest('hex'), stale: false,
        ...evaluateDiskMerge({ baseText, externalText, personalText, sharedText: shared,
          resolutions: Object.fromEntries(resolutions) }) };
    } };
  state.binding = secondState.binding = binding;
  await checkDiskChange(binding, client, absolutePath, state);
  const conflict = sent.find(({ type }) => type === 'externalConflict');
  assert.equal(conflict.key, 'occ:1:repeated');
  resolveExternalConflict(binding, client, absolutePath, { ...conflict, choice: 'collaborative' });
  await readyToSave;
  assert.equal(state.pendingExternal, null);
  assert.equal(state.diskBase, external, 'checked disk remains the write precondition');
  await writeTrackedTextFile(root, absolutePath, mine, { expectedText: state.diskBase });
  confirmDiskMaterialisation(binding, absolutePath, state, mine);
  await checkDiskChange(binding, client, absolutePath, state);
  assert.equal(await fs.readFile(absolutePath, 'utf8'), mine);
  assert.equal(secondState.diskBase, mine);
  assert.equal(shared, mine.replace('"Unchanged"', '"Other author"'));
  assert.equal(state.pendingExternal, null);
});

test('a disk edit during the server check invalidates the result before document mutation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-disk-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolutePath = path.join(root, 'test.yml');
  const external = single.replace('"Git"', '"Disk"');
  const newer = single.replace('"Git"', '"New disk"');
  await fs.writeFile(absolutePath, external);
  const state = { diskBase: single, diskSignature: '', materialisationExpected: null };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  let answer;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  const binding = { synced: true, gitWritable: true, clients: new Set([client]),
    text: { toString: () => single }, localFileText: () => single,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => single },
    readDiskText: () => fs.readFile(absolutePath, 'utf8'), emitExternalConflicts() {},
    finishExternalMerge() { this.accepted = true; },
    requestDiskMergeCheck() { started(); return new Promise((resolve) => { answer = resolve; }); } };
  state.binding = binding;
  const checking = checkDiskChange(binding, client, absolutePath, state);
  await requested;
  await fs.writeFile(absolutePath, newer);
  answer({ stale: false, sharedHash: crypto.createHash('sha256').update(single).digest('hex'),
    ...evaluateDiskMerge({ baseText: single, sharedText: single, personalText: single, externalText: external }) });
  await checking;
  clearTimeout(state.pendingExternal.retryTimer);
  assert.equal(binding.accepted, undefined);
  assert.equal(state.pendingExternal.external, newer);
  assert.equal(state.pendingExternal.conflicts, null);
  assert.equal(state.diskBase, single);
});

test('a size-limit failure does not create a timer or repeat on unchanged Git status', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-merge-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolutePath = path.join(root, 'test.yml');
  const external = single.replace('Git', 'Disk');
  await fs.writeFile(absolutePath, external);
  let requests = 0;
  const state = { diskBase: single, diskSignature: '', materialisationExpected: null };
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  const binding = { synced: true, gitWritable: true, clients: new Set([client]),
    text: { toString: () => single }, localFileText: () => single,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => single },
    readDiskText: () => fs.readFile(absolutePath, 'utf8'),
    requestDiskMergeCheck() { requests += 1; return Promise.reject(Object.assign(new Error('too large'),
      { code: 'EAW_MERGE_LIMIT' })); } };
  state.binding = binding;
  await checkDiskChange(binding, client, absolutePath, state);
  assert.equal(state.pendingExternal.retryTimer, undefined);
  retryPendingDiskMerges(binding);
  retryPendingDiskMerges(binding);
  assert.equal(requests, 1);
  assert.equal(state.diskBase, single);
});
