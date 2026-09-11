import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentHistory } from '../apps/server/src/document-history.mjs';

const alice = { id: 'alice', displayName: 'Alice' };
const bob = { id: 'bob', displayName: 'Bob' };
const baseline = 'l_russian:\n key:0 "Git"\n other:0 "Keep"\n';

test('an incorporated personal edit cannot overwrite a later Git version after reload', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-retire-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  const history = new DocumentHistory(target);
  history.ensureBaseline(baseline);
  const own = baseline.replace('"Git"', '"Alice"');
  history.record(own, alice);
  history.updateGitBase(own);
  assert.equal(history.authorVariants.get('alice').size, 0);
  await fs.writeFile(target, history.serialise());
  const restored = new DocumentHistory(target); await restored.load();
  const upstream = baseline.replace('"Git"', '"Upstream"');
  assert.equal(restored.personalProjection('alice', upstream), upstream);
  assert.deepEqual(restored.personalGitConflicts('alice'), []);
});

test('Git rebases an independent personal edit but preserves a hidden author conflict for explicit resolution', () => {
  const history = new DocumentHistory('unused'); history.ensureBaseline(baseline);
  history.record(baseline.replace('"Git"', '"Alice"'), alice);
  history.record(baseline.replace('"Git"', '"Bob"'), bob);
  const git = baseline.replace('"Git"', '"Bob"').replace('"Keep"', '"Upstream"');
  const personal = history.personalProjection('alice', git);
  assert.match(personal, /"Alice"/u); assert.match(personal, /"Upstream"/u);
  const [conflict] = history.personalGitConflicts('alice');
  assert.equal(conflict.key, 'key');
  assert.equal(history.personalProjection('bob', git), git);
  assert.equal(history.resolvePersonalGitConflict('alice', 'key', 'git', 'stale'), false);
  assert.equal(history.resolvePersonalGitConflict('alice', 'key', 'git', conflict.id), true);
  assert.equal(history.personalProjection('alice', git), git);
  assert.deepEqual(history.personalGitConflicts('alice'), []);
});

test('unresolved personal conflicts survive another Git update and a restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-conflict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  const history = new DocumentHistory(target); history.ensureBaseline(baseline);
  history.record(baseline.replace('"Git"', '"Alice"'), alice);
  const firstGit = baseline.replace('"Git"', '"Server"');
  history.updateGitBase(firstGit);
  const firstId = history.personalGitConflicts('alice')[0].id;
  const nextGit = firstGit.replace('"Keep"', '"Next"');
  history.updateGitBase(nextGit);
  await fs.writeFile(target, history.serialise());
  const restored = new DocumentHistory(target); await restored.load();
  const [conflict] = restored.personalGitConflicts('alice');
  assert.notEqual(conflict.id, firstId);
  assert.equal(restored.resolvePersonalGitConflict('alice', 'key', 'mine', firstId), false);
  assert.equal(restored.resolvePersonalGitConflict('alice', 'key', 'mine', conflict.id), true);
  assert.match(restored.personalProjection('alice', nextGit), /"Alice"/u);
  assert.deepEqual(restored.personalGitConflicts('alice'), []);
});

test('schema-3 histories retain unproven variants but require a choice before writing them', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-migrate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  const history = new DocumentHistory(target); history.ensureBaseline(baseline);
  history.record(baseline.replace('"Git"', '"Old"'), alice);
  const legacy = JSON.parse(history.serialise());
  legacy.schema = 3; delete legacy.gitBaseGzipBase64; delete legacy.rebaseConflicts;
  await fs.writeFile(target, JSON.stringify(legacy));
  const restored = new DocumentHistory(target); await restored.load();
  const currentGit = baseline.replace('"Git"', '"New"');
  assert.match(restored.personalProjection('alice', currentGit), /"Old"/u);
  assert.equal(restored.personalGitConflicts('alice')[0].reason, 'legacy-base-unknown');
  assert.equal(JSON.parse(restored.serialise()).schema, 5);
});

test('accepted suggestions separate creator from accepter and belong only to the accepter projection', () => {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(baseline);
  const accepted = baseline.replace('key:0 "Git"', 'key:0 "Proposed"');
  history.record(accepted, bob, 'suggestion', {
    suggestion: { id: 'suggestion-1', authorId: 'alice', author: 'Alice', color: '#f00' },
  });

  const entry = history.summaries()[0];
  assert.equal(entry.author, 'Bob');
  assert.equal(entry.suggestionAuthor, 'Alice');
  assert.equal(entry.suggestionId, 'suggestion-1');
  assert.equal(history.personalProjection('alice', baseline), baseline);
  assert.equal(history.personalProjection('bob', baseline), accepted);
});

test('legacy suggestion attribution migrates away from its creator without losing unrelated personal edits', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-suggestion-migrate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'history.json');
  const history = new DocumentHistory(target);
  history.ensureBaseline(baseline);
  const accepted = baseline.replace('key:0 "Git"', 'key:0 "Proposed"');
  history.record(accepted, alice, 'suggestion');
  const withOwnEdit = accepted.replace('other:0 "Keep"', 'other:0 "Alice own"');
  history.record(withOwnEdit, alice, 'edit');
  const legacy = JSON.parse(history.serialise());
  legacy.schema = 4;
  await fs.writeFile(target, JSON.stringify(legacy));

  const restored = new DocumentHistory(target);
  await restored.load();
  assert.equal(restored.reconcileSuggestionAttribution([{
    id: 'suggestion-1', status: 'accepted', authorId: 'alice', author: 'Alice', color: '#f00',
    decidedById: 'bob', decidedBy: 'Bob', originalText: '"Git"', replacementText: '"Proposed"',
  }]), true);
  const entry = restored.summaries().find(({ reason }) => reason === 'suggestion');
  assert.equal(entry.author, 'Bob');
  assert.equal(entry.suggestionAuthor, 'Alice');
  assert.equal(restored.personalProjection('alice', baseline),
    baseline.replace('other:0 "Keep"', 'other:0 "Alice own"'));
  assert.equal(restored.personalProjection('bob', baseline), accepted);
  assert.equal(restored.reconcileSuggestionAttribution([]), false);
  assert.equal(JSON.parse(restored.serialise()).schema, 5);
});

