import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentHistory } from '../apps/server/src/document-history.mjs';

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
    await fs.writeFile(target, history.serialise());
    const restored = new DocumentHistory(target);
    await restored.load();
    assert.match(restored.personalProjection('alice', git), /shared:0 "Alice"/u);
    assert.equal(restored.conflicts(git).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
