import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { GitBranchCache } from '../apps/server/src/git-branch-cache.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

test('canonical cache clones sparse localisation trees and refreshes branch head', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-git-cache-'));
  try {
    const source = path.join(root, 'source');
    const origin = path.join(root, 'origin.git');
    await fs.mkdir(path.join(source, 'localisation', 'russian'), { recursive: true });
    await fs.mkdir(path.join(source, 'localisation', 'replace', 'russian'), { recursive: true });
    await fs.mkdir(path.join(source, 'unrelated'), { recursive: true });
    await fs.writeFile(path.join(source, 'localisation', 'russian', 'a.yml'), '\uFEFFl_russian:\n a:0 "one"\n');
    await fs.writeFile(path.join(source, 'localisation', 'replace', 'russian', 'b.yml'), 'l_russian:\n b:0 "two"\n');
    await fs.writeFile(path.join(source, 'unrelated', 'large.txt'), 'not sparse');
    git(source, 'init', '-b', 'general-dev');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'initial');
    git(root, 'clone', '--bare', source, origin);

    const cache = new GitBranchCache(path.join(root, 'data'), pathToFileURL(origin).href, {
      refreshMilliseconds: 0,
    });
    const first = await cache.snapshot('general-dev:localisation/russian/a.yml');
    assert.equal(first.text.replaceAll('\r\n', '\n'), 'l_russian:\n a:0 "one"\n');
    assert.match(first.blob, /^[0-9a-f]{40,64}$/u);
    const replacement = await cache.snapshot('general-dev:localisation/replace/russian/b.yml');
    assert.equal(replacement.text.replaceAll('\r\n', '\n'), 'l_russian:\n b:0 "two"\n');
    await assert.rejects(fs.access(path.join(cache.branchDirectory('general-dev'), 'unrelated', 'large.txt')));

    await fs.writeFile(path.join(source, 'localisation', 'russian', 'a.yml'), 'l_russian:\n a:0 "new"\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'update');
    git(source, 'push', origin, 'general-dev');
    const second = await cache.snapshot('general-dev:localisation/russian/a.yml', { force: true });
    assert.equal(second.text.replaceAll('\r\n', '\n'), 'l_russian:\n a:0 "new"\n');
    assert.notEqual(second.commit, first.commit);
    assert.notEqual(second.blob, first.blob);
    assert.deepEqual(second.changedFiles, ['localisation/russian/a.yml']);
    const unchanged = await cache.snapshot('general-dev:localisation/replace/russian/b.yml');
    assert.equal(unchanged.blob, replacement.blob);
    assert.equal(unchanged.commit, second.commit);

    await fs.writeFile(path.join(source, 'localisation', 'replace', 'russian', 'b.yml'),
      'l_russian:\n b:0 "updated"\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'update replacement');
    git(source, 'push', origin, 'general-dev');
    const third = await cache.snapshot('general-dev:localisation/replace/russian/b.yml', { force: true });
    assert.deepEqual(await cache.changedFilesSince(
      'general-dev:localisation/russian/a.yml', first.commit,
    ), ['localisation/replace/russian/b.yml', 'localisation/russian/a.yml']);

    await fs.writeFile(path.join(source, 'unrelated', 'large.txt'), 'changed outside localisation');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'unrelated update');
    git(source, 'push', origin, 'general-dev');
    await cache.snapshot('general-dev:localisation/russian/a.yml', { force: true });
    assert.deepEqual(await cache.changedFilesSince(
      'general-dev:localisation/russian/a.yml', third.commit,
    ), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
