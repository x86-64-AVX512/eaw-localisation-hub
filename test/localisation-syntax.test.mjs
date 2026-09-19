import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalisationDiagnostics } from '../packages/shared/src/localisation-syntax.mjs';

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
