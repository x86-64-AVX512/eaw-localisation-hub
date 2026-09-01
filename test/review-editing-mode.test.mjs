import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePluginMessage } from '../packages/shared/src/protocol-schema.mjs';
import {
  baseToProjectedOffset, batchSuggestionActions, createEditingModeController, projectedToBaseOffset,
  isLineBreakBoundary, singleReplacement, suggestionAction, suggestionProjection,
} from '../apps/review/src/editing-mode.js';
import { suggestionTraceParts } from '../packages/shared/src/suggestion-trace.mjs';

function controllerHarness(initial = 'abc') {
  const buttons = new Map();
  for (const id of ['#mode-edit', '#mode-suggest']) buttons.set(id, {
    classList: { toggle() {} }, setAttribute() {},
    addEventListener(type, listener) { if (type === 'click') this.click = listener; },
  });
  globalThis.document = { querySelector: (selector) => buttons.get(selector) };
  const contentListeners = [];
  const cursorListeners = [];
  let value = initial;
  let position = 0;
  let alternativeVersion = 1;
  const undoStack = [];
  const redoStack = [];
  const saveUndoState = () => {
    undoStack.push({ value, position, alternativeVersion });
    redoStack.length = 0;
    alternativeVersion += 1;
  };
  const positionAt = (offset) => ({ lineNumber: 1, column: offset + 1, offset });
  const selectionAt = (offset) => ({
    startLineNumber: 1, startColumn: offset + 1, endLineNumber: 1, endColumn: offset + 1,
    getStartPosition: () => positionAt(offset), getEndPosition: () => positionAt(offset),
  });
  const model = {
    getValue: () => value,
    getAlternativeVersionId: () => alternativeVersion,
    getOffsetAt: (candidate) => candidate.offset ?? candidate.column - 1,
    getPositionAt: positionAt,
    pushEditOperations(_selections, edits) {
      saveUndoState();
      const changes = [];
      for (const edit of edits) {
        const start = edit.range.startColumn - 1;
        const end = edit.range.endColumn - 1;
        changes.push({ rangeOffset: start, rangeLength: end - start, text: edit.text });
        value = value.slice(0, start) + edit.text + value.slice(end);
        position = start + edit.text.length;
      }
      for (const listener of contentListeners) listener({ changes });
    },
  };
  const editor = {
    getValue: () => value,
    getModel: () => model,
    getPosition: () => positionAt(position),
    getSelection: () => selectionAt(position),
    setValue(next) {
      const previousLength = value.length;
      saveUndoState();
      value = next;
      position = 0;
      for (const listener of contentListeners) listener({
        changes: [{ rangeOffset: 0, rangeLength: previousLength, text: next }],
      });
    },
    setPosition(next) {
      position = next.offset ?? next.column - 1;
      const selection = { getPosition: () => positionAt(position) };
      for (const listener of cursorListeners) listener({ selection });
    },
    onDidChangeModelContent(listener) {
      contentListeners.push(listener);
      return { dispose() {} };
    },
    onDidChangeCursorSelection(listener) {
      cursorListeners.push(listener);
      return { dispose() {} };
    },
    focus() {},
    pushUndoStop() {},
    executeEdits(_source, edits) {
      saveUndoState();
      const changes = [];
      for (const edit of edits) {
        const start = edit.range.startColumn - 1;
        const end = edit.range.endColumn - 1;
        changes.push({ rangeOffset: start, rangeLength: end - start, text: edit.text });
        value = value.slice(0, start) + edit.text + value.slice(end);
        position = start + edit.text.length;
      }
      for (const listener of contentListeners) listener({ changes });
    },
    trigger(_source, command) {
      const source = command === 'undo' ? undoStack : redoStack;
      const target = command === 'undo' ? redoStack : undoStack;
      const historical = source.pop();
      if (!historical) return;
      const previous = { value, position, alternativeVersion };
      target.push(previous);
      const previousLength = value.length;
      value = historical.value;
      position = historical.position;
      alternativeVersion = historical.alternativeVersion;
      for (const listener of contentListeners) listener({
        changes: [{ rangeOffset: 0, rangeLength: previousLength, text: value }],
        isUndoing: command === 'undo', isRedoing: command === 'redo',
      });
    },
    type(text, cursorFirst = false) {
      const start = position;
      saveUndoState();
      value = value.slice(0, position) + text + value.slice(position);
      position += text.length;
      const selection = { getPosition: () => positionAt(position) };
      if (cursorFirst) for (const listener of cursorListeners) listener({ selection });
      for (const listener of contentListeners) listener({
        changes: [{ rangeOffset: start, rangeLength: 0, text }],
      });
      if (!cursorFirst) for (const listener of cursorListeners) listener({ selection });
    },
    replace(start, end, text, cursorFirst = false) {
      saveUndoState();
      value = value.slice(0, start) + text + value.slice(end);
      position = start + text.length;
      const selection = { getPosition: () => positionAt(position) };
      if (cursorFirst) for (const listener of cursorListeners) listener({ selection });
      for (const listener of contentListeners) listener({
        changes: [{ rangeOffset: start, rangeLength: end - start, text }],
      });
      if (!cursorFirst) for (const listener of cursorListeners) listener({ selection });
    },
    moveTo(offset) {
      position = offset;
      const selection = { getPosition: () => positionAt(position) };
      for (const listener of cursorListeners) listener({ selection });
    },
  };
  const messages = [];
  const state = {
    ready: true, applyingRemote: false, path: 'file.yml', user: 'Tester', userId: 'user-1',
    editingSuggestionId: '', suggestionProjection: null,
  };
  const controller = createEditingModeController({
    state, editor, send: (message) => messages.push(message), showToast() {},
  });
  return { buttons, controller, editor, messages, state };
}