test('personal projections retain moved blank lines, comments, key order, and an empty file', () => {
  const git = 'l_russian:\n\n a:0 "A"\n # comment\n b:0 "B"\n';
  for (const edited of [
    'l_russian:\n a:0 "A"\n\n # comment\n b:0 "B"\n',
    'l_russian:\n\n # comment\n a:0 "A"\n b:0 "B"\n',
    'l_russian:\n\n b:0 "B"\n # comment\n a:0 "A"\n',
    '',
  ]) {
    const history = new DocumentHistory('unused'); history.ensureBaseline(git);
    history.record(edited, alice);
    assert.equal(history.personalProjection('alice', git), edited);
  }
});

test('document history persists, coalesces edits, restores text, and anonymises authors', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-history-'));
  const target = path.join(directory, 'room.history.json');
  try {
    const history = new DocumentHistory(target);
    assert.equal(history.ensureBaseline('first'), true);
    assert.equal(history.record('second', { id: 'user-1', displayName: 'Alice', color: '#ff6677' }), true);
    assert.equal(history.record('third', { id: 'user-1', displayName: 'Alice', color: '#ff6677' }), true);
    assert.equal(history.summaries().length, 2, 'nearby edits by one author form one history version');
    const edit = history.summaries()[0];
    assert.equal(history.text(edit.id), 'third');
    await fs.writeFile(target, history.serialise());

    const restored = new DocumentHistory(target);
    await restored.load();
    assert.equal(restored.text(restored.headId()), 'third');
    assert.equal(restored.anonymise('user-1'), true);
    assert.equal(restored.summaries()[0].author, 'Deleted user');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('personal projection keeps Git plus only the selected author changes', () => {
  const git = 'l_russian:\n a:0 "A"\n b:0 "B"\n c:0 "C"\n';
  const history = new DocumentHistory('unused');
  history.ensureBaseline(git);
  history.record('l_russian:\n a:0 "Alice"\n b:0 "B"\n c:0 "C"\n',
    { id: 'alice', displayName: 'Alice', color: '#f00' });
  history.record('l_russian:\n a:0 "Alice"\n b:0 "Bob"\n c:0 "C"\n',
    { id: 'bob', displayName: 'Bob', color: '#0f0' });
  history.record('l_russian:\n a:0 "Alice"\n b:0 "Bob"\n c:0 "Alice too"\n',
    { id: 'alice', displayName: 'Alice', color: '#f00' });
  assert.equal(history.personalProjection('alice', git),
    'l_russian:\n a:0 "Alice"\n b:0 "B"\n c:0 "Alice too"\n');
  assert.deepEqual(history.contributors().map(({ displayName }) => displayName), ['Alice', 'Bob']);
});

test('a local Git rollback replaces only the author projection', () => {
  const git = 'l_russian:\n a:0 "Git"\n b:0 "Git"\n';
  const history = new DocumentHistory('unused');
  history.ensureBaseline(git);
  history.record(git.replace('a:0 "Git"', 'a:0 "Alice"'), alice);
  history.record(
    git.replace('a:0 "Git"', 'a:0 "Alice"').replace('b:0 "Git"', 'b:0 "Bob"'),
    bob,
  );
  const shared = history.text(history.headId());

  assert.equal(history.replacePersonalProjection(alice, git, git), true);
  assert.equal(history.personalProjection('alice', git), git);
  assert.equal(history.personalProjection('bob', git), git.replace('b:0 "Git"', 'b:0 "Bob"'));
  assert.equal(history.text(history.headId()), shared, 'shared history must not be rewritten');
});

test('same-key author variants remain separate and are reported as conflicts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-variants-'));
  const target = path.join(directory, 'room.history.json');
  const git = 'l_russian:\n shared:0 "Git"\n untouched:0 "Keep"\n';
  try {
    const history = new DocumentHistory(target);
    history.ensureBaseline(git);
    history.record(git.replace('"Git"', '"Alice"'),
      { id: 'alice', displayName: 'Alice', color: '#f00' });
    history.record(git.replace('"Git"', '"Bob"'),
      { id: 'bob', displayName: 'Bob', color: '#0f0' });
    assert.match(history.personalProjection('alice', git), /shared:0 "Alice"/u);
    assert.match(history.personalProjection('bob', git), /shared:0 "Bob"/u);
    assert.deepEqual(history.conflicts(git), [{
      key: 'shared',
      baseLine: ' shared:0 "Git"',
      variants: [
        { authorId: 'alice', author: 'Alice', line: ' shared:0 "Alice"' },
        { authorId: 'bob', author: 'Bob', line: ' shared:0 "Bob"' },
      ],
    }]);
    assert.equal(history.conflicts(git, 'alice').length, 1,
      'an involved author sees the personal-variant conflict');
    assert.deepEqual(history.conflicts(git, 'unrelated-user'), [],
      'an unrelated user is not warned about other authors\' personal variants');
    await fs.writeFile(target, history.serialise());
    const restored = new DocumentHistory(target);
    await restored.load();
    assert.match(restored.personalProjection('alice', git), /shared:0 "Alice"/u);
    assert.equal(restored.conflicts(git).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
