import assert from 'node:assert/strict';
import test from 'node:test';
import { completedSuggestionZoneAfterLine, createDecorationRenderer } from '../apps/review/src/editor-decorations.ts';
import { activeSuggestionPreview } from '../apps/review/src/suggestion-preview.ts';

test('a completed leading-newline replacement is rendered below its original line', () => {
  const range = {
    getStartPosition: () => ({ lineNumber: 6, column: 1 }),
    getEndPosition: () => ({ lineNumber: 6, column: 7 }),
  };
  assert.equal(completedSuggestionZoneAfterLine(range), 6);
});

test('a multiline original renders its replacement after the final original line', () => {
  const range = {
    getStartPosition: () => ({ lineNumber: 6, column: 4 }),
    getEndPosition: () => ({ lineNumber: 8, column: 5 }),
  };
  assert.equal(completedSuggestionZoneAfterLine(range), 8);
});

function rendererHarness(base, projection = null) {
  const previousDocument = globalThis.document;
  const previousCancel = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  function element() {
    const children = []; let text = '';
    return { children, style: { setProperty() {}, removeProperty() {} }, setAttribute() {},
      append: child => children.push(child), remove() {},
      set textContent(value) { text = value; }, get textContent() { return text + children.map(c => c.textContent).join(''); },
      getBoundingClientRect() { return { height: this.textContent.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 40)), 0) * 23 }; },
    };
  }
  globalThis.document = {
    head: { append() {} },
    createElement: element,
  };
  const state = { suggestionProjection: projection, editingSuggestionId: '', suggestions: new Map(),
    comments: new Map(), reservations: new Map(), presences: new Map() };
  const zones = new Map(); let nextZone = 0; let decorations = [];
  const positionAt = offset => {
    const prefix = base.slice(0, offset);
    return { lineNumber: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') };
  };
  const offsetAt = p => base.split('\n').slice(0, p.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + p.column - 1;
  const range = (start, end = start) => ({ getStartPosition: () => start, getEndPosition: () => end });
  const editor = {
    getDomNode: () => element(),
    getOption: () => ({ fontFamily: 'Consolas', fontSize: 15, fontWeight: 'normal', lineHeight: 23, letterSpacing: 0 }),
    getLayoutInfo: () => ({ contentWidth: 400, verticalScrollbarWidth: 14 }),
    onDidLayoutChange: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
    createDecorationsCollection: () => ({ set: value => { decorations = value; }, clear: () => { decorations = []; } }),
    getModel: () => ({ getPositionAt: positionAt, getOffsetAt: offsetAt, getValue: () => base }),
    changeViewZones: callback => callback({ addZone: zone => { const id = String(++nextZone); zones.set(id, zone); return id; },
      removeZone: id => zones.delete(id) }),
  };
  const render = createDecorationRenderer({ state, editor, monaco: { Range: { fromPositions: range }, editor: { EditorOption: { fontInfo: 1 } } },
    rangeFromBytes: (start, end) => range(positionAt(start), positionAt(end)), onLayout() {} });
  return { state, zones, render, decorations: () => decorations,
    dispose() { render.dispose(); globalThis.document = previousDocument; globalThis.cancelAnimationFrame = previousCancel; } };
}

test('active multiline deletion reuses the caret row for its final original line', () => {
  const base = 'header\n first:0 "First"\n last:0 "Last"\n next:0 "Next"\n';
  const start = base.indexOf('first:'); const end = base.indexOf('\n next:');
  const h = rendererHarness(base.slice(0, start) + base.slice(end), {
    baseText: base, start, previousEnd: end, replacementLength: 0, color: '#6aa9ff', author: 'User',
  });
  try {
    h.render();
    assert.equal(h.zones.size, 1);
    const zone = [...h.zones.values()][0];
    assert.equal(zone.domNode.textContent, ' first:0 "First"');
    assert.equal(zone.afterLineNumber, 1);
    assert.equal(zone.heightInLines, undefined);
    assert.equal(zone.marginDomNode, undefined);
    assert.equal(zone.heightInPx, 23);
    assert.equal(h.decorations().length, 1);
    assert.equal(h.decorations()[0].options.before.content, 'last:0 "Last"');
    h.render(); assert.equal(h.zones.size, 1);
    h.state.suggestionProjection = null;
    h.render(); assert.equal(h.zones.size, 0);
  } finally { h.dispose(); }
});

test('completed multiline proposal retains F7 text trimming and measures its visible height', () => {
  const h = rendererHarness('header\n original\n next\n');
  h.state.suggestions.set('s1', { id: 's1', status: 'open', startByte: 8, endByte: 16,
    author: 'User', color: '#6aa9ff', originalBase64: Buffer.from('original').toString('base64'),
    replacementBase64: Buffer.from('\n first\n second\n').toString('base64') });
  try {
    h.render();
    const zone = [...h.zones.values()][0];
    assert.equal(zone.afterLineNumber, 2);
    assert.equal(zone.heightInLines, undefined);
    assert.equal(zone.domNode.textContent, ' first\n second');
    assert.equal(zone.heightInPx, 46);
    h.render.dispose(); assert.equal(h.zones.size, 0);
  } finally { h.dispose(); }
});

test('wrapped deleted text reserves its visual rows without duplicating the retained caret row', () => {
  const base = 'header\n first:0 "' + 'x'.repeat(110) + '"\n last:0 "Last"\n next:0 "Next"\n';
  const start = base.indexOf('first:'); const end = base.indexOf('\n next:');
  const h = rendererHarness(base.slice(0, start) + base.slice(end), {
    baseText: base, start, previousEnd: end, replacementLength: 0, color: '#6aa9ff', author: 'User',
  });
  try {
    h.render(); const zone = [...h.zones.values()][0];
    assert.equal(zone.heightInPx, 92);
    assert.equal(h.decorations()[0].options.before.content, 'last:0 "Last"');
    const content = zone.domNode.children[0];
    assert.equal(content.style.width, '386px');
    assert.equal(content.style.lineHeight, '23px');
  } finally { h.dispose(); }
});

test('typing continues on the retained original row unless the replacement explicitly starts a new line', () => {
  assert.deepEqual(activeSuggestionPreview('first\nlast', ''), { zoneText: 'first', inlineTail: 'last' });
  assert.deepEqual(activeSuggestionPreview('first\nlast', 'new'), { zoneText: 'first', inlineTail: 'last' });
  assert.deepEqual(activeSuggestionPreview('first\nlast', '\nnew'), { zoneText: 'first\nlast', inlineTail: '' });
  assert.deepEqual(activeSuggestionPreview('first\nlast\n', ''), { zoneText: 'first\nlast', inlineTail: '' });
  assert.deepEqual(activeSuggestionPreview('first\r\nlast\r\n', ''), { zoneText: 'first\nlast', inlineTail: '' });
  assert.deepEqual(activeSuggestionPreview('first\n\n', ''), { zoneText: 'first\n', inlineTail: '' });
  assert.deepEqual(activeSuggestionPreview('first', ''), { zoneText: 'first', inlineTail: '' });
  assert.deepEqual(activeSuggestionPreview('first\r\n\r\nlast', 'new'), { zoneText: 'first\n', inlineTail: 'last' });
  assert.deepEqual(activeSuggestionPreview('first\r\nlast', '\r\nnew'), { zoneText: 'first\nlast', inlineTail: '' });
});

test('Windows CRLF preview preserves the same blank separators and caret row as LF', () => {
  const base = 'header\r\n first\r\n description\r\n\r\n last\r\n next\r\n';
  const start = base.indexOf('first'); const end = base.indexOf('\r\n next');
  const h = rendererHarness(base.slice(0, start) + base.slice(end), {
    baseText: base, start, previousEnd: end, replacementLength: 0, color: '#6aa9ff', author: 'User',
  });
  try {
    h.render(); const zone = [...h.zones.values()][0];
    assert.equal(zone.domNode.textContent, ' first\n description\n');
    assert.equal(zone.heightInPx, 69);
    assert.equal(h.decorations()[0].options.before.content, 'last');
    assert.equal(h.state.suggestionProjection.baseText, base);
    assert.equal(h.state.suggestionProjection.previousEnd, end);
  } finally { h.dispose(); }
});

test('a real blank separator above the retained row is not swallowed by pre-wrap trailing-newline layout', () => {
  const base = 'header\n first\n description\n\n last\n next\n';
  const start = base.indexOf('first'); const end = base.indexOf('\n next');
  const h = rendererHarness(base.slice(0, start) + base.slice(end), {
    baseText: base, start, previousEnd: end, replacementLength: 0, color: '#6aa9ff', author: 'User',
  });
  try {
    h.render(); const zone = [...h.zones.values()][0];
    assert.equal(zone.domNode.textContent, ' first\n description\n');
    assert.equal(zone.heightInPx, 69);
    assert.equal(zone.domNode.children[0].children[0].style.width, '0');
    assert.equal(h.decorations()[0].options.before.content, 'last');
  } finally { h.dispose(); }
});
