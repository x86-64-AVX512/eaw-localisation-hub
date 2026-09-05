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

test('key replacement workflow scopes changes to the selected localisation language', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-language-'));
  try {
    for (const language of ['russian', 'english']) {
      const directory = path.join(repository, 'localisation', language);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `same_l_${language}.yml`), `l_${language}:\n same:0 "${language}"\n`, 'utf8');
    }
    const workflow = new KeyReplacementWorkflow({ options: { repo: repository } });
    const preview = await workflow.preview('same:0 "updated"', 'english');
    assert.deepEqual(preview.changes.map(({ file }) => file), ['localisation/english/same_l_english.yml']);
    await workflow.apply('same:0 "updated"', preview.files, 'english');
    assert.match(await fs.readFile(path.join(repository, 'localisation', 'english', 'same_l_english.yml'), 'utf8'), /"updated"/u);
    assert.match(await fs.readFile(path.join(repository, 'localisation', 'russian', 'same_l_russian.yml'), 'utf8'), /"russian"/u);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});

test('key replacement workflow replaces the whole legacy value with inner quotes', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-legacy-quotes-'));
  try {
    const directory = path.join(repository, 'localisation', 'russian');
    const file = path.join(directory, 'country_EYE_l_russian.yml');
    await fs.mkdir(directory, { recursive: true });
    const input = 'EYE_all_well_take_back_desc:0 ""Доброжелательность" чужеземцев – их обещания "свободы"."';
    await fs.writeFile(file, `\uFEFFl_russian:\n ${input}\n`, 'utf8');
    const workflow = new KeyReplacementWorkflow({ options: { repo: repository } });
    const preview = await workflow.preview(input);
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.changes[0].oldText, '"Доброжелательность" чужеземцев – их обещания "свободы".');
    await workflow.apply(input, preview.files);
    const result = await fs.readFile(file, 'utf8');
    assert.equal(result.match(/Доброжелательность/gu)?.length, 1);
    assert.equal(result.match(/свободы/gu)?.length, 1);
    assert.match(result, /EYE_all_well_take_back_desc:0 "\\"Доброжелательность\\" чужеземцев – их обещания \\"свободы\\"\."/u);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
