import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ticketBootstrap } from '../apps/agent/src/git-ticket-context.mjs';
import {
  checkDiskChange,
  reconcileInitialDisk,
  scheduleDiskCheck,
  startFileWatcher,
} from '../apps/agent/src/disk-reconciliation.mjs';

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('ticket documents never start or execute local-file reconciliation', async () => {
  const binding = { ticketId: 'ticket-1', paused: false, hub: { options: { repo: 'unused' } } };
  const state = { initialReconciled: false, binding, diskDebounce: null };
  const client = { documents: new Map([['file', state]]) };
  startFileWatcher(binding, client, 'file', state);
  scheduleDiskCheck(binding, client, 'file', state, 0);
  await checkDiskChange(binding, client, 'file', state);
  reconcileInitialDisk(binding, client, 'file', state);
  assert.equal(state.diskWatcher, undefined);
  assert.equal(state.diskPollTimer, undefined);
  assert.equal(state.diskDebounce, null);
  assert.equal(state.initialReconciled, true);
});

test('ticket bootstrap uses the current server snapshot and Git only for an unseeded room', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-bootstrap-'));
  const relativePath = 'localisation/russian/test_l_russian.yml';
  const absolutePath = path.join(repository, ...relativePath.split('/'));
  const base = '\uFEFFl_russian:\n key:0 "Base"\n';
  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, base);
    git(repository, 'init');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'base');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const ticket = { id: 'ticket-1', baseCommit: commit, files: [relativePath] };
    const hub = {
      options: { repo: repository },
      async ticketRequest() {
        return { ticket, files: [{
          path: relativePath,
          ticketInitialised: true,
          ticketTextBase64: Buffer.from('l_russian:\n key:0 "Ticket"\n').toString('base64'),
        }] };
      },
    };
    assert.match((await ticketBootstrap(hub, ticket.id, relativePath)).text, /"Ticket"/u);
    hub.ticketRequest = async () => ({ ticket, files: [{
      path: relativePath, ticketInitialised: false, ticketTextBase64: '',
    }] });
    const unseeded = (await ticketBootstrap(hub, ticket.id, relativePath)).text;
    assert.equal(unseeded.startsWith('\uFEFF'), false);
    assert.match(unseeded, /"Base"/u);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
