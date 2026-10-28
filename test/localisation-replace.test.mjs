import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localisationEntries, scanLocalisationEntries, parseKeyReplacementBatch, replaceLocalisationValues,
} from '../packages/shared/src/localisation-replace.mts';
import { replacementLanguageProfile } from '../packages/shared/src/key-replacement-language.mts';

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

test('batch key parser preserves Russian guillemets and escapes only ASCII quotes', () => {
  const parsed = parseKeyReplacementBatch(
    'EYE_quote:0 "Он сказал: «да», а затем "нет"."',
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.entries[0].text, 'Он сказал: «да», а затем \\"нет\\".');
  const changed = replaceLocalisationValues('l_russian:\n EYE_quote:0 "Старый текст"\n', new Map([
    ['EYE_quote', parsed.entries[0].text],
  ]));
  assert.equal(changed.text, 'l_russian:\n EYE_quote:0 "Он сказал: «да», а затем \\"нет\\"."\n');
  assert.doesNotMatch(changed.text, /\\[«»]/u);
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

test('source parser replaces versionless entries and detects mixed-version duplicates', () => {
  const source = 'l_russian:\n key: "old"\n duplicate:0 "first"\n duplicate: "second"\n';
  assert.deepEqual(localisationEntries(source).map(({ key, text }) => ({ key, text })), [
    { key: 'key', text: 'old' },
    { key: 'duplicate', text: 'first' },
    { key: 'duplicate', text: 'second' },
  ]);
  const changed = replaceLocalisationValues(source, new Map([['key', 'новое']]));
  assert.equal(changed.text, 'l_russian:\n key: "новое"\n duplicate:0 "first"\n duplicate: "second"\n');
});

test('low-level replacement refuses an ambiguous key before changing either occurrence', () => {
  const source = 'l_russian:\n repeated:0 "first"\n repeated: "second"\n safe:0 "old"\n';
  assert.deepEqual(localisationEntries(source).filter(({ key }) => key === 'repeated')
    .map(({ line }) => line), [2, 3]);
  assert.throws(() => replaceLocalisationValues(source, new Map([
    ['repeated', 'new'], ['safe', 'updated'],
  ])), /встречается в файле несколько раз/u);
  assert.equal(replaceLocalisationValues(source, new Map([['safe', 'updated']])).text,
    source.replace('safe:0 "old"', 'safe:0 "updated"'));
});

const filtered = (text, language = 'russian') => parseKeyReplacementBatch(text, { mode: 'language-filtered', language });

test('classic remains the default, including its comment and duplicate errors', () => {
  const source = '# Перевод:\nkey: "Original"\nkey: "Перевод"';
  assert.deepEqual(parseKeyReplacementBatch(source), parseKeyReplacementBatch(source, {mode:'classic'}));
  assert.equal(parseKeyReplacementBatch(source).errors[0].line, 1);
  assert.deepEqual(parseKeyReplacementBatch(source).duplicateKeys, ['key']);
});

test('filtering removes foreign values before duplicate checks in either target language', () => {
  const source = 'same: "Look for Silver Star"\nsame:0 "Отыскать Сильвер Стара"';
  for (const language of ['russian','english']) {
    const result = filtered(source, language);
    assert.deepEqual(result.errors, []); assert.deepEqual(result.duplicateKeys, []);
    assert.equal(result.entries.length, 1); assert.equal(result.ignoredEntries.length, 1);
    assert.equal(result.entries[0].line, language === 'russian' ? 2 : 1);
  }
});

test('eligible duplicates remain errors even if their texts are identical or marked as originals', () => {
  for (const source of ['key: "Первый"\nkey: "Второй"', 'key: "Первый"\nkey: "Первый"',
    '#Оригинал:\nkey: "Первый"\n#Перевод:\nkey: "Второй"']) {
    assert.deepEqual(filtered(source).duplicateKeys, ['key']);
  }
  assert.deepEqual(filtered('key: "First"\nkey: "Second"', 'english').duplicateKeys, ['key']);
});

test('neutral values are kept and their duplicates are never silently selected by headings', () => {
  for (const value of ['123', '$COUNTRY$', '[Root.GetName]', 'АA', '', '日本語']) {
    const result = filtered(`key: "${value}"`);
    assert.equal(result.entries[0].text, value); assert.deepEqual(result.ignoredEntries, []);
    assert.deepEqual(filtered(`#Оригинал:\nkey: "${value}"\n#Перевод:\nkey: "${value}"`).duplicateKeys, ['key']);
  }
});

test('comments are omitted only outside values; inner quotes and escapes survive', () => {
  const result = filtered('\uFEFF# comment with key: "English"\r\nkey:0 "Русский #текст и "кавычки"." # English "comment".\r\n# Another comment');
  assert.deepEqual(result.errors, []); assert.equal(result.ignoredComments, 3);
  assert.equal(result.entries[0].line, 2);
  assert.equal(result.entries[0].text, 'Русский #текст и \\"кавычки\\".');
  assert.equal(filtered('key: "Текст \\"кавычки\\"" # ignored').entries[0].text, 'Текст \\"кавычки\\"');
  assert.equal(filtered('key: "Незакрыто # не комментарий').errors[0].line, 1);
});

test('language percentages exclude technical identifiers, colours, escapes and the key', () => {
  const value = '§RЁж§! [Root.GetVeryLongEnglishGetter] $ENGLISH_REFERENCE|Y$ £GFX_english_icon£ \\n';
  assert.deepEqual(replacementLanguageProfile(value), {language:'russian',cyrillicPercent:100,latinPercent:0});
  assert.equal(filtered(`A_VERY_LONG_ENGLISH_KEY: "${value}"`).entries.length, 1);
  assert.equal(replacementLanguageProfile('áéî').language, 'english');
  assert.equal(replacementLanguageProfile('АA').language, 'neutral');
  assert.deepEqual(replacementLanguageProfile('яяA'), {language:'russian',cyrillicPercent:66.7,latinPercent:33.3});
});

test('review template headings label English originals without overriding detected Russian text', () => {
  const result = filtered('#Оригинал:\nkey: "Original"\n# other comment\n#Перевод:\nkey: "Перевод"\n#Оригинал:\nnext: "English"\n#Перевод:\nnext: "Русский"');
  assert.deepEqual(result.entries.map(entry=>entry.key), ['key','next']);
  assert.deepEqual(result.duplicateKeys, []);
  assert.deepEqual(result.ignoredEntries.map(entry=>entry.reason), ['original-section','original-section']);
  assert.equal(filtered('#Перевод:\nkey: "Entirely English"').entries.length, 0);
});

test('invalid modes, scopes and malformed selected records fail explicitly', () => {
  assert.throws(()=>parseKeyReplacementBatch('key: "x"',{mode:'guess'}), /Неизвестный режим/u);
  assert.throws(()=>parseKeyReplacementBatch('key: "x"',{language:'german'}), /Выберите/u);
  assert.equal(filtered('#Перевод:\ninvalid').errors[0].line, 2);
});

test('ambiguous hash after a legacy inner quote is rejected instead of truncating the value', () => {
  for (const line of ['K: "Цвет "#1" лучший"', 'K: "Цвет "#1" лучший" # заметка',
    'K: "Текст" # заметка "цитата"']) {
    const result = filtered(line);
    assert.deepEqual(result.entries, []); assert.equal(result.errors[0].line, 1);
    assert.match(result.errors[0].message, /Неоднозначные кавычки/u);
    assert.deepEqual(result.ignoredEntries, []);
  }
  assert.equal(parseKeyReplacementBatch('K: "Цвет "#1" лучший"').entries[0].text, 'Цвет \\"#1\\" лучший');
});

test('escaped hashes, ordinary inline comments and double backslashes remain unambiguous', () => {
  for (const tail of ['', ' # заметка']) {
    const result = filtered('K: "Цвет \\"#1\\" лучший"' + tail);
    assert.deepEqual(result.errors, []); assert.equal(result.entries[0].text, 'Цвет \\"#1\\" лучший');
  }
  assert.equal(filtered('K: "Текст" # заметка').entries[0].text, 'Текст');
  assert.equal(filtered('K: "«#1» лучший"').entries[0].text, '«#1» лучший');
  assert.equal(filtered('K: "Путь \\\\" # заметка').entries[0].text, 'Путь \\\\');
});

test('escaped hash quotes are read completely from disk and a repeated replacement leaves no old tail', () => {
  const source='l_russian:\n K:0 "Цвет \\"#1\\" лучший" # заметка\n';
  assert.equal(localisationEntries(source)[0].text,'Цвет \\"#1\\" лучший');
  const next=replaceLocalisationValues(source,new Map([['K','Другая строка']]));
  assert.equal(next.text,'l_russian:\n K:0 "Другая строка" # заметка\n');
});

test('repository scan reports ambiguous keys with their actual line instead of a truncated value', () => {
  const text='\uFEFFl_russian:\r\n K:0 "Цвет "#1" лучший"\r\n safe:0 "Старое" # заметка\r\n';
  const scanned=scanLocalisationEntries(text);
  assert.deepEqual(scanned.ambiguousEntries,[{key:'K',line:2}]);
  assert.deepEqual(scanned.entries.map(({key,text,line})=>({key,text,line})),[{key:'safe',text:'Старое',line:3}]);
  assert.equal(localisationEntries(text).some(entry=>entry.key==='K'),false);
});

test('low-level replacement rejects a selected ambiguous repository value but preserves unrelated ones', () => {
  const text='l_russian:\n K:0 "Цвет "#1" лучший"\n safe:0 "Старое"\n';
  assert.throws(()=>replaceLocalisationValues(text,new Map([['safe','Новое'],['K','Новое']])),/Неоднозначные кавычки.*K.*2/u);
  assert.equal(replaceLocalisationValues(text,new Map([['safe','Новое']])).text,text.replace('safe:0 "Старое"','safe:0 "Новое"'));
});
