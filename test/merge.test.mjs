import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localisationSelectionChanges,
  mergeLocalisationThreeWay,
  setLocalisationSelection,
} from '../packages/shared/src/merge.mjs';

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

test('three-way merge recognises localisation keys without a version number', () => {
  const versionlessBase = [
    'l_russian:',
    ' key_one: "Первый"',
    ' key_two: "Второй"',
    '',
  ].join('\r\n');
  const collaborative = versionlessBase.replace('"Первый"', '"Совместный"');
  const external = versionlessBase.replace('"Второй"', '"Из Git"');
  const merged = mergeLocalisationThreeWay(versionlessBase, collaborative, external);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.text, collaborative.replace('"Второй"', '"Из Git"'));
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

test('local-file selections independently include and remove shared key changes', () => {
  const shared = base.replace('"Первый"', '"Совместный"').replace('"Второй"', '"Принятый"');
  const oneIncluded = setLocalisationSelection(base, shared, base, 'key:key_one', true);
  assert.match(oneIncluded, /key_one:0 "Совместный"/u);
  assert.match(oneIncluded, /key_two:0 "Второй"/u);
  const changes = localisationSelectionChanges(base, shared, oneIncluded).entries;
  assert.equal(changes.find(({ key }) => key === 'key_one').state, 'included');
  assert.equal(changes.find(({ key }) => key === 'key_two').state, 'excluded');
  assert.equal(setLocalisationSelection(base, shared, oneIncluded, 'key:key_one', false), base);
});

test('local-file selections preserve custom local keys while toggling another shared change', () => {
  const shared = base.replace('"Первый"', '"Совместный"');
  const custom = base.replace('"Второй"', '"Локальный"');
  const selected = setLocalisationSelection(base, shared, custom, 'key:key_one', true);
  assert.match(selected, /key_one:0 "Совместный"/u);
  assert.match(selected, /key_two:0 "Локальный"/u);
});

test('local-file selections support shared additions and deletions', () => {
  const shared = base.replace(' key_two:0 "Второй"\r\n', '') + ' key_three:0 "Третий"\r\n';
  let selected = setLocalisationSelection(base, shared, base, 'key:key_two', true);
  assert.doesNotMatch(selected, /key_two/u);
  selected = setLocalisationSelection(base, shared, selected, 'key:key_three', true);
  assert.match(selected, /key_three:0 "Третий"/u);
  const changes = localisationSelectionChanges(base, shared, selected).entries;
  assert.ok(changes.every(({ state }) => state === 'included'));
});

test('an added key is one independent selection and keeps its shared position', () => {
  const git = 'l_russian:\n a:0 "A"\n c:0 "C"\n';
  const shared = 'l_russian:\n a:0 "A"\n b:0 "B"\n c:0 "C"\n';
  const changes = localisationSelectionChanges(git, shared, git).entries;
  assert.deepEqual(changes.map(({ id }) => id), ['key:b']);
  assert.equal(setLocalisationSelection(git, shared, git, 'key:b', true), shared);
});

test('file structure remains separately selectable without replacing local key values', () => {
  const git = 'l_russian:\n a:0 "A"\n # note\n b:0 "B"\n';
  const shared = 'l_russian:\n b:0 "B"\n # moved\n a:0 "Shared A"\n';
  const local = git.replace('"A"', '"Local A"');
  const changes = localisationSelectionChanges(git, shared, local).entries;
  assert.ok(changes.some(({ id }) => id === '__file_structure__'));
  const selected = setLocalisationSelection(git, shared, local, '__file_structure__', true);
  assert.match(selected, /a:0 "Local A"/u);
  assert.ok(selected.indexOf('b:0') < selected.indexOf('a:0'));
  assert.match(selected, /# moved/u);
});

test('ambiguous duplicate-key files reject selection without producing a replacement', () => {
  const duplicate = `${base} key_one:0 "Duplicate"\r\n`;
  assert.throws(() => setLocalisationSelection(base, duplicate, base, 'key:key_one', true), /repeated/u);
});
