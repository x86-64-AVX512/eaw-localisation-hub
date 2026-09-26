import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { DeletedBranchArchive } from '../apps/server/src/deleted-branch-archive.mjs';
import { GitBranchCache } from '../apps/server/src/git-branch-cache.mjs';

const branch = 'removed-feature';
const file = 'localisation/russian/test_l_russian.yml';
const documentId = `${branch}:${file}`;
const hash = crypto.createHash('sha256').update(documentId).digest('hex');
const commit = 'a'.repeat(40);
const text = 'l_russian:\n key:0 "Первое"\n second:0 "Второе"\n';

function fixture({ deleted = true, indexed = true, stored = true } = {}) {
  const document = new Y.Doc();
  const content = document.getText('content');
  content.insert(0, text);
  const start = text.indexOf('Второе');
  const relative = (offset, associate) => Buffer.from(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, offset, associate),
  )).toString('base64');
  const room = {
    document, gitBase: { branch, commit }, currentText: () => content.toString(),
    commentThreads: [{
      id: 'thread', author: 'Reviewer', status: 'open',
      startRelative: relative(start, -1), endRelative: relative(start + 6, 0),
      messages: [{ id: 'message', author: 'Reviewer', body: 'Проверить перевод' }],
    }],
    suggestions: [],
  };
  const registry = {
    branchHints: new Map([[branch, { commit }]]), mergedBranches: new Map(),
    persisted: new Map(stored ? [[hash, 100]] : []),
    documentIdsForBranch: () => indexed ? [documentId] : [],
    unresolvedLegacyHashes: () => indexed ? [] : [hash],
    get: async (id) => { assert.equal(id, documentId); return room; },
  };
  const canonical = {
    enabled: true, githubRepository: 'EaW-Team/equestria_dev',
    branchDeleted: async (name) => { assert.equal(name, branch); return deleted; },
  };
  const tickets = { list: () => [{ baseBranch: branch }] };
  return { archive: new DeletedBranchArchive(canonical, registry, tickets), document, registry };
}

test('deleted branch archive lists saved files and opens text with positioned comments', async () => {
  const { archive, document } = fixture();
  try {
    assert.deepEqual(await archive.list(), { branches: [{
      branch, commit, files: [file], unknownCount: 0, tickets: 1,
    }] });
    const snapshot = await archive.document(branch, file);
    assert.equal(Buffer.from(snapshot.textBase64, 'base64').toString('utf8'), text);
    assert.equal(snapshot.comments[0].line, 3);
    assert.equal(snapshot.comments[0].messages[0].body, 'Проверить перевод');
  } finally { document.destroy(); }
});

test('missing path index remains discoverable by manual path, without inventing rooms', async () => {
  const { archive, document } = fixture({ indexed: false });
  try {
    assert.equal((await archive.list()).branches[0].unknownCount, 1);
    assert.equal((await archive.document(branch, file)).relativePath, file);
    assert.equal(await archive.document(branch, 'localisation/russian/absent_l_russian.yml'), null);
    assert.equal(await archive.document(branch, '../secret.yml'), null);
  } finally { document.destroy(); }
});

test('a live or merged branch is never exposed as a deleted-branch archive', async () => {
  const { archive, document, registry } = fixture({ deleted: false });
  try {
    assert.deepEqual((await archive.list()).branches, []);
    assert.equal(await archive.document(branch, file), null);
    registry.mergedBranches.set(branch, { target: 'general-dev' });
    assert.deepEqual((await archive.list()).branches, []);
  } finally { document.destroy(); }
});

test('a persisted record is required before an archived file can be opened', async () => {
  const { archive, document } = fixture({ stored: false });
  try { assert.equal(await archive.document(branch, file), null); }
  finally { document.destroy(); }
});

test('an indexed hash without both saved document files cannot create an archive room', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-archive-parts-'));
  const { archive, document, registry } = fixture();
  registry.dataDirectory = directory;
  try {
    const documents = path.join(directory, 'documents');
    await fs.mkdir(documents);
    await fs.writeFile(path.join(documents, `${hash}.json`), JSON.stringify({ gitBase: { branch } }));
    assert.equal(await archive.document(branch, file), null);
    await fs.writeFile(path.join(documents, `${hash}.update`), 'saved');
    assert.equal((await archive.document(branch, file)).relativePath, file);
  } finally {
    document.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('remote branch absence is checked from one cached Git ref listing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-archive-refs-'));
  try {
    const cache = new GitBranchCache(directory, 'EaW-Team/equestria_dev');
    let calls = 0;
    cache.git = async () => {
      calls += 1;
      return `${commit}\trefs/heads/general-dev\n${commit}\trefs/heads/live-feature`;
    };
    assert.equal(await cache.branchDeleted('removed-feature'), true);
    assert.equal(await cache.branchDeleted('live-feature'), false);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
