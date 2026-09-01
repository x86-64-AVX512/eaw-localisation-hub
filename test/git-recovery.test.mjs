import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preserveChangedFile } from '../apps/agent/src/git-recovery.mjs';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, windowsHide: true });
}

test('Agent preserves an uncommitted localisation file before canonical blocking', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-git-recovery-'));
  try {
    const repository = path.join(root, 'repo');
    const relativePath = 'localisation/russian/test.yml';
    const absolutePath = path.join(repository, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'l_russian:\n test:0 "base"\n');
    git(repository, 'init', '-b', 'general-dev');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'base');
    await fs.writeFile(absolutePath, 'l_russian:\n test:0 "local"\n');
    const binding = {
      ticketId: '', relativePath, clients: new Set(),
      hub: { options: { repo: repository, state: path.join(root, 'state') } },
    };
    const state = { binding };
    binding.clients.add({ documents: new Map([[absolutePath, state]]) });
    const saved = await preserveChangedFile(binding, {
      status: 'file-outdated', remoteBlob: 'a'.repeat(40), remoteHead: 'b'.repeat(40),
    });
    assert.match(saved, /git-recovery/u);
    assert.equal(await fs.readFile(saved, 'utf8'), 'l_russian:\n test:0 "local"\n');
    assert.equal(await preserveChangedFile(binding, {
      status: 'file-outdated', remoteBlob: 'a'.repeat(40), remoteHead: 'b'.repeat(40),
    }), '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
