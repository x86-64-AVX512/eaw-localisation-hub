import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { runGitSync } from '../apps/agent/src/git-executable.mts';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';
import { RepositorySync, repositorySnapshot, repositorySyncSettings,
  repositoryReviewReason, repositoryWorktreeReason } from '../apps/agent/src/repository-sync.mjs';

function git(repo, ...args) {
  const result = runGitSync(args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t, settings = { autoPull: true }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eaw-repository-sync-'));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  const remote = path.join(root, 'remote.git'), publisher = path.join(root, 'publisher'), repo = path.join(root, 'client');
  fs.mkdirSync(publisher);
  git(root, 'init', '--bare', remote);
  git(publisher, 'init', '-b', 'barrad');
  git(publisher, 'config', 'user.email', 'test@example.invalid'); git(publisher, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(publisher, 'file.txt'), 'original\n');
  fs.mkdirSync(path.join(publisher, 'localisation', 'russian'), { recursive: true });
  fs.writeFileSync(path.join(publisher, 'localisation', 'russian', 'test_l_russian.yml'), 'original\n');
  git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'initial');
  git(publisher, 'remote', 'add', 'fork', remote); git(publisher, 'push', '-u', 'fork', 'barrad');
  git(root, 'clone', '-b', 'barrad', '-o', 'fork', remote, repo);
  git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  const hub = { options: { state: path.join(root, 'state'), repo, workspace: 'barrad', server: 'ws://localhost:10443' },
    documents: new Map(), clients: new Set(), repositoryUpdating: false, repositoryEditEpoch: 0,
    pendingDocumentUpdatePath: AgentHub.prototype.pendingDocumentUpdatePath };
  const service = new RepositorySync(hub);
  t.after(() => service.close());
  fs.mkdirSync(service.directory, { recursive: true });
  fs.writeFileSync(path.join(service.directory, 'settings.json'), JSON.stringify(settings));
  const head = git(repo, 'rev-parse', 'HEAD');
  const publish = (value = 'new remote\n') => {
    fs.writeFileSync(path.join(publisher, 'file.txt'), value);
    fs.writeFileSync(path.join(publisher, 'localisation', 'russian', 'test_l_russian.yml'), value);
    git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'remote update');
    git(publisher, 'push');
    return git(publisher, 'rev-parse', 'HEAD');
  };
  const request = (action) => fs.writeFileSync(path.join(service.directory, 'request.json'),
    JSON.stringify({ id: crypto.randomUUID(), pid: process.pid, action }));
  return { root, repo, publisher, remote, hub, service, head, publish, request };
}

test('repository automation defaults off and validates settings', () => {
  assert.deepEqual(repositorySyncSettings(null), { autoFetch: false, autoPull: false, intervalMinutes: 5,
    sound: true, flash: true, notification: true });
  assert.equal(repositorySyncSettings({ autoPull: 'true', intervalMinutes: -1 }).autoPull, false);
  assert.equal(repositorySyncSettings({ intervalMinutes: 10, sound: false }).sound, false);
  assert.equal(repositorySyncSettings({ intervalMinutes: 1 }).intervalMinutes, 1);
  assert.equal(repositorySyncSettings({ intervalMinutes: 2 }).intervalMinutes, 5);
});

