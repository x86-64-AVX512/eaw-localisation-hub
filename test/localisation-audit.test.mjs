import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditLocalisation, localisationDiffText, localisationInlineComments, localisationStructure,
} from '../apps/agent/src/localisation-audit.mjs';

test('structural lines compare comments and preserve every physical line', () => {
  assert.deepEqual(localisationStructure([
    'l_russian:',
    ' first:0 "Значение # внутри кавычек" # внешний комментарий',
    '# отдельный комментарий',
    '   ',
    ' second:0 "Значение"',
  ].join('\n')), [
    '◆ ЗАГОЛОВОК ЛОКАЛИЗАЦИИ',
    'КЛЮЧ first',
    '# КОММЕНТАРИЙ # отдельный комментарий',
    '␠ ПУСТАЯ СТРОКА',
    'КЛЮЧ second',
  ]);
});

test('structural diff displays localisation-shaped lines together with comments', () => {
  assert.equal(localisationDiffText([
    'l_russian:',
    ' key_name:0 "Перевод" # пояснение',
    '# отдельный комментарий',
    '',
  ].join('\n')), [
    'l_localisation:',
    ' key_name:0 "…"',
    '# отдельный комментарий',
    '',
  ].join('\n'));
});

test('structural comparison reports standalone comments but ignores inline comment differences', () => {
  const russian = localisationStructure('l_russian:\n# один\n key:0 "Да" # старый\n');
  const english = localisationStructure('l_english:\n# два\n key:0 "Yes" # новый\n');
  assert.equal(russian.length, english.length);
  assert.notDeepEqual(russian, english);
  assert.equal(russian[1], '# КОММЕНТАРИЙ # один');
  assert.equal(russian[2], 'КЛЮЧ key');
  assert.equal(english[2], 'КЛЮЧ key');
});

test('inline comment tails remain visible without participating in diff comparison', () => {
  const source = 'l_english:\n jungle.1.t:0 "Soldiers Of Fortune" #Snow #First event\n# отдельный\n';
  assert.deepEqual(localisationInlineComments(source), [
    { line: 2, text: '#Snow #First event' },
  ]);
  assert.doesNotMatch(localisationDiffText(source), /#Snow|#First event/u);
  assert.match(localisationDiffText(source), /# отдельный/u);
});

test('localisation audit reports missing and duplicate keys across language pairs', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-'));
  const russian = path.join(repository, 'localisation', 'russian', 'sample_l_russian.yml');
  const english = path.join(repository, 'localisation', 'english', 'sample_l_english.yml');
  try {
    await fs.mkdir(path.dirname(russian), { recursive: true }); await fs.mkdir(path.dirname(english), { recursive: true });
    await fs.writeFile(russian, 'l_russian:\n shared:0 "Да"\n only_ru:0 "Да"\n shared:0 "Ещё"\n');
    await fs.writeFile(english, 'l_english:\n shared:0 "Yes"\n only_en:0 "Yes"\n');
    const result = await auditLocalisation(repository, russian);
    assert.deepEqual(result.missingInPair, ['only_ru']);
    assert.deepEqual(result.missingInCurrent, ['only_en']);
    assert.deepEqual(result.duplicatesCurrent, [{ key: 'shared', count: 2 }]);
    assert.deepEqual(result.rows.map(({ key, status }) => ({ key, status })), [
      { key: 'shared', status: 'duplicate' },
      { key: 'only_ru', status: 'missing-english' },
      { key: 'only_en', status: 'missing-russian' },
    ]);
    assert.equal(result.rows[0].russian.occurrences.length, 2);
    assert.equal(result.rows[0].english.text, 'Yes');
    assert.equal(result.russianKeyCount, 2);
    assert.equal(result.englishKeyCount, 2);
    assert.equal(result.structureMatches, false);
    assert.doesNotMatch(result.russianDiffText, /КЛЮЧ|ПУСТАЯ СТРОКА/u);
    assert.match(result.russianDiffText, /only_ru:0 "…"/u);
    assert.equal(result.russianStructureText.split('\n').length, result.russianLineCount);
    assert.equal(result.englishStructureText.split('\n').length, result.englishLineCount);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('localisation audit keeps replace files inside the replace language pair', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-replace-'));
  const russian = path.join(repository, 'localisation', 'replace', 'russian', 'sample_l_russian.yml');
  const english = path.join(repository, 'localisation', 'replace', 'english', 'sample_l_english.yml');
  try {
    await fs.mkdir(path.dirname(russian), { recursive: true }); await fs.mkdir(path.dirname(english), { recursive: true });
    await fs.writeFile(russian, 'l_russian:\n shared:0 "Да" #Done\n');
    await fs.writeFile(english, 'l_english:\n shared:0 "Yes" #Snow #First event\n');
    const result = await auditLocalisation(repository, russian);
    assert.equal(result.pairPath, 'localisation/replace/english/sample_l_english.yml');
    assert.equal(result.russianPath, 'localisation/replace/russian/sample_l_russian.yml');
    assert.equal(result.englishPath, 'localisation/replace/english/sample_l_english.yml');
    assert.equal(result.russianKeyCount, 1);
    assert.equal(result.englishKeyCount, 1);
    assert.equal(result.missingInPair.length, 0);
    assert.equal(result.structureMatches, true);
    assert.equal(result.russianDiffText, result.englishDiffText);
    assert.deepEqual(result.russianInlineComments, [{ line: 2, text: '#Done' }]);
    assert.deepEqual(result.englishInlineComments, [{ line: 2, text: '#Snow #First event' }]);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});

test('structural audit detects several independently misplaced blank lines and key order', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-structure-'));
  const russian = path.join(repository, 'localisation', 'russian', 'sample_l_russian.yml');
  const english = path.join(repository, 'localisation', 'english', 'sample_l_english.yml');
  try {
    await fs.mkdir(path.dirname(russian), { recursive: true }); await fs.mkdir(path.dirname(english), { recursive: true });
    await fs.writeFile(russian, 'l_russian:\n first:0 "Один"\n\n second:0 "Два"\n third:0 "Три"\n\n');
    await fs.writeFile(english, 'l_english:\n\n first:0 "One"\n third:0 "Three"\n\n second:0 "Two"\n');
    const result = await auditLocalisation(repository, russian);
    assert.equal(result.russianLineCount, result.englishLineCount);
    assert.equal(result.structureMatches, false);
    assert.notEqual(result.russianStructureText, result.englishStructureText);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});
