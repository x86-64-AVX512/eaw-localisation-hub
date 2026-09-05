import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localisationEntries, parseKeyReplacementBatch, replaceLocalisationValues,
} from '../packages/shared/src/localisation-replace.mjs';

test('batch key parser accepts numbered and unnumbered entries', () => {
  const parsed = parseKeyReplacementBatch('one:0 "Первый"\ntwo: "Второй \\"текст\\""');
  assert.deepEqual(parsed, {
    entries: [
      { key: 'one', text: 'Первый', line: 1 },
      { key: 'two', text: 'Второй \\"текст\\"', line: 2 },
    ],
    errors: [], duplicateKeys: [],
  });
});

test('batch key parser safely escapes ordinary quotes inside a value', () => {
  const parsed = parseKeyReplacementBatch('EYE_desc:0 ""Доброжелательность" и обещания "свободы"."');
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries[0].text, '\\"Доброжелательность\\" и обещания \\"свободы\\".');
  const changed = replaceLocalisationValues('l_russian:\n EYE_desc:0 "Старый текст"\n', new Map([
    ['EYE_desc', parsed.entries[0].text],
  ]));
  assert.equal(changed.text, 'l_russian:\n EYE_desc:0 "\\"Доброжелательность\\" и обещания \\"свободы\\"."\n');
});

test('batch key parser round-trips the reported EYE value without duplication', () => {
  const input = 'EYE_all_well_take_back_desc:0 ""Доброжелательность" чужеземцев – лишь тонкая вуаль, скрывающая неудержимую жажду грабежа и порабощения; их обещания "свободы" – жалкое оправдание для уничтожения самой самобытности йети. Мы не потерпим такого унижения."';
  const parsed = parseKeyReplacementBatch(input);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries.length, 1);
  const source = `l_russian:\n ${input}\n`;
  const changed = replaceLocalisationValues(source, new Map([
    [parsed.entries[0].key, parsed.entries[0].text],
  ]));
  assert.equal(changed.matches.length, 1);
  assert.equal(changed.text.match(/Доброжелательность/gu)?.length, 1);
  assert.equal(changed.text.match(/свободы/gu)?.length, 1);
  assert.equal(changed.text, `l_russian:\n EYE_all_well_take_back_desc:0 "${parsed.entries[0].text}"\n`);
});

test('source parser consumes a complete legacy value with unescaped inner quotes', () => {
  const source = 'l_russian:\n EYE_desc:0 ""Начало" и обещание "свободы"." # заметка\n';
  assert.deepEqual(localisationEntries(source).map(({ key, text }) => ({ key, text })), [
    { key: 'EYE_desc', text: '"Начало" и обещание "свободы".' },
  ]);
  const changed = replaceLocalisationValues(source, new Map([['EYE_desc', 'Новый текст']]));
  assert.equal(changed.text, 'l_russian:\n EYE_desc:0 "Новый текст" # заметка\n');
});

test('batch key parser preserves already escaped quotes and rejects an unclosed value', () => {
  const parsed = parseKeyReplacementBatch('one:0 "Текст \\"в кавычках\\""\ntwo:0 "не закрыто');
  assert.equal(parsed.entries[0].text, 'Текст \\"в кавычках\\"');
  assert.equal(parsed.errors[0].line, 2);
});

test('batch key parser reports malformed and duplicate entries', () => {
  const parsed = parseKeyReplacementBatch('one: "a"\nbroken\none:0 "b"');
  assert.equal(parsed.errors[0].line, 2);
  assert.deepEqual(parsed.duplicateKeys, ['one']);
});

test('localisation replacement changes only quoted values', () => {
  const source = 'l_russian:\n key:0 "old" # note\n key_desc:12 "old desc"\n';
  assert.deepEqual(localisationEntries(source).map(({ key, text }) => ({ key, text })), [
    { key: 'key', text: 'old' }, { key: 'key_desc', text: 'old desc' },
  ]);
  const changed = replaceLocalisationValues(source, new Map([
    ['key', 'новое'], ['key_desc', 'описание'],
  ]));
  assert.equal(changed.text, 'l_russian:\n key:0 "новое" # note\n key_desc:12 "описание"\n');
});
