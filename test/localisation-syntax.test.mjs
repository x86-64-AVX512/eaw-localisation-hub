import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalisationDiagnostics } from '../packages/shared/src/localisation-syntax.mts';

test('clean versioned and versionless entries, comments and legacy inner quotes stay clean', () => {
  const source = [
    '\uFEFFl_russian:',
    ' event.1.t:0 "Текст # внутри строки" # настоящий комментарий',
    ' event.2.t: "Он сказал "привет""',
    ' event.3.t:0 "Строка\\nи \\"кавычка\\""',
    ' # event.1.t:0 "Закомментировано"',
  ].join('\r\n');
  assert.deepEqual(parseLocalisationDiagnostics(source), []);
});

test('a broken quote is reported on its own line without hiding later errors', () => {
  const diagnostics = parseLocalisationDiagnostics([
    'l_russian:',
    ' first:0 "Не закрыто',
    ' second:0 "Работает"',
    ' third:0 "Плохое \\q значение"',
  ].join('\n'));
  assert.deepEqual(diagnostics.map(({ code, lineNumber }) => [code, lineNumber]), [
    ['unclosed-quote', 2], ['unknown-escape', 4],
  ]);
  assert.equal(diagnostics[0].startColumn, 10);
  assert.equal(diagnostics[1].startColumn, 18);
});

test('duplicate keys ignore the optional numeric version and point to the first occurrence', () => {
  const diagnostics = parseLocalisationDiagnostics([
    'l_russian:',
    ' event.5.d:0 "Первый"',
    ' event.5.d: "Второй"',
    ' event.5.d:3 "Третий"',
  ].join('\n'));
  assert.deepEqual(diagnostics.map(({ code, lineNumber }) => [code, lineNumber]), [
    ['duplicate-key', 3], ['duplicate-key', 4],
  ]);
  assert.equal(diagnostics[0].related.lineNumber, 2);
});

test('only backslashes in values are checked and escaped quotes do not close them', () => {
  const diagnostics = parseLocalisationDiagnostics([
    'l_russian:',
    ' key_one:0 "Путь \\q"',
    ' key_two:0 "Строка с \\"внутренней\\" кавычкой"',
    ' key_three:0 "Конец \\"',
  ].join('\n'));
  assert.deepEqual(diagnostics.map(({ code, lineNumber }) => [code, lineNumber]), [
    ['unknown-escape', 2], ['unclosed-quote', 4],
  ]);
});

test('a missing value quote is diagnosed without interpreting the next line as its continuation', () => {
  const diagnostics = parseLocalisationDiagnostics('l_russian:\n key_one:0 значение\n key_two:0 "ОК"\n');
  assert.deepEqual(diagnostics.map(({ code, lineNumber }) => [code, lineNumber]), [
    ['missing-opening-quote', 2],
  ]);
});

test('common Paradox references, nested colour changes, icons and dynamic expressions stay clean', () => {
  const source = [
    'l_russian:',
    ' EYE_title:0 "§YПривет§G мир§! £pol_power $EYE_other$ [Root.GetName] [?value|%0Y]"',
    ' EYE_other: "§[Root.GetColour]Цвет§! $RIGHT|+=%1$ [!button_click]"',
  ].join('\n');
  assert.deepEqual(parseLocalisationDiagnostics(source), []);
});

test('broken reference and markup delimiters are local warnings', () => {
  const source = [
    'l_russian:',
    ' broken:0 "§? $EYE_other [Root.GetName £ icon"',
    ' reset:0 "§! После сброса"',
    ' colour:0 "§YБез сброса"',
    ' malformed:0 "$EYE other$"',
  ].join('\n');
  const diagnostics = parseLocalisationDiagnostics(source);
  assert.deepEqual(diagnostics.map(({ code, lineNumber }) => [code, lineNumber]), [
    ['invalid-colour-tag', 2], ['unclosed-reference', 2], ['unclosed-command', 2],
    ['invalid-icon-tag', 2], ['stray-colour-reset', 3], ['unclosed-colour-tag', 4],
    ['malformed-reference', 5],
  ]);
});

test('mod-local key existence is checked conservatively and includes later keys in the file', () => {
  const source = [
    'l_russian:',
    ' EYE_first:0 "$EYE_second$ $EYE_typo$ $infantry_leader$ $VALUE$"',
    ' EYE_second:0 "Есть"',
  ].join('\n');
  const diagnostics = parseLocalisationDiagnostics(source, {
    knownKeys: new Set(['EYE_first']), knownPrefixes: new Set(['EYE']),
  });
  assert.deepEqual(diagnostics.map(({ code, severity }) => [code, severity]), [
    ['unresolved-local-reference', 'info'],
  ]);
  assert.equal(diagnostics[0].lineNumber, 2);
});

