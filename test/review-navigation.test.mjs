import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewNavigation, reviewItemsAtByte } from '../apps/review/src/review-navigation.ts';

test('review navigation prefers the narrowest overlapping discussion range', () => {
  const state = {
    comments: new Map([
      ['wide', { id: 'wide', startByte: 10, endByte: 30, status: 'open' }],
      ['closed', { id: 'closed', startByte: 15, endByte: 16, status: 'resolved' }],
    ]),
    suggestions: new Map([
      ['narrow', { id: 'narrow', startByte: 14, endByte: 18, status: 'open' }],
    ]),
  };
  assert.deepEqual(
    reviewItemsAtByte(state, 16).map(({ kind, id }) => `${kind}:${id}`),
    ['suggestion:narrow', 'comment:wide'],
  );
  assert.deepEqual(reviewItemsAtByte(state, 31), []);
});

test('a plain outside click finishes before Monaco can select against a replaced model', () => {
  let mouseDown; let mouseUp; const calls = [];
  const state = { editingSuggestionId: 's1', comments: new Map(), suggestions: new Map() };
  createReviewNavigation({ state,
    editor: {
      getDomNode: () => ({ addEventListener(_type, listener) { mouseDown = listener; }, removeEventListener() {} }),
      getTargetAtClientPoint: () => ({ type: 6, position: { lineNumber: 6, column: 4 } }),
      onMouseUp(listener) { mouseUp = listener; return { dispose() {} }; },
      focus: () => calls.push('focus-editor'),
    }, positionByteAt: () => { throw Error('Mouse-up must not reopen a draft'); }, focusCard: () => false, onSuggestion() {},
    finishSuggestionAt: position => { calls.push(['finish', position]); state.editingSuggestionId = ''; return true; },
  });
  mouseDown({ button: 0, preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') });
  assert.deepEqual(calls, [['finish', { lineNumber: 6, column: 4 }], 'prevent', 'stop', 'focus-editor']);
  mouseUp({ event: { leftButton: true }, target: { position: { lineNumber: 6, column: 4 } } });
  assert.equal(calls.length, 4);
});

test('right-click on an annotated range never steals focus or opens a suggestion draft', () => {
  let mouseUp;
  const calls = [];
  createReviewNavigation({
    state: { editingSuggestionId: '', comments: new Map(), suggestions: new Map([
      ['s1', { id: 's1', startByte: 0, endByte: 10, status: 'open' }],
    ]) },
    editor: { getDomNode: () => ({ addEventListener() {}, removeEventListener() {} }),
      onMouseUp(listener) { mouseUp = listener; return { dispose() {} }; } },
    positionByteAt: () => 5,
    focusCard: () => calls.push('focus'), onSuggestion: () => calls.push('edit'),
  });
  for (const buttons of [{ leftButton: false, rightButton: true }, { leftButton: false, middleButton: true }]) {
    mouseUp({ event: buttons, target: { position: { lineNumber: 1, column: 6 } } });
  }
  assert.deepEqual(calls, []);
  mouseUp({ event: { leftButton: true, browserEvent: { detail: 1 } }, target: { position: { lineNumber: 1, column: 6 } } });
  assert.deepEqual(calls, ['focus', 'edit']);
  mouseUp({ event: { leftButton: true, browserEvent: { detail: 2 } }, target: { position: { lineNumber: 1, column: 6 } } });
  assert.deepEqual(calls, ['focus', 'edit', 'focus', 'edit']);
});

test('a click finishing a draft cannot reopen it, but the next single click can', () => {
  let mouseDown; let mouseUp;
  const calls = [];
  const state = { editingSuggestionId: 's1', comments: new Map(), suggestions: new Map([
    ['s1', { id: 's1', startByte: 0, endByte: 10, status: 'open' }],
  ]) };
  const navigation = createReviewNavigation({ state,
    editor: {
      getDomNode: () => ({
        addEventListener(type, listener, capture) { assert.equal(type, 'mousedown'); assert.equal(capture, true); mouseDown = listener; },
        removeEventListener(type, listener, capture) { assert.equal(listener, mouseDown); assert.equal(capture, true); calls.push('dispose-down'); },
      }),
      onMouseUp(listener) { mouseUp = listener; return { dispose() { calls.push('dispose-up'); } }; },
    }, positionByteAt: () => 5, focusCard: () => calls.push('focus'), onSuggestion: () => calls.push('edit'),
  });
  const event = { event: { leftButton: true }, target: { position: { lineNumber: 1, column: 6 } } };
  mouseDown(event);
  state.editingSuggestionId = '';
  mouseUp(event);
  assert.deepEqual(calls, []);
  mouseDown(event); mouseUp(event);
  assert.deepEqual(calls, ['focus', 'edit']);
  navigation.dispose();
  assert.deepEqual(calls.slice(-2), ['dispose-down', 'dispose-up']);
});
