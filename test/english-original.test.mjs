import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { englishOriginal } from '../apps/agent/src/git-ticket-context.mjs';

test('English original lookup resolves an exact key from the ticket base commit', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-english-'));
  const relative = 'localisation/english/example_l_english.yml';
  const runGit = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  try {
    await fs.mkdir(path.join(repository, 'localisation', 'english'), { recursive: true });
    await fs.writeFile(path.join(repository, relative), [
      'l_english:',
      ' TEST_KEY:0 "The original line"',
      ' TEST_KEY_LONG:0 "Different key"',
      '',
    ].join('\n'));
    assert.equal(runGit('init', '-b', 'general-dev').status, 0);
    assert.equal(runGit('config', 'user.name', 'Test').status, 0);
    assert.equal(runGit('config', 'user.email', 'test@example.invalid').status, 0);
    assert.equal(runGit('add', '.').status, 0);
    assert.equal(runGit('commit', '-m', 'English fixture').status, 0);
    const commit = runGit('rev-parse', 'HEAD').stdout.trim();
    const hub = {
      options: { repo: repository },
      ticketRequest: async () => ({ ticket: { baseCommit: commit } }),
    };
    const result = await englishOriginal(hub, 'TEST_KEY', 'ticket-id');
    assert.equal(result.commit, commit);
    assert.deepEqual(result.matches, [{
      file: relative, line: 2, key: 'TEST_KEY', text: 'The original line',
    }]);
    await assert.rejects(englishOriginal(hub, 'BAD KEY', ''), /ключ/u);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