test('suggesting mode identifies insertions, deletions, and replacements', () => {
  assert.deepEqual(singleReplacement('abc', 'abXc'), {
    start: 2, previousEnd: 2, replacement: 'X',
  });
  assert.deepEqual(singleReplacement('abc', 'ac'), {
    start: 1, previousEnd: 2, replacement: '',
  });
  assert.deepEqual(singleReplacement('Она выпала.', 'Она далась.'), {
    start: 4, previousEnd: 10, replacement: 'далась',
  });
});

test('plain text comparison keeps unchanged prefixes and suffixes outside the replacement', () => {
  assert.deepEqual(singleReplacement('кот', 'код'), {
    start: 2, previousEnd: 3, replacement: 'д',
  });
  assert.deepEqual(singleReplacement('отряд бандитов', 'отряд пингвинов'), {
    start: 6, previousEnd: 12, replacement: 'пингвин',
  });
  assert.deepEqual(singleReplacement('key:0 "бандитов"', 'key:0 "пингвинов"'), {
    start: 7, previousEnd: 13, replacement: 'пингвин',
  });
  assert.deepEqual(singleReplacement('key:0 "столицу"', 'key:0 "сталь"'), {
    start: 9, previousEnd: 14, replacement: 'аль',
  });
  assert.deepEqual(singleReplacement('prefix Столица suffix', 'prefix Сталь suffix'), {
    start: 9, previousEnd: 14, replacement: 'аль',
  });
  assert.deepEqual(singleReplacement('prefix столица suffix', 'prefix ста suffix'), {
    start: 9, previousEnd: 13, replacement: '',
  });
});

test('suggesting mode ignores unchanged text', () => {
  assert.equal(singleReplacement('без изменений', 'без изменений'), null);
});

test('suggesting mode never splits an astral Unicode code point', () => {
  assert.deepEqual(singleReplacement('a😀b', 'a😎b'), {
    start: 1, previousEnd: 3, replacement: '😎',
  });
});

