import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KeyReplacementWorkflow } from '../apps/agent/src/key-replacement-workflow.mjs';

test('key replacement workflow previews and directly applies a multi-file batch', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-replace-'));
  try {
    const directory = path.join(repository, 'localisation', 'russian');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'a_l_russian.yml'), '\uFEFFl_russian:\n one:0 "old one"\n', 'utf8');
    await fs.writeFile(path.join(directory, 'b_l_russian.yml'), '\uFEFFl_russian:\n two:0 "old two"\n', 'utf8');
    const workflow = new KeyReplacementWorkflow({ options: { repo: repository } });
    const input = 'one: "новое один"\ntwo:0 "новое два"';
    const preview = await workflow.preview(input);
    assert.deepEqual(preview.missingKeys, []);
    assert.deepEqual(preview.duplicateMatches, []);
    assert.equal(preview.changes.length, 2);
    assert.equal(preview.files.length, 2);
    assert.deepEqual(await workflow.apply(input, preview.files), { changedKeys: 2, changedFiles: 2 });
    assert.match(await fs.readFile(path.join(directory, 'a_l_russian.yml'), 'utf8'), /one:0 "новое один"/u);
    assert.match(await fs.readFile(path.join(directory, 'b_l_russian.yml'), 'utf8'), /two:0 "новое два"/u);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

test('key replacement workflow blocks missing and duplicate repository keys', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-errors-'));
  try {
    const directory = path.join(repository, 'localisation', 'russian');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'a.yml'), 'l_russian:\n duplicate:0 "a"\n', 'utf8');
    await fs.writeFile(path.join(directory, 'b.yml'), 'l_russian:\n duplicate:0 "b"\n', 'utf8');
    const preview = await new KeyReplacementWorkflow({ options: { repo: repository } })
      .preview('duplicate: "x"\nmissing: "y"');
    assert.deepEqual(preview.missingKeys, ['missing']);
    assert.equal(preview.duplicateMatches[0].key, 'duplicate');
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