test('the first meaningful line must contain the header matching the opened file', () => {
  const filePath = 'localisation/russian/country_EYE_l_russian.yml';
  const check = (source, path = filePath) => parseLocalisationDiagnostics(source, { filePath: path })
    .map((issue) => issue.code);
  assert.deepEqual(check(' TEST:0 "Текст"'), ['missing-header']);
  assert.deepEqual(check('l_russian\n TEST:0 "Текст"'), ['malformed-header']);
  assert.deepEqual(check('l_english:\n TEST:0 "Текст"'), ['wrong-language-header']);
  assert.deepEqual(check('\uFEFF# комментарий\n\n l_russian:\n TEST:0 "Текст"'), []);
  assert.deepEqual(check('l_english:\n TEST:0 "Text"', 'localisation/english/test_l_english.yml'), []);
  assert.deepEqual(check('l_russian:\n TEST:0 "Текст"', 'localisation/replace/russian/test_l_russian.yml'), []);
  assert.deepEqual(check(''), ['missing-header']);
});

test('valid HOI4 reference, variable, colour and icon forms are not diagnosed', () => {
  const values = [
    '$OTHER_KEY$', '$COUNTRY|H$', '$VALUE|0$', '$VALUE|%0$', '$VALUE|+0$',
    '$VALUE|+=%0$', '$VALUE|$',
    '§YЖёлтый§! §Gзелёный§!', '§YЖёлтый §Gзелёный§!', '§Y$OTHER_KEY$§!',
    '[GetSomething]', '[Root.GetName]', '[Root.GetNameDef]', '[From.GetAdjective]',
    '[?my_variable]', '[?ROOT.my_variable]', '[?value|G0]', '[?MIT_cost|+=2Y]',
    '[?modifier@some_modifier|+=%0]', '[?.Root.party_popularity@democratic|%0G]',
    '[?ABY_parliament_seats_array^0]', '[?ABY_prov_@var:prov_v^current_state.GetName]',
    '[?ZAI_mane_six_mana^m6_idx|0|%%]', '[3.OWNER.GetNameDef]', '[!button_click]',
    '£pol_power $VALUE|0$', '£faction_initiative_texticon£ $VALUE|0$',
    '£pol_power£ $VALUE|0$',
    '§Y$TITLE$§!\\n§G[GetSomething]§!\\n[?ROOT.value|+%0]',
  ];
  for (const value of values) assert.deepEqual(
    parseLocalisationDiagnostics(`l_russian:\n TEST:0 "${value}"`), [], value,
  );
});

test('broken reference, bracket and variable forms have independent diagnostics', () => {
  const cases = [
    ['$OTHER_KEY', 'unclosed-reference'],
    ['OTHER_KEY$', 'orphan-reference-end'],
    ['$$', 'empty-reference'],
    ['$OTHER KEY$', 'malformed-reference'],
    ['$COUNTRY|H', 'unclosed-reference'],
    ['$VALUE|%x$', 'suspicious-reference-formatter'],
    ['$VALUE|+=%0', 'unclosed-reference'],
    ['§YТекст', 'unclosed-colour-tag'],
    ['Текст§!', 'stray-colour-reset'],
    ['§Y$OTHER_KEY§!', 'unclosed-reference'],
    ['[GetSomething', 'unclosed-command'],
    ['GetSomething]', 'orphan-dynamic-end'],
    ['[Root.GetName', 'unclosed-command'],
    ['[Root..GetNameDef]', 'malformed-scope-access'],
    ['[From.]', 'malformed-scope-access'],
    ['[]', 'empty-dynamic-loc'],
    ['[ GetSomething ]', 'dynamic-loc-whitespace'],
    ['[[GetSomething]]', 'nested-dynamic-loc'],
    ['[?my_variable', 'unclosed-variable'],
    ['[?ROOT.]', 'malformed-variable'],
    ['[?value|G0', 'unclosed-variable'],
    ['[?modifier@|+=%0]', 'malformed-variable'],
    ['[?value|]', 'malformed-variable-format'],
    ['[!button_click', 'unclosed-command'],
    ['Строка 1\\qСтрока 2', 'unknown-escape'],
    ['$TITLE: [Root.GetName]', 'unclosed-reference'],
    ['§Y[Root.GetName§!', 'unclosed-command'],
    ['§G[?bonus|+%0§!', 'unclosed-variable'],
  ];
  for (const [value, expected] of cases) {
    const codes = parseLocalisationDiagnostics(`l_russian:\n TEST:0 "${value}"`).map((issue) => issue.code);
    assert.ok(codes.includes(expected), `${value}: expected ${expected}, got ${codes}`);
  }
  const combined = parseLocalisationDiagnostics(
    'l_russian:\n TEST:0 "§Y$TITLE§!\\n[Root.GetName: [?value|G0]"',
  ).map((issue) => issue.code);
  assert.ok(combined.includes('unclosed-reference'));
  assert.ok(combined.includes('nested-dynamic-loc'));
});