test('line breaks are allowed at word edges but not inside a word', () => {
  assert.equal(isLineBreakBoundary('document', 0), true);
  assert.equal(isLineBreakBoundary('document', 'document'.length), true);
  assert.equal(isLineBreakBoundary('document', 3), false);
  assert.equal(isLineBreakBoundary('one two', 3), true);
  assert.equal(isLineBreakBoundary('document', 0, 'document'.length), true);

  const harness = controllerHarness('document');
  harness.editor.moveTo(3);
  assert.equal(harness.controller.insertLineBreak(), false);
  assert.equal(harness.editor.getValue(), 'document');
  harness.editor.moveTo('document'.length);
  assert.equal(harness.controller.insertLineBreak(), true);
  assert.equal(harness.editor.getValue(), 'document\n');
});

test('a completed line-break suggestion has protocol-safe undo and redo', () => {
  const harness = controllerHarness('document');
  harness.buttons.get('#mode-suggest').click();
  harness.editor.moveTo('document'.length);
  assert.equal(harness.controller.insertLineBreak(), true);
  assert.equal(Buffer.from(harness.messages.at(-1).replacementBase64, 'base64').toString(), '\n');

  harness.editor.moveTo(0);
  harness.controller.undo();
  assert.equal(harness.messages.at(-1).type, 'suggestionDelete');
  harness.controller.redo();
  assert.equal(harness.messages.at(-1).type, 'suggestionCreate');
  assert.doesNotThrow(() => validatePluginMessage(harness.messages.at(-1)));
});

test('a line break at an edited word edge stays in the same whole-word suggestion', () => {
  const initial = 'prefix машина suffix';
  const wordStart = 'prefix '.length;
  const original = 'машина';
  const replacement = 'малина';
  const harness = controllerHarness(initial);
  assert.equal(harness.controller.editSuggestion({
    id: 'existing-word', status: 'open', authorId: 'user-1',
    startByte: Buffer.byteLength(initial.slice(0, wordStart)),
    endByte: Buffer.byteLength(initial.slice(0, wordStart + original.length)),
    originalBase64: Buffer.from(original).toString('base64'),
    replacementBase64: Buffer.from(replacement).toString('base64'),
  }), true);

  harness.editor.moveTo(wordStart);
  assert.equal(harness.controller.insertLineBreak(), true);

  const latest = harness.messages.at(-1);
  assert.equal(latest.type, 'suggestionUpdate');
  assert.equal(latest.suggestionId, 'existing-word');
  assert.equal(Buffer.from(latest.replacementBase64, 'base64').toString(), `\n${replacement}`);
  assert.deepEqual(
    { startByte: latest.startByte, endByte: latest.endByte },
    {
      startByte: Buffer.byteLength(initial.slice(0, wordStart)),
      endByte: Buffer.byteLength(initial.slice(0, wordStart + original.length)),
    },
  );
});

test('Replace All changes become independent suggestions', () => {
  let sequence = 0;
  const actions = batchSuggestionActions('one old and old', [
    { rangeOffset: 4, rangeLength: 3, text: 'new' },
    { rangeOffset: 12, rangeLength: 3, text: 'new' },
  ], () => `id-${sequence += 1}`);
  assert.deepEqual(actions.map((item) => ({
    id: item.suggestionId, startByte: item.startByte, endByte: item.endByte,
  })), [
    { id: 'id-1', startByte: 4, endByte: 7 },
    { id: 'id-2', startByte: 12, endByte: 15 },
  ]);
});

test('a live insertion is created immediately and subsequent typing updates the same suggestion', () => {
  const created = suggestionAction('abc', 'abXc', 'draft-1');
  assert.equal(created.type, 'suggestionCreate');
  assert.equal(created.suggestionId, 'draft-1');
  assert.equal(Buffer.from(created.replacementBase64, 'base64').toString('utf8'), 'X');
  const updated = suggestionAction('abc', 'abXYZc', 'draft-1', true);
  assert.equal(updated.type, 'suggestionUpdate');
  assert.equal(updated.suggestionId, 'draft-1');
  assert.equal(Buffer.from(updated.replacementBase64, 'base64').toString('utf8'), 'XYZ');
  assert.deepEqual(
    { startByte: updated.startByte, endByte: updated.endByte },
    { startByte: created.startByte, endByte: created.endByte },
  );
});

