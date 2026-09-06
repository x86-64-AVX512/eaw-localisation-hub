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

test('moving a blank or comment relative to keys survives an independent Git value edit', () => {
  const original = 'l_russian:\n\n a:0 "A"\n # anchored\n b:0 "B"\n';
  const moved = 'l_russian:\n a:0 "A"\n\n # anchored\n b:0 "B"\n';
  const external = original.replace('"B"', '"Git"');
  const merged = mergeLocalisationThreeWay(original, moved, external);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.text, moved.replace('"B"', '"Git"'));
});

test('a pure key reorder is structural and competing reorders require a choice', () => {
  const original = 'l_russian:\n a:0 "A"\n b:0 "B"\n c:0 "C"\n';
  const moved = 'l_russian:\n b:0 "B"\n a:0 "A"\n c:0 "C"\n';
  const git = 'l_russian:\n a:0 "A"\n c:0 "C"\n b:0 "B"\n';
  assert.equal(mergeLocalisationThreeWay(original, original, moved).text, moved);
  assert.equal(mergeLocalisationThreeWay(original, moved, git).conflicts[0].key, '__file_structure__');
  assert.equal(mergeLocalisationThreeWay(original, moved, git, { __file_structure__: 'external' }).text, git);
});

test('independent key additions do not create artificial layout conflicts', () => {
  const original = 'l_russian:\n a:0 "A"\n';
  const merged = mergeLocalisationThreeWay(original,
    `${original} mine:0 "Mine"\n`, `${original} git:0 "Git"\n`);
  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /mine:0 "Mine"/u);
  assert.match(merged.text, /git:0 "Git"/u);
});
