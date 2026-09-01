import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileHistoryDiff, listFileHistory } from '../apps/agent/src/git-file-history.mjs';

function git(repository, ...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
}

test('local Git history follows a renamed localisation file back to its first commit', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-git-history-'));
  const oldRelative = 'localisation/english/old_l_english.yml';
  const currentRelative = 'localisation/english/current_l_english.yml';
  try {
    fs.mkdirSync(path.join(repository, 'localisation', 'english'), { recursive: true });
    git(repository, 'init');
    git(repository, 'config', 'user.name', 'History Tester');
    git(repository, 'config', 'user.email', 'history@example.invalid');
    fs.writeFileSync(path.join(repository, oldRelative), 'l_english:\n key:0 "First"\n', 'utf8');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'Initial English text');
    const firstCommit = git(repository, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repository, oldRelative), 'l_english:\n key:0 "Second"\n', 'utf8');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'Update old English path');
    const secondCommit = git(repository, 'rev-parse', 'HEAD').trim();
    git(repository, 'mv', oldRelative, currentRelative);
    git(repository, 'commit', '-m', 'Rename localisation file');
    fs.writeFileSync(path.join(repository, currentRelative), 'l_english:\n key:0 "Today"\n', 'utf8');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'Update English text');

    const history = listFileHistory(repository, currentRelative, { limit: 2 });
    assert.equal(history.entries.length, 2);
    assert.equal(history.hasMore, true);
    const older = listFileHistory(repository, currentRelative, { offset: 2, limit: 2 });
    assert.equal(older.entries.length, 2);
    const firstEntry = older.entries.find(({ commit }) => commit === firstCommit);
    const secondEntry = older.entries.find(({ commit }) => commit === secondCommit);
    assert.equal(firstEntry.historicalPath, oldRelative);
    assert.equal(secondEntry.historicalPath, oldRelative);

    const comparison = fileHistoryDiff(
      repository, currentRelative, firstEntry.commit, firstEntry.historicalPath,
    );
    assert.match(comparison.baseText, /"First"/u);
    assert.match(comparison.headText, /"Today"/u);

    const commitToCommit = fileHistoryDiff(
      repository,
      currentRelative,
      firstEntry.commit,
      firstEntry.historicalPath,
      secondEntry.commit,
      secondEntry.historicalPath,
    );
    assert.match(commitToCommit.baseText, /"First"/u);
    assert.match(commitToCommit.headText, /"Second"/u);
    assert.equal(commitToCommit.fromCommit, firstCommit);
    assert.equal(commitToCommit.toCommit, secondCommit);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Git history rejects paths outside supported localisation folders', () => {
  assert.throws(() => listFileHistory(process.cwd(), '../secret.yml'), /вне репозитория/u);
});