test('a live insertion remains a stable local projection across a typing pause', () => {
  const projection = suggestionProjection('abc', 'abXYZc');
  assert.deepEqual(projection, {
    baseText: 'abc', start: 2, previousEnd: 2, replacementLength: 3,
  });
  assert.equal(projectedToBaseOffset(projection, 5), 2,
    'the caret after a proposed insertion maps back to its canonical anchor');
  assert.equal(baseToProjectedOffset(projection, 3), 6,
    'canonical content after a proposed insertion maps after the projected text');
});

test('replacement projection maps both sides without consuming neighbouring YAML', () => {
  const projection = suggestionProjection('key: "old"\nnext: "safe"', 'key: "new text"\nnext: "safe"');
  const nextInBase = 'key: "old"\n'.length;
  const nextInProjection = 'key: "new text"\n'.length;
  assert.equal(baseToProjectedOffset(projection, nextInBase), nextInProjection);
  assert.equal(projectedToBaseOffset(projection, nextInProjection), nextInBase);
});

test('controller keeps continuous insertion visible and updates one server suggestion', () => {
  const harness = controllerHarness();
  harness.buttons.get('#mode-suggest').click();
  harness.editor.moveTo(2);
  harness.editor.type('X');
  assert.equal(harness.editor.getValue(), 'abXc');
  const suggestionId = harness.messages.at(-1).suggestionId;
  assert.equal(harness.messages.at(-1).type, 'suggestionCreate');
  assert.deepEqual(Object.keys(harness.messages.at(-1)).sort(), [
    'endByte', 'path', 'replacementBase64', 'startByte', 'suggestionId', 'traceJson', 'type',
  ]);
  assert.doesNotThrow(() => validatePluginMessage(harness.messages.at(-1)));
  harness.editor.type('YZ');
  assert.equal(harness.editor.getValue(), 'abXYZc');
  assert.equal(harness.messages.at(-1).type, 'suggestionUpdate');
  assert.equal(harness.messages.at(-1).suggestionId, suggestionId);
  assert.doesNotThrow(() => validatePluginMessage(harness.messages.at(-1)));
  harness.editor.moveTo(0);
  assert.equal(harness.editor.getValue(), 'abc');
});

test('manual typing keeps surviving letters out of the inserted text', () => {
  const harness = controllerHarness('prefix столица suffix');
  harness.buttons.get('#mode-suggest').click();
  const wordStart = 'prefix '.length;
  harness.editor.replace(wordStart + 2, wordStart + 6, '');
  const suggestionId = harness.messages.at(-1).suggestionId;
  assert.equal(harness.messages.at(-1).type, 'suggestionCreate');
  assert.equal(Buffer.from(harness.messages.at(-1).replacementBase64, 'base64').toString(), '');
  assert.deepEqual(
    { startByte: harness.messages.at(-1).startByte, endByte: harness.messages.at(-1).endByte },
    { startByte: Buffer.byteLength('prefix ст'), endByte: Buffer.byteLength('prefix столиц') },
  );

  // After deleting "олиц", moving to the end of the surviving "ста" must not
  // finish the active suggestion. Each separately typed letter must update that
  // same whole-word draft even if the user pauses before completing the word.
  harness.editor.moveTo(wordStart + 3);
  harness.editor.type('л');

  let suggestionMessages = harness.messages.filter((message) => /^suggestion(?:Create|Update)$/.test(message.type));
  assert.equal(new Set(suggestionMessages.map((message) => message.suggestionId)).size, 1);
  assert.equal(suggestionMessages.at(-1).suggestionId, suggestionId);
  assert.equal(suggestionMessages.at(-1).type, 'suggestionUpdate');
  assert.equal(Buffer.from(suggestionMessages.at(-1).replacementBase64, 'base64').toString(), 'ал');
  assert.deepEqual(
    suggestionTraceParts('олица', 'ал', suggestionMessages.at(-1).traceJson),
    [
      { kind: 'delete', text: 'олиц' },
      { kind: 'equal', text: 'а' },
      { kind: 'insert', text: 'л' },
    ],
  );

  harness.editor.type('ь');

  suggestionMessages = harness.messages.filter((message) => /^suggestion(?:Create|Update)$/.test(message.type));
  assert.equal(new Set(suggestionMessages.map((message) => message.suggestionId)).size, 1);
  assert.equal(suggestionMessages.at(-1).suggestionId, suggestionId);
  assert.equal(suggestionMessages.at(-1).type, 'suggestionUpdate');
  assert.equal(Buffer.from(suggestionMessages.at(-1).replacementBase64, 'base64').toString(), 'аль');
  assert.deepEqual(
    { startByte: suggestionMessages.at(-1).startByte, endByte: suggestionMessages.at(-1).endByte },
    { startByte: Buffer.byteLength('prefix ст'), endByte: Buffer.byteLength('prefix столица') },
  );
});

