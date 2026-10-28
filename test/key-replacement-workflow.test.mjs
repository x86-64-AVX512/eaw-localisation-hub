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

test('mixed-version duplicates in one file block the whole batch without writing', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-duplicate-file-'));
  try {
    const directory = path.join(repository, 'localisation', 'russian');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'country.yml');
    const original = 'l_russian:\n repeated:0 "first"\n repeated: "second"\n safe:0 "old"\n';
    await fs.writeFile(file, original, 'utf8');
    const workflow = new KeyReplacementWorkflow({ options: { repo: repository } });
    const input = 'repeated:0 "new"\nsafe:0 "updated"';
    const preview = await workflow.preview(input);
    assert.deepEqual(preview.duplicateMatches.map(({ key, matches }) => ({
      key, lines: matches.map(({ line }) => line),
    })), [{ key: 'repeated', lines: [2, 3] }]);
    assert.deepEqual(preview.changes.map(({ key }) => key), ['safe']);
    await assert.rejects(workflow.apply(input, preview.files), /Предпросмотр содержит ошибки/u);
    assert.equal(await fs.readFile(file, 'utf8'), original);
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

async function experimentalFixture(t) {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-filter-'));
  t.after(()=>fs.rm(repository,{recursive:true,force:true}));
  const file=path.join(repository,'localisation/russian/a.yml');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.mkdir(path.join(repository,'localisation/english'),{recursive:true});
  const original='\uFEFFl_russian:\r\n key:0 "Старое" # заметка\r\n neutral: "123"\r\n';
  await fs.writeFile(file,original);
  const english=path.join(repository,'localisation/english/a.yml');
  await fs.writeFile(english,'l_english:\n key:0 "Untouched"\n');
  return {repository,file,original,english,workflow:new KeyReplacementWorkflow({options:{repo:repository}})};
}

test('experimental apply reuses the filter and keeps destination formatting and other languages', async t=>{
  const s=await experimentalFixture(t);
  const input='#Оригинал:\nkey: "Original"\n#Перевод:\nkey: "Новый текст" # comment\nabsent: "Foreign ignored"\nneutral: "456"';
  const preview=await s.workflow.preview(input,'russian','language-filtered');
  assert.deepEqual(preview.errors,[]); assert.deepEqual(preview.missingKeys,[]);
  assert.equal(preview.ignoredEntries.length,2); assert.equal(preview.changes.length,2);
  await s.workflow.apply(input,preview.files,'russian','language-filtered');
  assert.equal(await fs.readFile(s.file,'utf8'),s.original.replace('Старое','Новый текст').replace('123','456'));
  assert.match(await fs.readFile(s.english,'utf8'),/Untouched/u);
});

test('same-language and neutral duplicates block the whole experimental batch',async t=>{
  const s=await experimentalFixture(t);
  for(const input of ['key: "Первый"\nkey: "Второй"','neutral: "123"\nneutral: "456"']){
    const preview=await s.workflow.preview(input,'russian','language-filtered');
    assert.equal(preview.duplicateKeys.length,1);
    await assert.rejects(s.workflow.apply(input,preview.files,'russian','language-filtered'),/Предпросмотр содержит ошибки/u);
    assert.equal(await fs.readFile(s.file,'utf8'),s.original);
  }
});

test('experimental filtering never hides destination duplicates or stale file hashes', async t=>{
  const s=await experimentalFixture(t);
  const input='key: "English original"\nkey: "Новый текст"';
  const preview=await s.workflow.preview(input,'russian','language-filtered');
  await fs.appendFile(s.file,' key:0 "Ещё вхождение"\r\n');
  await assert.rejects(s.workflow.apply(input,preview.files,'russian','language-filtered'),/Предпросмотр содержит ошибки/u);
  await fs.writeFile(s.file,s.original+' # intervening change\r\n');
  await assert.rejects(s.workflow.apply(input,preview.files,'russian','language-filtered'),/Файлы изменились/u);
});

test('empty filtered batches are no-ops and classic apply cannot accidentally reuse an experimental batch', async t=>{
  const s=await experimentalFixture(t);
  const empty=await s.workflow.preview('# comment\nmissing: "English"','russian','language-filtered');
  assert.deepEqual(empty.files,[]); assert.deepEqual(empty.missingKeys,[]);
  assert.deepEqual(await s.workflow.apply('missing: "English"',[],'russian','language-filtered'),{changedKeys:0,changedFiles:0});
  const mixed='key: "English"\nkey: "Новый"';
  const preview=await s.workflow.preview(mixed,'russian','language-filtered');
  await assert.rejects(s.workflow.apply(mixed,preview.files),/Предпросмотр содержит ошибки/u);
  assert.equal(await fs.readFile(s.file,'utf8'),s.original);
});

test('an ambiguous input blocks every experimental write and escaped input applies intact', async t => {
  const s=await experimentalFixture(t);
  const input='key: "Цвет "#1" лучший"\nneutral: "456"';
  const preview=await s.workflow.preview(input,'russian','language-filtered');
  assert.equal(preview.errors.length,1); assert.equal(preview.errors[0].line,1);
  assert.deepEqual(preview.files,[]);
  await assert.rejects(s.workflow.apply(input,[],'russian','language-filtered'),/Предпросмотр содержит ошибки/u);
  assert.equal(await fs.readFile(s.file,'utf8'),s.original);
  const fixed='key: "Цвет \\"#1\\" лучший"';
  const safe=await s.workflow.preview(fixed,'russian','language-filtered');
  await s.workflow.apply(fixed,safe.files,'russian','language-filtered');
  assert.equal(await fs.readFile(s.file,'utf8'),s.original.replace('Старое','Цвет \\"#1\\" лучший'));
  const again=await s.workflow.preview('key: "Повторная замена"','russian','language-filtered');
  assert.equal(again.changes[0].oldText,'Цвет \\"#1\\" лучший');
  await s.workflow.apply('key: "Повторная замена"',again.files,'russian','language-filtered');
  assert.equal(await fs.readFile(s.file,'utf8'),s.original.replace('Старое','Повторная замена'));
});

for(const mode of ['classic','language-filtered']) test(`${mode} reports a selected ambiguous repository value and leaves the entire batch unchanged`,async t=>{
  const s=await experimentalFixture(t);
  const bad=s.original.replace('Старое','Цвет "#1" лучший');
  const second=path.join(path.dirname(s.file),'b.yml'),other='\uFEFFl_russian:\n other:0 "Прежнее"\n';
  await fs.writeFile(s.file,bad);await fs.writeFile(second,other);
  const input='key: "Новое"\nneutral: "456"\nother: "Другой текст"';
  const preview=await s.workflow.preview(input,'russian',mode);
  assert.equal(preview.errors.length,1);
  assert.deepEqual({file:preview.errors[0].file,key:preview.errors[0].key,line:preview.errors[0].line},
    {file:'localisation/russian/a.yml',key:'key',line:2});
  assert.match(preview.errors[0].message,/Неоднозначные кавычки/u);
  assert.deepEqual(preview.missingKeys,[]);assert.deepEqual(preview.changes,[]);assert.deepEqual(preview.files,[]);
  await assert.rejects(s.workflow.apply(input,[],'russian',mode),/Предпросмотр содержит ошибки/u);
  assert.equal(await fs.readFile(s.file,'utf8'),bad);assert.equal(await fs.readFile(second,'utf8'),other);
});

test('an unrelated ambiguous key in a repository file does not block a selected safe key',async t=>{
  const s=await experimentalFixture(t);
  const original=s.original+' unused:0 "Цвет "#1" лучший"\r\n';
  await fs.writeFile(s.file,original);
  const preview=await s.workflow.preview('key: "Новое"');
  assert.deepEqual(preview.errors,[]);
  await s.workflow.apply('key: "Новое"',preview.files);
  assert.equal(await fs.readFile(s.file,'utf8'),original.replace('Старое','Новое'));
});

test('an external change introducing ambiguous quotes after preview is not overwritten',async t=>{
  const s=await experimentalFixture(t);
  const preview=await s.workflow.preview('key: "Новое"');
  const changed=s.original.replace('Старое','Цвет "#1" лучший');
  await fs.writeFile(s.file,changed);
  await assert.rejects(s.workflow.apply('key: "Новое"',preview.files),/Предпросмотр содержит ошибки/u);
  assert.equal(await fs.readFile(s.file,'utf8'),changed);
});
