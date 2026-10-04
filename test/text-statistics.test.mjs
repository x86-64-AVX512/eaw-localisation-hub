import assert from 'node:assert/strict';
import test from 'node:test';
import { createTextStatisticsAction, localisationValueStatistics } from '../apps/review/src/text-statistics.ts';
import { getUiLanguage, setUiLanguage, uiText } from '../packages/shared/src/ui-language.mts';

test('counts the source value only, with optional version, Unicode and whitespace', () => {
  for (const prefix of [' KEY:0 ', ' KEY: ', '\uFEFF\tKEY:12', ' KEY:0']) {
    assert.deepEqual(localisationValueStatistics(`${prefix}"Привет 🦄" # ignored "quotes"`),
      { key: 'KEY', characters: 8, withoutWhitespace: 7 });
  }
  assert.deepEqual(localisationValueStatistics('empty:0 ""'), { key: 'empty', characters: 0, withoutWhitespace: 0 });
  assert.deepEqual(localisationValueStatistics('spaces: " a\t\u00A0b "'), { key: 'spaces', characters: 6, withoutWhitespace: 2 });
  assert.equal(localisationValueStatistics('key: "e\u0301"').characters, 2, 'count code points, not grapheme clusters');
});

test('escaped and legacy inner quotes belong to the value; literal escape sequences remain source text', () => {
  for (const value of ['A "quote" here', 'A \\"quote\\" here', 'literal\\nnewline', 'ends with slash\\\\', '"inner"']) {
    assert.deepEqual(localisationValueStatistics(`key:0 "${value}" # "comment"`), {
      key: 'key', characters: [...value].length, withoutWhitespace: [...value].filter(c => !/\s/u.test(c)).length,
    });
  }
});

test('dynamic localisation and formatting are counted literally without interpretation or expansion', () => {
  const value = '§Y$FOCUS_NAME$§! [Root.GetName] £icon£ \\n';
  assert.equal(localisationValueStatistics(`key: "${value}"`).characters, [...value].length);
  assert.equal(localisationValueStatistics('unsafe: "<img src=x onerror=alert(1)>"').characters, 28);
});

test('comments, headers, malformed values and an escaped final quote are not counted as complete entries', () => {
  for (const line of ['# key:0 "comment"', 'l_russian:', '', ' key:0 unquoted', ' key:0 "unclosed',
    ' key:0 "ends in escaped quote\\"', ' key:0 "value" garbage', ' key:0 "value" #comment'.replace('key:', 'bad key:')]) {
    assert.equal(localisationValueStatistics(line), null, line);
  }
});

function setup(lines = ['l_russian:', 'one:0 "Один"', 'two: "Two words"']) {
  const results = [], notices = [], listeners = {}, disposed = [];
  let descriptor, position = 2;
  const model = { getLineCount: () => lines.length, getLineContent: (line) => lines[line - 1] };
  const subscribe = name => fn => { listeners[name] = fn; return { dispose: () => disposed.push(name) }; };
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: position }),
    onContextMenu: subscribe('context'), onDidChangeCursorPosition: subscribe('cursor'),
    onDidChangeModel: subscribe('model'), addAction(value) { descriptor = value; return { dispose: () => disposed.push('action') }; } };
  const controller = createTextStatisticsAction({ editor, showToast: (text, error) => notices.push({ text, error }),
    showResult: statistics => results.push(statistics) });
  return { controller, results, notices, listeners, model, disposed,
    action: () => descriptor, move: line => { position = line; listeners.cursor(); } };
}

test('context action counts the right-clicked line, while command-palette invocation uses the cursor', () => {
  const s = setup();
  assert.equal(s.action().label, 'Посчитать символы в строке');
  assert.equal(s.action().precondition, undefined, 'must remain available offline and read-only');
  s.listeners.context({ target: { position: { lineNumber: 3 } } }); s.action().run();
  assert.deepEqual(s.results[0], { lineNumber: 3, key: 'two', characters: 9, withoutWhitespace: 8 });
  s.action().run(); assert.equal(s.results[1].lineNumber, 2);
  s.listeners.context({ target: { position: { lineNumber: 3 } } }); s.move(2); s.action().run();
  assert.equal(s.results[2].lineNumber, 2);
});

test('invalid lines and stale context positions fail safely; counting never changes model contents', () => {
  const s = setup();
  s.move(1); s.action().run(); assert.equal(s.results.length, 0); assert.equal(s.notices[0].error, true);
  s.listeners.context({ target: { position: { lineNumber: 999 } } }); s.action().run();
  assert.equal(s.results.length, 0);
  s.move(2); s.listeners.context({ target: { position: { lineNumber: 3 } } }); s.listeners.model();
  s.action().run(); assert.equal(s.results[0].lineNumber, 2); assert.equal(s.model.getLineContent(2), 'one:0 "Один"');
  s.controller.dispose(); s.controller.run(); assert.equal(s.results.length, 1);
  assert.deepEqual(s.disposed, ['context', 'cursor', 'model', 'action']);
});

test('statistics labels support English and keep localisation keys opaque', () => {
  const language = getUiLanguage();
  try {
    setUiLanguage('en'); const s = setup();
    assert.equal(s.action().label, 'Count characters in line');
    assert.equal(uiText('Строка {0} · {1}', 7, 'Закрыть'), 'Line 7 · Закрыть');
    assert.equal(uiText('Между кавычками: {0} символов', 42), 'Between quotes: 42 characters');
    s.controller.dispose();
  } finally { setUiLanguage(language); }
});