test('character-by-character backspace never turns surviving letters into an insertion', () => {
  const word = 'машина';
  const harness = controllerHarness(`prefix ${word} suffix`);
  harness.buttons.get('#mode-suggest').click();
  const wordStart = 'prefix '.length;
  harness.editor.moveTo(wordStart + word.length);
  let suggestionId = '';
  for (let removed = 1; removed <= word.length; removed += 1) {
    const end = wordStart + word.length - removed + 1;
    harness.editor.replace(end - 1, end, '');
    const latest = harness.messages.at(-1);
    suggestionId ||= latest.suggestionId;
    assert.equal(latest.suggestionId, suggestionId);
    assert.equal(Buffer.from(latest.replacementBase64, 'base64').toString(), '');
    assert.equal(latest.traceJson, '[]');
    assert.equal(latest.startByte, Buffer.byteLength(`prefix ${word.slice(0, -removed)}`));
    assert.equal(latest.endByte, Buffer.byteLength(`prefix ${word}`));
  }
});

test('undo and redo restore the provenance of character-by-character deletion', () => {
  const word = 'машина';
  const harness = controllerHarness(word);
  harness.buttons.get('#mode-suggest').click();
  harness.editor.moveTo(word.length);
  for (let end = word.length; end > 0; end -= 1) harness.editor.replace(end - 1, end, '');

  for (let index = 0; index < word.length; index += 1) harness.controller.undo();
  assert.equal(harness.editor.getValue(), word);
  assert.equal(harness.messages.at(-1).type, 'suggestionDelete');

  harness.controller.redo();
  assert.equal(harness.editor.getValue(), word.slice(0, -1));
  assert.equal(harness.messages.at(-1).type, 'suggestionCreate');
  assert.equal(Buffer.from(harness.messages.at(-1).replacementBase64, 'base64').toString(), '');
  assert.equal(harness.messages.at(-1).traceJson, '[]');
});

const overlappingWordCases = [
  ['столица', 'сталь'],
  ['бандитов', 'пингвинов'],
  ['экономика', 'экология'],
  ['исправление', 'направление'],
  ['сохранить', 'сократить'],
];