test('disabled settings never fetch or update; stale requests from another Agent are ignored', async (t) => {
  const f = await fixture(t, {}); f.publish();
  fs.writeFileSync(path.join(f.service.directory, 'request.json'), JSON.stringify({ id: 'stale', pid: process.pid + 10, action: 'update' }));
  await f.service.tick();
  assert.equal(f.service.status.stage, 'disabled');
  assert.equal(git(f.repo, 'rev-parse', 'fork/barrad'), f.head);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('fetch-only updates the actual fork upstream, not local HEAD; manual check never pulls', async (t) => {
  const f = await fixture(t, { autoFetch: true }); const target = f.publish();
  await f.service.tick();
  assert.equal(repositorySnapshot(f.repo).remote, 'fork');
  assert.equal(git(f.repo, 'rev-parse', 'fork/barrad'), target);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(f.service.status.stage, 'available');
  fs.writeFileSync(path.join(f.service.directory, 'settings.json'), JSON.stringify({ autoPull: true }));
  f.request('check'); await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('auto-update fast-forwards clean barrad, while manual update also works with automation off', async (t) => {
  for (const automatic of [true, false]) {
    const f = await fixture(t, { autoPull: automatic }); const target = f.publish();
    if (!automatic) f.request('update');
    await f.service.tick();
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
    assert.equal(fs.readFileSync(path.join(f.repo, 'file.txt'), 'utf8').replaceAll('\r\n', '\n'), 'new remote\n');
    assert.equal(f.service.status.stage, 'updated');
    assert.equal(f.hub.repositoryUpdating, false);
    assert.equal(f.hub.gitCommit, target);
  }
});

test('dirty, staged and untracked files block updates without stash/reset; no remote commits means no alert', async (t) => {
  for (const kind of ['dirty', 'staged', 'untracked']) {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.repo, kind === 'untracked' ? 'new.txt' : 'file.txt'), 'my translation\n');
    if (kind === 'staged') git(f.repo, 'add', '.');
    await f.service.tick();
    assert.equal(f.service.status.stage, 'current'); assert.equal(f.service.status.alertId, '');
    f.publish(); f.request('update'); await f.service.tick();
    assert.equal(f.service.status.reason, 'dirty'); assert.ok(f.service.status.alertId);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
    assert.equal(fs.readFileSync(path.join(f.repo, kind === 'untracked' ? 'new.txt' : 'file.txt'), 'utf8'), 'my translation\n');
    assert.equal(git(f.repo, 'stash', 'list'), '');
    const alert = f.service.status.alertId;
    await f.service.tick(); assert.equal(f.service.status.alertId, alert);
    f.service.publish('error', { reason: 'error' });
    await f.service.tick(); assert.equal(f.service.status.alertId, alert);
  }
});

test('diverged branches stay untouched and require manual resolution', async (t) => {
  const f = await fixture(t); f.publish();
  fs.writeFileSync(path.join(f.repo, 'local.txt'), 'local commit'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'local');
  const localHead = git(f.repo, 'rev-parse', 'HEAD');
  await f.service.tick();
  assert.equal(f.service.status.reason, 'diverged'); assert.equal(f.service.status.ahead, 1);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), localHead);
});

