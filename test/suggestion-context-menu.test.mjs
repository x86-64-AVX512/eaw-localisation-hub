import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuggestionContextMenu, isSuggestionMouseTarget } from '../apps/review/src/suggestion-context-menu.ts';

test('suggestion zones and injected deletion text have a context menu in the native host', () => {
  const zone = { element: { closest: selector => selector.includes('active-suggestion-original-zone') } };
  const ghost = { detail: { injectedText: { options: { inlineClassName: 'suggestion-strike-a123' } } } };
  assert.equal(isSuggestionMouseTarget(zone), true);
  assert.equal(isSuggestionMouseTarget(ghost), true);
  assert.equal(isSuggestionMouseTarget({ type: 8 }), true);
  assert.equal(isSuggestionMouseTarget({ type: 5 }), true);
  assert.equal(isSuggestionMouseTarget({ detail: { injectedText: { options: { inlineClassName: 'other-extension' } } } }), false);
  assert.equal(isSuggestionMouseTarget({}), false);
  const calls = []; let context; let target = {};
  const dom = {
    addEventListener(name, callback, capture) { assert.equal(name, 'contextmenu'); assert.equal(capture, true); context = callback; },
    removeEventListener(name, callback, capture) { assert.equal(name, 'contextmenu'); assert.equal(callback, context); assert.equal(capture, true); },
  };
  const editor = {
    getDomNode: () => dom,
    getTargetAtClientPoint: () => target,
    focus() { calls.push('focus'); },
    getContribution(id) { assert.equal(id, 'editor.contrib.contextmenu'); return { showContextMenu(anchor) { calls.push(anchor); } }; },
    setPosition() { throw Error('Must not move the caret or flush the active draft'); },
  };
  const subscription = createSuggestionContextMenu(editor);
  const event = { clientX: 100, clientY: 200, pageX: 110, pageY: 220,
    preventDefault() { calls.push('prevent'); }, stopImmediatePropagation() { calls.push('stop'); } };
  const anchor = { x: 110, y: 220 };
  context(event); assert.deepEqual(calls, []);
  target = zone;
  context(event); assert.deepEqual(calls, ['prevent', 'stop', 'focus', anchor]);
  calls.length = 0;
  target = ghost;
  context(event); assert.deepEqual(calls, ['prevent', 'stop', 'focus', anchor]);
  subscription.dispose();
});