for (const [originalWord, replacementWord] of overlappingWordCases) {
  test(`manual ${originalWord} -> ${replacementWord} replacement stays whole after every letter`, () => {
    let sharedStart = 0;
    while (sharedStart < originalWord.length && sharedStart < replacementWord.length
      && originalWord[sharedStart] === replacementWord[sharedStart]) sharedStart += 1;
    let originalEnd = originalWord.length;
    let replacementEnd = replacementWord.length;
    while (originalEnd > sharedStart && replacementEnd > sharedStart
      && originalWord[originalEnd - 1] === replacementWord[replacementEnd - 1]) {
      originalEnd -= 1;
      replacementEnd -= 1;
    }

    const harness = controllerHarness(`prefix ${originalWord} suffix`);
    harness.buttons.get('#mode-suggest').click();
    const wordStart = 'prefix '.length;
    harness.editor.replace(wordStart + sharedStart, wordStart + originalEnd, '');
    const suggestionId = harness.messages.at(-1).suggestionId;
    const commonPrefix = originalWord.slice(0, sharedStart);
    const commonSuffix = originalWord.slice(originalEnd);
    assert.equal(Buffer.from(harness.messages.at(-1).replacementBase64, 'base64').toString(), '');

    const inserted = replacementWord.slice(sharedStart, replacementEnd);
    for (let index = 0; index < inserted.length; index += 1) {
      harness.editor.type(inserted[index]);
      const latest = harness.messages.at(-1);
      assert.equal(latest.type, 'suggestionUpdate');
      assert.equal(latest.suggestionId, suggestionId);
      assert.equal(
        Buffer.from(latest.replacementBase64, 'base64').toString(),
        inserted.slice(0, index + 1),
      );
      assert.deepEqual(
        { startByte: latest.startByte, endByte: latest.endByte },
        {
          startByte: Buffer.byteLength(`prefix ${commonPrefix}`),
          endByte: Buffer.byteLength(`prefix ${originalWord.slice(0, originalEnd)}`),
        },
      );
      assert.deepEqual(
        suggestionTraceParts(
          originalWord.slice(sharedStart, originalEnd),
          inserted.slice(0, index + 1),
          latest.traceJson,
        ),
        [
          { kind: 'delete', text: originalWord.slice(sharedStart, originalEnd) },
          { kind: 'insert', text: inserted.slice(0, index + 1) },
        ],
      );
    }

    const suggestionMessages = harness.messages.filter((message) => /^suggestion(?:Create|Update)$/.test(message.type));
    assert.equal(new Set(suggestionMessages.map((message) => message.suggestionId)).size, 1);
    assert.equal(harness.editor.getValue(), `prefix ${replacementWord} suffix`);
  });
}

test('controller reopens an exact existing insertion for inline editing', () => {
  const harness = controllerHarness();
  const opened = harness.controller.editSuggestion({
    id: 'existing-1', status: 'open', authorId: 'user-1',
    startByte: 2, endByte: 2,
    originalBase64: Buffer.from('').toString('base64'),
    replacementBase64: Buffer.from('XYZ').toString('base64'),
  });
  assert.equal(opened, true);
  assert.equal(harness.editor.getValue(), 'abXYZc');
  harness.editor.type('!');
  assert.equal(harness.messages.at(-1).type, 'suggestionUpdate');
  assert.equal(harness.messages.at(-1).suggestionId, 'existing-1');
  assert.equal(Buffer.from(harness.messages.at(-1).replacementBase64, 'base64').toString(), 'XYZ!');
  harness.editor.moveTo(0);
  assert.equal(harness.editor.getValue(), 'abc');
});

test('editing an existing multiline suggestion survives Monaco cursor-first typing events', () => {
  const original = ' test_key_13:0 "old"\n test_key_14:0 "old"';
  const initial = `l_russian:\n${original}\n tail:0 "safe"`;
  const replacement = ' test_key_13:0 "new one"\n test_key_14:0 "new two"\n test_key_extra:0 "new three"';
  const harness = controllerHarness(initial);
  const start = initial.indexOf(original);
  const end = start + original.length;
  const opened = harness.controller.editSuggestion({
    id: 'existing-multiline', status: 'open', authorId: 'user-1',
    startByte: Buffer.byteLength(initial.slice(0, start)),
    endByte: Buffer.byteLength(initial.slice(0, end)),
    originalBase64: Buffer.from(original).toString('base64'),
    replacementBase64: Buffer.from(replacement).toString('base64'),
  });
  assert.equal(opened, true);
  assert.equal(harness.editor.getValue(), initial.slice(0, start) + replacement + initial.slice(end));

  harness.editor.type(' ДОПОЛНЕНО', true);

  const suggestionMessages = harness.messages.filter((message) => /^suggestion(?:Create|Update)$/.test(message.type));
  const expected = suggestionAction(
    initial,
    initial.slice(0, start) + replacement + ' ДОПОЛНЕНО' + initial.slice(end),
    'existing-multiline',
    true,
  );
  assert.equal(suggestionMessages.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(suggestionMessages[0]).filter(([key]) => key !== 'path')),
    expected,
  );
});