test('no upstream, detached HEAD and in-progress Git operations never update', async (t) => {
  const f = await fixture(t); f.publish();
  fs.writeFileSync(path.join(f.repo, '.git', 'MERGE_HEAD'), f.head);
  assert.equal(repositoryWorktreeReason(f.repo), 'git-operation');
  await f.service.tick(); assert.equal(f.service.status.reason, 'git-operation');
  fs.unlinkSync(path.join(f.repo, '.git', 'MERGE_HEAD'));
  git(f.repo, 'branch', '--unset-upstream'); await f.service.tick();
  assert.equal(f.service.status.stage, 'no-upstream'); assert.equal(f.service.status.alertId, '');
  git(f.repo, 'checkout', '--detach'); await f.service.tick();
  assert.equal(f.service.status.reason, 'changed'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('fetch cannot use an unsafe configured refspec to modify a local branch', async (t) => {
  const f = await fixture(t); f.publish();
  git(f.repo, 'config', 'remote.fork.fetch', '+refs/heads/*:refs/heads/*');
  await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.notEqual(f.service.status.stage, 'updated');
});

function attachedBinding(f) {
  const state = { initialised: true, initialReconciled: true, pendingExternal: null, diskCheckPromise: Promise.resolve() };
  const relativePath = 'localisation/russian/test_l_russian.yml';
  const client = { documents: new Map([[path.join(f.repo, relativePath), state]]), scheduleMaterialisation() {}, send() {} };
  const binding = { synced: true, gitWritable: true, personalReady: true, clients: new Set([client]),
    materialisationWrite: Promise.resolve(), flushToServer: async () => true,
    persistBaseSnapshot(_state, text) { assert.equal(text, 'new remote\n'); },
    reconnectForGitHead() { this.reconnected = true; }, relativePath };
  state.binding = binding; f.hub.clients.add(client); f.hub.documents.set('barrad:file.txt', binding);
  return { state, client, binding };
}

test('flush is required and checkout becomes the new disk base before writer guards release', async (t) => {
  const f = await fixture(t); const target = f.publish(); const a = attachedBinding(f);
  a.binding.flushToServer = async () => {
    assert.equal(f.hub.repositoryUpdating, true); return true;
  };
  await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
  assert.equal(a.state.diskBase, 'new remote\n'); assert.equal(a.binding.reconnected, true);
  assert.equal(a.binding.gitWritable, false); assert.equal(a.binding.synced, false);
  assert.equal(f.hub.repositoryUpdating, false);
});

test('unacknowledged Review edits, new input during preflight and failed flush prevent checkout', async (t) => {
  for (const kind of ['flush', 'new-input', 'projection', 'conflict']) {
    const f = await fixture(t); f.publish(); const a = attachedBinding(f);
    if (kind === 'flush') a.binding.flushToServer = async () => false;
    if (kind === 'new-input') a.binding.flushToServer = async () => { f.hub.repositoryEditEpoch++; return true; };
    if (kind === 'projection') a.binding.personalRequestId = 'pending';
    if (kind === 'conflict') a.binding.personalConflicts = [{ key: 'duplicate occurrence' }];
    await f.service.tick();
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
    assert.equal(f.service.status.stage, 'blocked'); assert.equal(f.hub.repositoryUpdating, false);
    if (kind !== 'conflict') assert.equal(f.service.status.alertId, '', 'sync waits must not sound');
  }
});

test('changing HEAD or disabling auto-pull during flush aborts the update', async (t) => {
  for (const kind of ['branch', 'disabled', 'close', 'dirty']) {
    const f = await fixture(t); f.publish(); const a = attachedBinding(f);
    a.binding.flushToServer = async () => {
      if (kind === 'branch') git(f.repo, 'checkout', '-b', 'other');
      if (kind === 'disabled') fs.writeFileSync(path.join(f.service.directory, 'settings.json'), '{}');
      if (kind === 'close') f.service.stopped = true;
      if (kind === 'dirty') fs.writeFileSync(path.join(f.repo, 'new.txt'), 'edit');
      return true;
    };
    await f.service.tick();
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head); assert.equal(f.hub.repositoryUpdating, false);
  }
});

test('unopened recovery buffers block updates; alerts reset only after resolution', async (t) => {
  const f = await fixture(t); f.publish();
  const saved = f.hub.pendingDocumentUpdatePath('barrad:localisation/russian/test_l_russian.yml');
  fs.mkdirSync(path.dirname(saved)); fs.writeFileSync(saved, 'pending');
  assert.equal(repositoryReviewReason(f.hub), 'recovery');
  await f.service.tick(); const first = f.service.status.alertId; assert.ok(first);
  fs.unlinkSync(saved); await f.service.tick();
  assert.equal(f.service.status.stage, 'updated');
  fs.writeFileSync(path.join(f.repo, 'file.txt'), 'local'); f.publish('next remote\n'); f.request('update');
  await f.service.tick(); assert.ok(f.service.status.alertId); assert.notEqual(f.service.status.alertId, first);
});

test('buffers of deleted tickets, other branches and other servers never block this checkout', async (t) => {
  const f = await fixture(t); f.publish();
  const file = 'localisation/russian/test_l_russian.yml';
  const foreign = [`ticket-${crypto.randomUUID()}:${file}`, `other-branch:${file}`]
    .map((id) => f.hub.pendingDocumentUpdatePath(id));
  foreign.push(AgentHub.prototype.pendingDocumentUpdatePath.call(
    { options: { ...f.hub.options, server: 'wss://elsewhere.example' } }, `barrad:${file}`));
  fs.mkdirSync(path.dirname(foreign[0]));
  for (const target of foreign) fs.writeFileSync(target, 'pending');
  assert.equal(repositoryReviewReason(f.hub), '');
  await f.service.tick();
  assert.equal(f.service.status.stage, 'updated');
  for (const target of foreign) assert.ok(fs.existsSync(target), 'unrelated buffers are left untouched');
});

test('an in-flight HEAD poll on the same timer period is awaited, not reported as unconfirmed Review changes', async (t) => {
  const f = await fixture(t); f.publish();
  // Both services poll every three seconds; the HEAD poll fires first, and its
  // asynchronous Git call cannot finish while this service runs synchronously.
  // Model that: the flag clears only once the service yields to the poll.
  f.hub.gitCommitCheckPending = true;
  f.hub.gitCommitCheckSettled = { then(resolve) { f.hub.gitCommitCheckPending = false; resolve(); } };
  await f.service.tick();
  assert.equal(f.service.status.stage, 'updated', f.service.status.message);
  assert.notEqual(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('the HEAD poll exposes its completion so waiting services can outlast it', async (t) => {
  const f = await fixture(t);
  const hub = { options: { repo: f.repo, workspaceExplicit: true }, documents: new Map(), gitCommit: f.head };
  const running = AgentHub.prototype.checkGitCommitChange.call(hub);
  assert.equal(hub.gitCommitCheckPending, true);
  await hub.gitCommitCheckSettled;
  assert.equal(hub.gitCommitCheckPending, false);
  await running;
});

test('failed fetch stays unknown during backoff and cannot silently trust stale tracking refs', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.service.runFetch = async () => { attempts++; return { status: 1, stdout: '', stderr: 'offline' }; };
  await f.service.tick(); await f.service.tick();
  assert.equal(attempts, 1); assert.equal(f.service.status.stage, 'error');
  assert.equal(f.service.status.alertId, ''); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  f.request('check'); await f.service.tick(); assert.equal(attempts, 2);
});

test('interval throttles fetch and settings can change without an Agent restart', async (t) => {
  const f = await fixture(t, { autoFetch: true, intervalMinutes: 10 });
  let time = Date.now(), attempts = 0;
  f.service.now = () => time;
  const actualFetch = f.service.runFetch;
  f.service.runFetch = async (...args) => { attempts++; return actualFetch(...args); };
  await f.service.tick(); await f.service.tick(); assert.equal(attempts, 1);
  f.publish(); time += 9 * 60_000; await f.service.tick();
  assert.equal(attempts, 1); assert.equal(f.service.status.stage, 'current');
  time += 60_000; await f.service.tick(); assert.equal(attempts, 2);
  assert.equal(f.service.status.stage, 'available'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  fs.writeFileSync(path.join(f.service.directory, 'settings.json'), JSON.stringify({ autoPull: true }));
  await f.service.tick(); assert.equal(f.service.status.stage, 'updated');
});

test('one-minute interval fetches at the deadline and can be enabled without restarting Agent', async (t) => {
  const f = await fixture(t, { autoFetch: true, intervalMinutes: 5 });
  let time = Date.now(), attempts = 0;
  f.service.now = () => time;
  const actualFetch = f.service.runFetch;
  f.service.runFetch = async (...args) => { attempts++; return actualFetch(...args); };
  await f.service.tick(); assert.equal(attempts, 1);
  const checkedAt = new Date(time).toISOString();
  assert.equal(f.service.status.checkedAt, checkedAt);
  assert.equal(f.service.status.nextCheckAt, new Date(time + 5 * 60_000).toISOString());
  const target = f.publish();
  fs.writeFileSync(path.join(f.service.directory, 'settings.json'), JSON.stringify({ autoFetch: true, intervalMinutes: 1 }));
  time += 59_999; await f.service.tick();
  assert.equal(f.service.settings.intervalMinutes, 1);
  assert.equal(f.service.status.checkedAt, checkedAt, 'status polling is not a remote check');
  assert.equal(f.service.status.nextCheckAt, new Date(time + 1).toISOString());
  assert.equal(attempts, 1); assert.equal(f.service.status.stage, 'current');
  time += 1; await f.service.tick();
  assert.equal(attempts, 2); assert.equal(f.service.status.stage, 'available');
  assert.equal(f.service.status.checkedAt, new Date(time).toISOString());
  assert.equal(f.service.status.nextCheckAt, new Date(time + 60_000).toISOString());
  assert.equal(git(f.repo, 'rev-parse', 'fork/barrad'), target);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  await f.service.tick(); assert.equal(attempts, 2);
});

test('local polls keep the status stable and advertise fetching only for actual requests', async (t) => {
  const f = await fixture(t, { autoFetch: true, intervalMinutes: 1 });
  let time = Date.now(), attempts = 0; f.service.now = () => time;
  const stages = [], originalPublish = f.service.publish.bind(f.service), originalFetch = f.service.runFetch;
  f.service.publish = (stage, detail) => { stages.push(stage); return originalPublish(stage, detail); };
  f.service.runFetch = async (...args) => {
    attempts++; assert.equal(f.service.status.stage, 'fetching'); return originalFetch(...args);
  };
  await f.service.tick();
  assert.deepEqual(stages, ['fetching', 'current']); assert.equal(attempts, 1);
  const checkedAt = f.service.status.checkedAt, nextCheckAt = f.service.status.nextCheckAt;
  stages.length = 0;
  for (let tick = 0; tick < 3; tick++) { time += 3000; await f.service.tick(); }
  assert.deepEqual(stages, ['current', 'current', 'current']); assert.equal(attempts, 1);
  assert.equal(f.service.status.checkedAt, checkedAt); assert.equal(f.service.status.nextCheckAt, nextCheckAt);
  stages.length = 0;
  f.request('check'); await f.service.tick();
  assert.deepEqual(stages, ['fetching', 'current']); assert.equal(attempts, 2);
  stages.length = 0; time += 60_000; await f.service.tick();
  assert.deepEqual(stages, ['fetching', 'current']); assert.equal(attempts, 3);
});

test('check timing reflects failed attempts, manual fetches and disabled automation', async (t) => {
  const f = await fixture(t, { autoFetch: true, intervalMinutes: 1 });
  let time = Date.now(); f.service.now = () => time;
  f.service.runFetch = async () => ({ status: 1, stderr: 'offline' });
  await f.service.tick();
  const failedAt = new Date(time).toISOString();
  assert.equal(f.service.status.checkedAt, failedAt);
  assert.equal(f.service.status.nextCheckAt, new Date(time + 60_000).toISOString());
  time += 1000; await f.service.tick();
  assert.equal(f.service.status.checkedAt, failedAt);
  fs.writeFileSync(path.join(f.service.directory, 'settings.json'), '{}');
  await f.service.tick();
  assert.equal(f.service.status.checkedAt, failedAt); assert.equal(f.service.status.nextCheckAt, null);
  time += 1000; f.request('check'); await f.service.tick();
  assert.equal(f.service.status.checkedAt, new Date(time).toISOString());
  assert.equal(f.service.status.nextCheckAt, null);
  fs.writeFileSync(path.join(f.service.directory, 'settings.json'), JSON.stringify({ autoFetch: true }));
  git(f.repo, 'branch', '--unset-upstream'); await f.service.tick();
  assert.equal(f.service.status.stage, 'no-upstream'); assert.equal(f.service.status.nextCheckAt, null);
});

test('a materialisation racing with preflight is drained and prevents checkout if it dirties the worktree', async (t) => {
  const f = await fixture(t); f.publish(); const a = attachedBinding(f);
  let complete, reached;
  const began = new Promise((resolve) => { reached = resolve; });
  a.binding.materialisationWrite = new Promise((resolve) => { complete = resolve; });
  const originalPublish = f.service.publish.bind(f.service);
  f.service.publish = (stage, detail) => { originalPublish(stage, detail); if (stage === 'updating') reached(); };
  const updating = f.service.tick(); await began;
  assert.equal(f.hub.repositoryUpdating, true);
  fs.writeFileSync(path.join(f.repo, 'file.txt'), 'racing save');
  complete(); await updating;
  assert.equal(f.service.status.reason, 'dirty'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(f.hub.repositoryUpdating, false);
});

test('fast-forward failure releases every guard without reporting success', async (t) => {
  const f = await fixture(t); f.publish();
  f.service.runMerge = () => ({ status: 1, stderr: 'checkout denied' });
  await f.service.tick();
  assert.equal(f.service.status.stage, 'blocked'); assert.equal(f.service.status.reason, 'checkout-blocked');
  assert.equal(f.hub.repositoryUpdating, false);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('manual update retries transient server waits, then keeps its result visible with automation off', async (t) => {
  const f = await fixture(t, {}); const target = f.publish(); const a = attachedBinding(f);
  a.binding.personalRequestId = 'pending'; f.request('update'); await f.service.tick();
  assert.equal(f.service.status.reason, 'syncing');
  a.binding.personalRequestId = ''; await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
  assert.equal(f.service.status.stage, 'updated');
  await f.service.tick(); assert.equal(f.service.status.stage, 'updated');
});

test('server file-outdated status is not a deadlock, but unsent local edits are still protected', async (t) => {
  for (const pending of [false, true]) {
    const f = await fixture(t); const target = f.publish(); const a = attachedBinding(f);
    a.binding.gitWritable = false; a.binding.gitState = { status: 'file-outdated' };
    a.binding.localUpdatePending = pending; a.binding.pendingUpdateSent = false;
    await f.service.tick();
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), pending ? f.head : target);
  }
});

test('auto-pull unblocks Review opened with an outdated file and rebases its initial disk snapshot', async (t) => {
  const f = await fixture(t); const target = f.publish(); const a = attachedBinding(f);
  a.binding.gitWritable = false; a.binding.gitState = { status: 'file-outdated' };
  a.state.initialised = false; a.state.initialReconciled = false;
  a.state.mirror = 'original\n';
  await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
  assert.equal(f.service.status.stage, 'updated');
  assert.equal(a.state.diskBase, 'new remote\n');
  assert.equal(a.state.initialReconciled, true, 'the old initial snapshot must not be imported after checkout');
  assert.equal(a.binding.reconnected, true);
});

test('outdated startup only bypasses the UI initialisation wait, never actual safety blockers', async (t) => {
  for (const kind of ['current', 'offline', 'unsent', 'projection', 'conflict', 'external', 'flush', 'dirty', 'new-input']) {
    const f = await fixture(t); f.publish(); const a = attachedBinding(f);
    a.binding.gitWritable = false; a.binding.gitState = { status: 'file-outdated' };
    a.state.initialised = false; a.state.initialReconciled = false;
    if (kind === 'current') { a.binding.gitWritable = true; a.binding.gitState.status = 'current'; }
    if (kind === 'offline') a.binding.synced = false;
    if (kind === 'unsent') { a.binding.localUpdatePending = true; a.binding.pendingUpdateSent = false; }
    if (kind === 'projection') a.binding.personalRequestId = 'pending';
    if (kind === 'conflict') a.binding.personalConflicts = [{ key: 'key' }];
    if (kind === 'external') a.state.pendingExternal = { conflicts: [] };
    if (kind === 'flush') a.binding.flushToServer = async () => false;
    if (kind === 'dirty') fs.writeFileSync(path.join(f.repo, 'file.txt'), 'local change\n');
    if (kind === 'new-input') a.binding.flushToServer = async () => { f.hub.repositoryEditEpoch++; return true; };
    await f.service.tick();
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head, kind);
    assert.equal(a.state.initialReconciled, false, kind);
    assert.equal(f.service.status.stage, 'blocked', kind);
  }
});

test('canonical conflicts stay actionable even when the server makes the document read-only', async (t) => {
  const f = await fixture(t); f.publish(); const a = attachedBinding(f);
  a.binding.gitWritable = false; a.binding.gitState = { status: 'conflict' };
  await f.service.tick();
  assert.equal(f.service.status.reason, 'conflicts'); assert.ok(f.service.status.alertId);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('server-confirmed but not yet materialised personal text prevents a clean-file checkout', async (t) => {
  const f = await fixture(t); f.publish(); const a = attachedBinding(f);
  a.state.diskBase = 'original\n';
  a.binding.localFileText = () => 'personal translation waiting for autosave\n';
  await f.service.tick();
  assert.equal(f.service.status.reason, 'saving'); assert.equal(f.service.status.alertId, '');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('index flags cannot hide local changes from the clean-worktree guard', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = await fixture(t); f.publish();
    git(f.repo, 'update-index', flag, 'file.txt');
    fs.writeFileSync(path.join(f.repo, 'file.txt'), 'hidden translation');
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    await f.service.tick(); assert.equal(f.service.status.reason, 'hidden-index');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
    assert.equal(fs.readFileSync(path.join(f.repo, 'file.txt'), 'utf8'), 'hidden translation');
  }
});

test('fast-forward does not overwrite ignored files even if a remote commit adds one', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git', 'info', 'exclude'), 'private.txt\n');
  fs.writeFileSync(path.join(f.repo, 'private.txt'), 'my ignored data');
  fs.writeFileSync(path.join(f.publisher, 'private.txt'), 'remote version');
  f.publish(); await f.service.tick();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(fs.readFileSync(path.join(f.repo, 'private.txt'), 'utf8'), 'my ignored data');
  assert.equal(f.service.status.stage, 'blocked'); assert.equal(f.service.status.reason, 'checkout-blocked');
});

test('Review request is bound to the confirmed checkout, including retries, and rejects concurrent work', async (t) => {
  const f = await fixture(t, {}); f.publish(); const a = attachedBinding(f);
  const checkout = repositorySnapshot(f.repo);
  assert.throws(() => f.service.requestUpdate({ ...checkout, head: '0'.repeat(40) }), /HEAD изменились/u);
  assert.equal(f.service.reviewStatus().busy, false);
  a.binding.personalRequestId = 'waiting';
  const id = f.service.requestUpdate(checkout);
  assert.throws(() => f.service.requestUpdate(checkout), /уже выполняется/u);
  await f.service.tick();
  assert.equal(f.service.reviewStatus().requestId, id);
  assert.equal(f.service.reviewStatus().busy, true);
  assert.equal(f.service.status.reason, 'syncing');
  // Same branch, different clean HEAD during a transient wait: never silently
  // reinterpret the confirmed operation as updating this new checkout.
  git(f.repo, 'commit', '--allow-empty', '-m', 'local branch changed');
  const changed = git(f.repo, 'rev-parse', 'HEAD');
  a.binding.personalRequestId = '';
  await f.service.tick();
  assert.equal(f.service.status.reason, 'changed');
  assert.equal(f.service.reviewStatus().busy, false);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), changed);
});
