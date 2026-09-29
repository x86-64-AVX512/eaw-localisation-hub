import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDiskChange, confirmDiskMaterialisation } from '../apps/agent/src/disk-reconciliation.mjs';
import { queueMaterialisation } from '../apps/agent/src/review-server.mjs';
import { setLocalisationSelection, projectLocalisationVariant, captureLocalisationVariant } from '../packages/shared/src/merge.mts';

const git = 'l_russian:\n  BAR_quick_excavation:0 "Quick Excavation"\n  BAR_longterm_excavation:0 "Long-Term Excavation"\n\n  BAR_ambrosius_boredom:0 "Impending something..."\n  sp_bar_magical_reactor:0 "One"\n  sp_bar_magical_reactor:0 "Two"\n';
const deleted = git.replace('  BAR_longterm_excavation:0 "Long-Term Excavation"', '  ');

test('BAR checkbox restores original spacing through repeated server projection round trips', () => {
  let local = deleted;
  for (let index = 0; index < 20; index += 1) {
    local = setLocalisationSelection(git, deleted, local, 'key:BAR_longterm_excavation', false);
    assert.equal(local, git, `checkbox off, iteration ${index}`);
    local = projectLocalisationVariant(git, captureLocalisationVariant(git, local));
    assert.equal(local, git, `server projection, iteration ${index}`);
    local = setLocalisationSelection(git, deleted, local, 'key:BAR_longterm_excavation', true);
    local = projectLocalisationVariant(git, captureLocalisationVariant(git, local));
    assert.equal(local, git.replace('  BAR_longterm_excavation:0 "Long-Term Excavation"\n', ''));
  }
});

test('BAR deletion checkbox treats LF Git, CRLF shared text and a shifted personal line as the same layout', () => {
  const shared = git.replace('  BAR_longterm_excavation:0 "Long-Term Excavation"', '').replaceAll('\n', '\r\n');
  const shifted = git.replace('  BAR_longterm_excavation:0 "Long-Term Excavation"\n\n',
    '\n\n  BAR_longterm_excavation:0 "Long-Term Excavation"\n');
  const restored = setLocalisationSelection(git, shared, shifted, 'key:BAR_longterm_excavation', false);
  assert.equal(restored, git, 'the deletion placeholder is not a genuine new blank line');
  assert.equal(projectLocalisationVariant(git, captureLocalisationVariant(git, restored)), git);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-materialisation-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolutePath = path.join(root, 'test.yml');
  await fs.writeFile(absolutePath, git);
  const state = { diskBase: git, diskSignature: '', materialisationExpected: null };
  const requests = [], retries = [];
  const client = { documents: new Map([[absolutePath, state]]), send() {} };
  const binding = { synced: true, gitWritable: true, clients: new Set([client]),
    text: { toString: () => deleted }, localFileText: () => deleted,
    hub: { gitOperationInProgress: () => false, readGitHeadText: () => git },
    readDiskText: () => fs.readFile(absolutePath, 'utf8'), persistBaseSnapshot() {},
    scheduleDiskCheck(...args) { retries.push(args); }, emitExternalConflicts() {},
    requestDiskMergeCheck(...args) { requests.push(args); return Promise.resolve({ stale: false,
      sharedHash: crypto.createHash('sha256').update(deleted).digest('hex'), conflicts: [{ key: 'unexpected' }] }); } };
  state.binding = binding;
  return { absolutePath, state, client, binding, requests, retries };
}

test('a pre-write disk read cannot roll back the confirmed materialisation base', async (t) => {
  const f = await fixture(t);
  let readStarted, releaseRead;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const release = new Promise((resolve) => { releaseRead = resolve; });
  f.binding.readDiskText = async () => { readStarted(); await release; return git; };
  const checking = checkDiskChange(f.binding, f.client, f.absolutePath, f.state);
  await started;
  await queueMaterialisation(f.binding, async () => {
    await fs.writeFile(f.absolutePath, deleted);
    confirmDiskMaterialisation(f.binding, f.absolutePath, f.state, deleted);
  });
  releaseRead();
  await checking;
  assert.equal(f.state.diskBase, deleted, 'stale reads cannot become a Git rollback');
  assert.equal(f.state.materialisationMismatch, null, 'old reads are discarded, not treated as a write mismatch');
  assert.equal(f.requests.length, 0);
  assert.ok(f.retries.length);
});

test('disk polling waits while any Review window is writing the file', async (t) => {
  const f = await fixture(t);
  let started, finish;
  const began = new Promise((resolve) => { started = resolve; });
  const release = new Promise((resolve) => { finish = resolve; });
  const saving = queueMaterialisation(f.binding, async () => { started(); await release; });
  await began;
  try {
    await checkDiskChange(f.binding, f.client, f.absolutePath, f.state);
    assert.equal(f.requests.length, 0);
    assert.ok(f.retries.length);
  } finally { finish(); await saving; }
});

test('a completed write does not suppress the next genuine external edit', async (t) => {
  const f = await fixture(t);
  await queueMaterialisation(f.binding, async () => {
    await fs.writeFile(f.absolutePath, deleted);
    confirmDiskMaterialisation(f.binding, f.absolutePath, f.state, deleted);
  });
  await checkDiskChange(f.binding, f.client, f.absolutePath, f.state);
  await fs.writeFile(f.absolutePath, deleted.replace('Quick Excavation', 'External edit'));
  await checkDiskChange(f.binding, f.client, f.absolutePath, f.state);
  assert.equal(f.requests.length, 1);
});

test('a failed materialisation releases the watcher guard and the next queued save', async () => {
  const binding = {};
  await assert.rejects(queueMaterialisation(binding, async () => {
    assert.equal(binding.materialisationActive, true);
    throw new Error('write failed');
  }), /write failed/);
  assert.equal(binding.materialisationActive, false);
  const firstEpoch = binding.materialisationEpoch;
  await queueMaterialisation(binding, async () => assert.equal(binding.materialisationActive, true));
  assert.equal(binding.materialisationActive, false);
  assert.ok(binding.materialisationEpoch > firstEpoch);
});
