import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureLocalisationVariant,
  localisationChangedKeys,
  localisationVariantConflicts,
  localisationSelectionChanges,
  mergeLocalisationThreeWay,
  projectLocalisationVariant,
  projectLocalisationOwnership,
  setLocalisationSelection,
} from '../packages/shared/src/merge.mts';

const base = [
  'l_russian:',
  ' key_one:0 "Первый"',
  ' key_two:0 "Второй"',
  '',
].join('\r\n');

test('single-line variant capture preserves duplicate-key and structure semantics', () => {
  assert.deepEqual([...captureLocalisationVariant(base, base.replace('"Первый"', '"Новый"'))], [
    ['key_one', ' key_one:0 "Новый"'],
  ]);
  const duplicated = `${base} key_one:0 "Последний"\r\n`;
  assert.deepEqual(
    [...captureLocalisationVariant(duplicated, duplicated.replace('"Первый"', '"Новый"'))],
    [['occ:1:key_one', ' key_one:0 "Новый"']],
    'the first duplicate must remain independently attributable',
  );
  const withComment = base.replace(' key_two', '# note\r\n key_two');
  assert.equal(captureLocalisationVariant(base, withComment).has('__file_structure__'), true);
  const brokenAcrossLines = base.replace('"Первый"', '"Пер\r\nвый"');
  assert.equal(captureLocalisationVariant(base, brokenAcrossLines).has('__file_structure__'), true);
});

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

test('unchanged duplicate occurrence counts merge and conflict independently', () => {
  const original = 'l_russian:\n repeated:0 "One"\n repeated:0 "Two"\n unique:0 "Old"\n';
  const first = original.replace('"One"', '"Shared"');
  const second = original.replace('"Two"', '"Git"');
  const independent = mergeLocalisationThreeWay(original, first, second);
  assert.deepEqual(independent.conflicts, []);
  assert.equal(independent.text, first.replace('"Two"', '"Git"'));

  const competing = mergeLocalisationThreeWay(original, first, original.replace('"One"', '"Git"'));
  assert.deepEqual(competing.conflicts.map(({ key }) => key), ['occ:1:repeated']);
  assert.equal(mergeLocalisationThreeWay(original, first, original.replace('"One"', '"Git"'), {
    'occ:1:repeated': 'external',
  }).text, original.replace('"One"', '"Git"'));
});

