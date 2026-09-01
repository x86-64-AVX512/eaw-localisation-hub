import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { discoverGitExecutable } from '../apps/agent/src/git-executable.mjs';

test('Agent discovers the Git executable bundled with the newest GitHub Desktop', () => {
  const environment = { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' };
  const expected = path.join(
    environment.LOCALAPPDATA, 'GitHubDesktop', 'app-3.5.2',
    'resources', 'app', 'git', 'cmd', 'git.exe',
  );
  const executable = discoverGitExecutable({
    environment,
    platform: 'win32',
    readDirectory: () => [{ name: 'app-3.4.1', isDirectory: () => true },
      { name: 'app-3.5.2', isDirectory: () => true }],
    probe: (candidate) => candidate === expected,
  });
  assert.equal(executable, expected);
});

test('Agent reports a clear error when neither system nor GitHub Desktop Git exists', () => {
  assert.throws(() => discoverGitExecutable({
    environment: {}, platform: 'win32', probe: () => false,
  }), /Git не найден/u);
});
