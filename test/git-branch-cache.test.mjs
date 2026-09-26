import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { GitBranchCache } from '../apps/server/src/git-branch-cache.mjs';
import { branchRepositoriesFor } from '../apps/server/src/branch-repositories.mjs';

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

test('only the EaW repository routes barrad to the approved fork', () => {
  assert.deepEqual(branchRepositoriesFor('EaW-Team/equestria_dev'), {
    barrad: 'MiszczTheMaste/equestria_dev',
  });
  assert.deepEqual(branchRepositoriesFor('https://github.com/EaW-Team/equestria_dev.git'), {
    barrad: 'MiszczTheMaste/equestria_dev',
  });
  assert.deepEqual(branchRepositoriesFor('SomeoneElse/equestria_dev'), {});
  assert.deepEqual(branchRepositoriesFor(''), {});
});

test('barrad uses its fork even when a stale main-repository cache and branch exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-fork-cache-'));
  try {
    const main = path.join(root, 'main');
    const fork = path.join(root, 'fork');
    const mainOrigin = path.join(root, 'main.git');
    const forkOrigin = path.join(root, 'fork.git');
    for (const [directory, text] of [[main, 'main'], [fork, 'fork']]) {
      const loc = path.join(directory, 'localisation', 'russian');
      await fs.mkdir(loc, { recursive: true });
      await fs.writeFile(path.join(loc, 'barrad.yml'), `l_russian:\n a:0 "${text}"\n`);
      git(directory, 'init', '-b', 'barrad');
      git(directory, 'config', 'user.name', 'Test');
      git(directory, 'config', 'user.email', 'test@example.invalid');
      git(directory, 'add', '.');
      git(directory, 'commit', '-m', 'initial');
    }
    git(root, 'clone', '--bare', main, mainOrigin);
    git(root, 'clone', '--bare', fork, forkOrigin);

    const data = path.join(root, 'data');
    const oldCache = new GitBranchCache(data, pathToFileURL(mainOrigin).href);
    assert.match((await oldCache.snapshot('barrad:localisation/russian/barrad.yml')).text, /"main"/u);

    const cache = new GitBranchCache(data, pathToFileURL(mainOrigin).href, {
      refreshMilliseconds: 0,
      branchRepositories: { barrad: pathToFileURL(forkOrigin).href },
    });
    const snapshot = await cache.snapshot('barrad:localisation/russian/barrad.yml');
    assert.match(snapshot.text, /"fork"/u);
    assert.equal(snapshot.commit, git(fork, 'rev-parse', 'HEAD'));
    assert.equal(git(cache.branchDirectory('barrad'), 'remote', 'get-url', 'origin'), pathToFileURL(forkOrigin).href);
    assert.equal((await cache.remoteBranchNames()).has('barrad'), true);
    assert.equal(await cache.branchDeleted('barrad'), false);

    git(root, '--git-dir', forkOrigin, 'branch', '-D', 'barrad');
    assert.equal((await cache.remoteBranchNames({ force: true })).has('barrad'), false);
    assert.equal(await cache.branchDeleted('barrad'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('merge detection looks for pull requests from the fork owner', async () => {
  const urls = [];
  const cache = new GitBranchCache('/unused', 'EaW-Team/equestria_dev', {
    branchRepositories: { barrad: 'MiszczTheMaste/equestria_dev' },
    fetchImplementation: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => url.includes('/compare/')
        ? { status: 'behind', base_commit: { sha: 'a'.repeat(40) } }
        : [] };
    },
  });
  assert.equal(await cache.mergedInto('barrad', 'general-dev', 'a'.repeat(40), 'b'.repeat(40)), false);
  assert.match(urls[1], /head=MiszczTheMaste%3Abarrad/u);
});
