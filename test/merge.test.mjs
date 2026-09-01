import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLocalisationThreeWay } from '../packages/shared/src/merge.mjs';

const base = [
  'l_russian:',
  ' key_one:0 "Первый"',
  ' key_two:0 "Второй"',
  '',
].join('\r\n');

test('three-way merge combines edits to different localisation keys', () => {
  const collaborative = base.replace('"Первый"', '"Совместный"');
  const external = base.replace('"Второй"', '"Из Git"');
  const merged = mergeLocalisationThreeWay(base, collaborative, external);
  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /key_one:0 "Совместный"/);
  assert.match(merged.text, /key_two:0 "Из Git"/);
});

test('three-way merge imports external additions and deletions', () => {
  const collaborative = base.replace('"Первый"', '"Совместный"');
  const external = [
    'l_russian:',
    ' key_one:0 "Первый"',
    ' key_three:0 "Третий"',
    '',
  ].join('\r\n');
  const merged = mergeLocalisationThreeWay(base, collaborative, external);
  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /key_one:0 "Совместный"/);
  assert.doesNotMatch(merged.text, /key_two/);
  assert.match(merged.text, /key_three:0 "Третий"/);
});

test('same-key conflict waits for an explicit choice', () => {
  const collaborative = base.replace('"Первый"', '"Совместный"');
  const external = base.replace('"Первый"', '"Из Git"');
  const unresolved = mergeLocalisationThreeWay(base, collaborative, external);
  assert.equal(unresolved.conflicts.length, 1);
  assert.equal(unresolved.conflicts[0].key, 'key_one');

  const externalChoice = mergeLocalisationThreeWay(base, collaborative, external, {
    key_one: 'external',
  });
  assert.deepEqual(externalChoice.conflicts, []);
  assert.match(externalChoice.text, /key_one:0 "Из Git"/);

  const collaborativeChoice = mergeLocalisationThreeWay(base, collaborative, external, {
    key_one: 'collaborative',
  });
  assert.deepEqual(collaborativeChoice.conflicts, []);
  assert.match(collaborativeChoice.text, /key_one:0 "Совместный"/);
});

test('external comments combine with collaborative key edits', () => {
  const collaborative = base.replace('"Первый"', '"Совместный"');
  const external = base.replace('l_russian:', 'l_russian:\r\n # Новый комментарий');
  const merged = mergeLocalisationThreeWay(base, collaborative, external);
  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /# Новый комментарий/);
  assert.match(merged.text, /key_one:0 "Совместный"/);
});

test('duplicate keys require choosing one complete side', () => {
  const external = base.replace(
    ' key_two:0 "Второй"',
    ' key_one:0 "Повтор из Git"\r\n key_two:0 "Второй"',
  );
  const unresolved = mergeLocalisationThreeWay(base, base, external);
  assert.equal(unresolved.conflicts[0].key, '__duplicate_keys__');

  const accepted = mergeLocalisationThreeWay(base, base, external, {
    __duplicate_keys__: 'external',
  });
  assert.deepEqual(accepted.conflicts, []);
  assert.equal(accepted.text, external);
});
