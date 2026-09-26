import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  currentGitCommit, currentGitCommitAsync, currentGitFileBlob, currentGitFileBlobAsync,
} from '../apps/agent/src/git-ticket-context.mts';

test('asynchronous Git blob check agrees with the synchronous path and rejects unsupported files', async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-git-blob-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const relativePath = 'localisation/russian/file.yml';
  const target = path.join(repository, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'l_russian:\n key:0 "Value"\n');
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', relativePath], { cwd: repository });
  execFileSync('git', [
    '-c', 'user.name=EaW Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'fixture',
  ], { cwd: repository });
  assert.equal(await currentGitFileBlobAsync(repository, relativePath),
    currentGitFileBlob(repository, relativePath));
  assert.equal(await currentGitCommitAsync(repository), currentGitCommit(repository));
  await assert.rejects(currentGitFileBlobAsync(repository, '../outside.yml'), /поддерживаемые папки/u);
});
