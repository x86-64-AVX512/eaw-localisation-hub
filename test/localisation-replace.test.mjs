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
