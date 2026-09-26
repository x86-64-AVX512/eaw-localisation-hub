import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntaxDiagnostics, diagnosticsToMarkers } from '../apps/review/src/syntax-diagnostics.ts';

test('Monaco markers include an exact range and a link to the first duplicate', () => {
  const monaco = { MarkerSeverity: { Error: 8, Warning: 4, Info: 2 } };
  const model = { uri: 'file:///test.yml' };
  const markers = diagnosticsToMarkers(monaco, model, [{
    code: 'duplicate-key', severity: 'error', message: 'Повтор',
    lineNumber: 3, startColumn: 2, endColumn: 10,
    related: { lineNumber: 1, startColumn: 2, endColumn: 10 },
  }]);
  assert.equal(markers[0].severity, 8);
  assert.equal(markers[0].startLineNumber, 3);
  assert.equal(markers[0].relatedInformation[0].startLineNumber, 1);
  assert.equal(diagnosticsToMarkers(monaco, model, [{
    code: 'unresolved-local-reference', severity: 'info', message: 'Не найден',
    lineNumber: 4, startColumn: 1, endColumn: 5,
  }])[0].severity, 2);
});

test('typing preserves existing markers until a current worker result replaces them', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalWorker = globalThis.Worker;
  const originalDocument = globalThis.document;
  const elements = new Map();
  function element(name) {
    if (!elements.has(name)) elements.set(name, {
      hidden: false, textContent: '', open: false, addEventListener() {},
      close() { this.open = false; }, showModal() { this.open = true; },
      replaceChildren() {}, append() {},
    });
    return elements.get(name);
  }
  class FakeWorker {
    constructor() { this.messages = []; FakeWorker.instance = this; }
    postMessage(message) { this.messages.push(message); }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  globalThis.document = { querySelector: element, createElement: () => element('new') };
  t.after(() => { globalThis.Worker = originalWorker; globalThis.document = originalDocument; });

  const calls = [];
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: { setModelMarkers(model, owner, markers) { calls.push({ model, owner, markers }); } },
  };
  const model = { uri: 'file:///test.yml', value: 'broken', version: 1,
    getVersionId() { return this.version; }, getValue() { return this.value; } };
  let onContent;
  const editor = {
    getModel: () => model,
    onDidChangeModelContent(callback) { onContent = callback; return { dispose() {} }; },
    onDidChangeModel() { return { dispose() {} }; },
  };
  const controller = createSyntaxDiagnostics({ monaco, editor, showToast() {},
    getFilePath: () => 'localisation/russian/test_l_russian.yml' });
  t.mock.timers.tick(180);
  const first = FakeWorker.instance.messages[0];
  assert.equal(first.filePath, 'localisation/russian/test_l_russian.yml');
  FakeWorker.instance.onmessage({ data: { id: first.id, version: first.version,
    diagnostics: [{ code: 'unclosed-quote', severity: 'error', message: 'Не закрыта',
      lineNumber: 1, startColumn: 1, endColumn: 6 }] } });
  assert.equal(calls.length, 1);

  model.value = 'broken but different'; model.version += 1; onContent();
  t.mock.timers.tick(180);
  const unchanged = FakeWorker.instance.messages[1];
  FakeWorker.instance.onmessage({ data: { id: unchanged.id, version: unchanged.version,
    diagnostics: [{ code: 'unclosed-quote', severity: 'error', message: 'Не закрыта',
      lineNumber: 1, startColumn: 1, endColumn: 6 }] } });
  assert.equal(calls.length, 1, 'an unchanged issue is not redrawn');

  model.value = 'still broken'; model.version += 1; onContent();
  assert.equal(calls.length, 1, 'the old underline is not cleared on each keystroke');
  t.mock.timers.tick(180);
  const stale = FakeWorker.instance.messages[2];
  model.value = 'repaired'; model.version += 1; onContent();
  FakeWorker.instance.onmessage({ data: { id: stale.id, version: stale.version, diagnostics: [] } });
  assert.equal(calls.length, 1, 'a stale response cannot remove the underline');
  t.mock.timers.tick(180);
  const current = FakeWorker.instance.messages[3];
  FakeWorker.instance.onmessage({ data: { id: current.id, version: current.version, diagnostics: [] } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].markers, []);
  controller.dispose();
});