test('personal variants and ownership keep duplicate occurrences distinct', () => {
  const git = 'l_russian:\n repeated:0 "One"\n repeated:0 "Two"\n';
  const first = git.replace('"One"', '"Author one"');
  const second = git.replace('"Two"', '"Author two"');
  const firstVariant = captureLocalisationVariant(git, first);
  const secondVariant = captureLocalisationVariant(git, second);
  assert.deepEqual([...firstVariant], [['occ:1:repeated', ' repeated:0 "Author one"']]);
  assert.deepEqual([...secondVariant], [['occ:2:repeated', ' repeated:0 "Author two"']]);
  assert.equal(projectLocalisationVariant(git, firstVariant), first);
  assert.equal(projectLocalisationVariant(git, secondVariant), second);
  assert.deepEqual(localisationVariantConflicts(git, [
    ['first', firstVariant], ['second', secondVariant],
  ]), []);
  assert.deepEqual([...localisationChangedKeys(git, first)], ['occ:1:repeated']);
  assert.equal(projectLocalisationOwnership(git, first,
    new Map([['occ:1:repeated', 'first']]), 'first'), first);
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

test('bulk key additions retain preferred anchors and the final newline', () => {
  const base = 'l_russian:\n first:0 "First"\n last:0 "Last"\n';
  const added = Array.from({ length: 1_000 }, (_, index) => ` added_${index}:0 "${index}"\n`);
  const external = `l_russian:\n first:0 "First"\n${added.join('')} last:0 "Last"\n`;
  const result = mergeLocalisationThreeWay(base, base, external);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.text, external);
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

test('duplicate occurrences have independent IDs and preserve the unselected declaration', () => {
  const git = 'l_russian:\n duplicate:0 "First"\n unique:0 "Git"\n duplicate:0 "Second"\n';
  const shared = 'l_russian:\n duplicate:0 "Shared first"\n unique:0 "Shared"\n duplicate:0 "Shared second"\n';
  const changes = localisationSelectionChanges(git, shared, git);
  assert.deepEqual(changes.entries.map(({ id }) => id), [
    'occ:1:duplicate', 'key:unique', 'occ:2:duplicate',
  ]);
  const first = setLocalisationSelection(git, shared, git, 'occ:1:duplicate', true);
  assert.match(first, /duplicate:0 "Shared first"[\s\S]*duplicate:0 "Second"/u);
  const second = setLocalisationSelection(git, shared, first, 'occ:2:duplicate', true);
  assert.equal(localisationSelectionChanges(git, shared, second).entries
    .find(({ id }) => id === 'occ:2:duplicate')?.state, 'included');
  assert.equal(setLocalisationSelection(git, shared, second, 'occ:1:duplicate', false)
    .includes('duplicate:0 "First"'), true);
  const unique = setLocalisationSelection(git, shared, git, 'key:unique', true);
  assert.match(unique, /duplicate:0 "First"[\s\S]*duplicate:0 "Second"/u);
});

test('only duplicate keys with unequal occurrence counts are blocked', () => {
  const git = 'l_russian:\n repeated:0 "One"\n repeated:0 "Two"\n unique:0 "Git"\n';
  const shared = 'l_russian:\n repeated:0 "Only"\n unique:0 "Shared"\n';
  const changes = localisationSelectionChanges(git, shared, git);
  assert.deepEqual(changes.entries.map(({ id }) => id), ['key:unique']);
  assert.match(changes.blockedReason, /repeated/u);
  assert.throws(() => setLocalisationSelection(git, shared, git, 'occ:1:repeated', true), /cannot be matched/u);
});

test('local-only deleted BAR lines remain selectable after the shared text returns to Git', () => {
  const git = 'l_russian:\n barrad_silver.42.a:0 "A reversal of roles."\n barrad_silver.43.t:0 "Panacea"\n barrad_silver.43.d:0 "Description"\n barrad_silver.43.a:0 "Next"\n sp_bar_magical_reactor:0 "One"\n sp_bar_magical_reactor:0 "Two"\n';
  const removed = git.replace(' barrad_silver.42.a:0 "A reversal of roles."\n barrad_silver.43.t:0 "Panacea"\n barrad_silver.43.d:0 "Description"\n', '\n');
  const selection = localisationSelectionChanges(git, git, removed);
  assert.deepEqual(selection.entries.map(({ id }) => id), [
    '__file_structure__', 'key:barrad_silver.42.a', 'key:barrad_silver.43.t', 'key:barrad_silver.43.d',
  ]);
  assert.ok(selection.entries.every(({ state }) => state === 'custom'));
  let restored = removed;
  for (const key of ['barrad_silver.42.a', 'barrad_silver.43.t', 'barrad_silver.43.d']) {
    restored = setLocalisationSelection(git, git, restored, `key:${key}`, true);
  }
  restored = setLocalisationSelection(git, git, restored, '__file_structure__', true);
  assert.equal(restored, git);
});

test('excluding a deletion removes its blank-line placeholder without losing existing spacing', () => {
  const git = 'l_russian:\n before:0 "Before"\n\n target:0 "Target"\n after:0 "After"\n';
  const shared = git.replace(' target:0 "Target"\n', '\n');
  assert.equal(setLocalisationSelection(git, shared, shared, 'key:target', false), git);
  const variant = captureLocalisationVariant(git, shared);
  variant.delete('target');
  assert.equal(projectLocalisationVariant(git, variant), git);
});

test('BAR-style deletion placeholder is removed even when another key is duplicated elsewhere', () => {
  const git = 'l_russian:\n barrad_silver.43.t:0 "Panacea"\n barrad_silver.43.d:0 "Description"\n barrad_silver.43.a:0 "Next"\n sp_bar_magical_reactor:0 "One"\n sp_bar_magical_reactor:0 "Two"\n';
  const shared = git.replace(' barrad_silver.43.d:0 "Description"\n', '\n');
  assert.equal(setLocalisationSelection(git, shared, shared, 'key:barrad_silver.43.d', false), git);
  const variant = captureLocalisationVariant(git, shared);
  variant.delete('barrad_silver.43.d');
  assert.equal(projectLocalisationVariant(git, variant), git);
});

test('restoring a deleted key preserves unrelated comments and blank lines', () => {
  const git = 'l_russian:\n before:0 "Before"\n# comment\n target:0 "Target"\n\n after:0 "After"\n';
  const shared = git.replace(' target:0 "Target"\n', '\n');
  assert.equal(setLocalisationSelection(git, shared, shared, 'key:target', false), git);
});

test('a local-only change to one duplicate occurrence can be reset independently', () => {
  const git = 'l_russian:\n repeated:0 "First"\n repeated:0 "Second"\n';
  const local = git.replace('repeated:0 "Second"', 'repeated:0 "Personal"');
  const changes = localisationSelectionChanges(git, git, local);
  assert.deepEqual(changes.entries.map(({ id }) => id), ['occ:2:repeated']);
  assert.equal(changes.entries[0].state, 'custom');
  assert.equal(setLocalisationSelection(git, git, local, 'occ:2:repeated', true), git);
});

test('excluding a partly deleted BAR key restores it in place without a raw key fragment', () => {
  for (const eol of ['\n', '\r\n']) for (const tail of [':', ':0']) {
    const git = ['l_russian:', ' before:0 "Before"', '',
      ' BAR_friend_white_star_is_helping_tooltip:0 "White Star is here to help her brother."',
      ' BAR_fix_the_climate_tooltip:0 "Effects of Barrad climate will be less severe."', '', '',
      ' after:0 "After"', ' sp_bar_magical_reactor:0 "One"', ' sp_bar_magical_reactor:0 "Two"', ''].join(eol);
    const shared = git.replace(
      ` BAR_friend_white_star_is_helping_tooltip:0 "White Star is here to help her brother."${eol} BAR_fix_the_climate_tooltip:0 "Effects of Barrad climate will be less severe."`,
      ` BAR_friend_white_star_is_helping_tooltip${tail}`);
    const changes = localisationSelectionChanges(git, shared, shared);
    assert.equal(changes.entries.find(({ key }) => key === 'BAR_friend_white_star_is_helping_tooltip')?.kind, 'modified');
    assert.equal(changes.blockedReason, '');
    const variant = captureLocalisationVariant(git, shared);
    assert.equal(variant.get('BAR_friend_white_star_is_helping_tooltip'), ` BAR_friend_white_star_is_helping_tooltip${tail}`);
    assert.equal(projectLocalisationVariant(git, variant), shared);
    for (const order of [
      ['BAR_friend_white_star_is_helping_tooltip', 'BAR_fix_the_climate_tooltip'],
      ['BAR_fix_the_climate_tooltip', 'BAR_friend_white_star_is_helping_tooltip'],
    ]) {
      let local = shared;
      for (const key of order) local = setLocalisationSelection(git, shared, local, `key:${key}`, false);
      assert.equal(local, git, `${eol === '\n' ? 'LF' : 'CRLF'} ${tail}: no orphan fragment or extra line`);
      for (const key of order) local = setLocalisationSelection(git, shared, local, `key:${key}`, true);
      assert.equal(local, shared);
    }
  }
});

test('a locale header stays structure while an unfinished declaration remains a keyed edit', () => {
  const git = 'l_russian:\n target:0 "Value"\n';
  const shared = 'l_russian:\n target:\n';
  assert.deepEqual([...captureLocalisationVariant(git, shared)], [['target', ' target:']]);
  assert.deepEqual(localisationSelectionChanges(git, shared, git).entries.map(({ id }) => id), ['key:target']);
});

test('legacy stored structure plus restored key choices no longer materialises a duplicate fragment', () => {
  const git = 'l_russian:\n before:0 "Before"\n\n target:0 "Target"\n next:0 "Next"\n\n\n after:0 "After"\n repeated:0 "One"\n repeated:0 "Two"\n';
  const shared = git.replace(' target:0 "Target"\n next:0 "Next"', ' target:');
  // Before the parser fix, removing the value classified target as deleted
  // and its residual colon line as structure. Unchecking persisted this map.
  const restored = new Map([
    ['__file_structure__', shared], ['target', ' target:0 "Target"'], ['next', ' next:0 "Next"'],
  ]);
  assert.equal(projectLocalisationVariant(git, restored), git);
  const legacyLocal = shared.replace('\n\n\n after:', '\n\n\n target:0 "Target"\n next:0 "Next"\n after:');
  const persisted = new Map([...restored, ['__file_structure__', legacyLocal]]);
  const recovered = projectLocalisationVariant(git, persisted);
  assert.equal((recovered.match(/ target:/gu) ?? []).length, 1, 'an already persisted raw fragment is not kept as a second declaration');
  assert.doesNotMatch(recovered, / target:\r?\n/u);
  assert.equal(recovered.split('\n').length, git.split('\n').length, 'the phantom declaration no longer adds a model row');
  assert.match(recovered, / next:0 "Next"/u);
  const otherLocalEdit = new Map([...restored, ['after', ' after:0 "Personal"']]);
  assert.equal(projectLocalisationVariant(git, otherLocalEdit), git.replace('"After"', '"Personal"'));
});

test('restoring a deleted group with an internal blank keeps it above the following comment block', () => {
  for (const eol of ['\n', '\r\n']) {
    const block = [' company:0 "Company"', ' description:0 "Description"', '',
      ' progress: "Progress"', ' pending: "Pending"'].join(eol) + eol;
    const git = ['l_russian:', ' before:0 "Before"', block + '', '',
      ' # ASCII heading', ' # #### ###', '', '', ' after:0 "After"',
      ' repeated:0 "One"', ' repeated:0 "Two"', ''].join(eol);
    for (const placeholder of ['', ` ${eol}`]) {
      const shared = git.replace(block, placeholder);
      const orders = (items) => items.length ? items.flatMap((key, index) =>
        orders(items.filter((_, other) => other !== index)).map((tail) => [key, ...tail])) : [[]];
      for (const order of orders(['company', 'description', 'progress', 'pending'])) {
        let local = shared;
        for (const key of order) local = setLocalisationSelection(git, shared, local, `key:${key}`, false);
        assert.equal(local, git, `restored order ${order.join(',')} with ${JSON.stringify(eol)}`);
        const variant = captureLocalisationVariant(git, local);
        assert.equal(projectLocalisationVariant(git, variant), git);
        for (const key of order) local = setLocalisationSelection(git, shared, local, `key:${key}`, true);
        assert.equal(local, git.replace(block, ''),
          'including the whole deletion again must remove its internal blank and editor placeholder');
      }
      const misplaced = shared.replace(' after:0', block.replace(`${eol}${eol}`, eol) + ' after:0');
      assert.equal(setLocalisationSelection(git, shared, misplaced, 'key:company', false), git,
        'explicit exclusion also repairs a group already restored below its comments');
    }
  }
});
