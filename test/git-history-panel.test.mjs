import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHistoryPanel } from '../apps/review/src/git-history-panel.ts';

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    open: false, hidden: false, disabled: false, value: '', textContent: '',
    style: { setProperty() {} },
    classList: {
      add(value) { classes.add(value); },
      contains(value) { return classes.has(value); },
      toggle(value, force) {
        if (force !== undefined) {
          if (force) classes.add(value);
          else classes.delete(value);
          return force;
        }
        if (classes.has(value)) { classes.delete(value); return false; }
        classes.add(value); return true;
      },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    fire(type) { listeners.get(type)?.({ currentTarget: this }); },
    append() {}, replaceChildren() {}, remove() {},
    querySelector() { return { textContent: '', title: '' }; },
    showModal() { this.open = true; },
    close() { this.open = false; this.fire('close'); },
  };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Git history panel did not settle');
}

test('reopening the same Git comparison reuses Monaco models and only validates HEAD', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const elements = new Map();
  const windowListeners = new Map();
  const models = [];
  const calls = { history: 0, diff: 0, head: 0, setModel: 0, originalLayouts: 0, editors: 0 };
  let headCommit = 'a'.repeat(40);
  const revision = '1'.repeat(40);
  const relativePath = 'localisation/russian/test.yml';
  const state = { path: 'C:\\repo\\localisation\\russian\\test.yml', relativePath };
  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
    createElement: fakeElement,
  };
  globalThis.window = {
    cancelAnimationFrame() {},
    requestAnimationFrame() { return 1; },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type) { windowListeners.delete(type); },
    dispatchEvent(event) { windowListeners.get(event.type)?.(event); },
  };
  globalThis.fetch = async (url) => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/git-history/head') {
      calls.head += 1;
      return Response.json({ headCommit });
    }
    if (parsed.pathname === '/api/git-history/diff') {
      calls.diff += 1;
      return Response.json({
        fromCommit: parsed.searchParams.get('from'), toCommit: parsed.searchParams.get('to'),
        baseBase64: Buffer.from('Old').toString('base64'),
        headBase64: Buffer.from(`New ${headCommit}`).toString('base64'),
      });
    }
    if (parsed.pathname === '/api/git-history') {
      calls.history += 1;
      return Response.json({
        headCommit, nextOffset: 1, hasMore: false,
        entries: [{ commit: revision, shortCommit: revision.slice(0, 10),
          author: 'Tester', subject: 'Edit', date: '2026-09-22T00:00:00Z', historicalPath: relativePath }],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const monaco = { editor: {
    createModel(initial) {
      const model = { value: initial, writes: 0,
        setValue(value) { this.value = value; this.writes += 1; },
        getLineCount() { return 1; }, dispose() {} };
      models.push(model);
      return model;
    },
    createDiffEditor(_container, options) {
      calls.editors += 1;
      assert.equal(options.automaticLayout, false, 'warm Git diff does not relayout while closed');
      assert.equal(options.maxComputationTime, 500);
      const originalPane = {
        updateOptions() {}, setHiddenAreas() {},
        layout() { calls.originalLayouts += 1; },
      };
      const modifiedPane = { updateOptions() {}, setHiddenAreas() {} };
      let listener = null;
      return {
        setModel() {
          calls.setModel += 1;
          queueMicrotask(() => listener?.());
        },
        updateOptions() {}, getOriginalEditor() { return originalPane; },
        getModifiedEditor() { return modifiedPane; },
        getLineChanges() { return [{ originalStartLineNumber: 1, modifiedStartLineNumber: 1 }]; },
        onDidUpdateDiff(callback) {
          listener = callback;
          return { dispose() { listener = null; } };
        },
        layout() {}, dispose() {},
      };
    },
  } };
  try {
    const panel = createGitHistoryPanel({
      monaco, token: 'test', showToast() {},
      state,
    });
    const open = elements.get('#git-history-open');
    const close = elements.get('#git-history-close');
    const dialog = elements.get('#git-history-dialog');
    open.fire('click');
    assert.equal(dialog.inert, false);
    await waitUntil(() => calls.diff === 1 && models[1].value === `New ${headCommit}`
      && elements.get('#git-history-selection').textContent === '1111111111 → aaaaaaaaaa');
    const writes = models.map((model) => model.writes);
    close.fire('click');
    assert.equal(dialog.inert, true);
    open.fire('click');
    await waitUntil(() => calls.head === 1);
    assert.deepEqual([calls.history, calls.diff, calls.setModel], [1, 1, 1]);
    assert.deepEqual(models.map((model) => model.writes), writes);
    assert.ok(calls.originalLayouts > 0, 'opening restores the original pane wrapping geometry');

    const fromSelect = elements.get('#git-history-from');
    const toSelect = elements.get('#git-history-to');
    fromSelect.value = 'HEAD';
    toSelect.value = revision;
    toSelect.fire('change');
    await waitUntil(() => calls.diff === 2 && calls.editors === 2
      && elements.get('#git-history-selection').textContent === 'aaaaaaaaaa → 1111111111');
    assert.match(elements.get('#git-history-selection').textContent, /aaaaaaaaaa → 1111111111/u,
      JSON.stringify(calls));
    fromSelect.value = revision;
    toSelect.value = 'HEAD';
    toSelect.fire('change');
    assert.deepEqual([calls.diff, calls.editors, calls.setModel], [2, 2, 2],
      'returning to a rendered pair does not fetch, create an editor, or reset its model');
    assert.deepEqual(models.slice(0, 2).map((model) => model.writes), writes);

    close.fire('click');
    headCommit = 'b'.repeat(40);
    open.fire('click');
    await waitUntil(() => calls.diff === 3 && models[5].value === `New ${headCommit}`);
    assert.equal(calls.history, 2, 'a changed HEAD reloads history');

    close.fire('click');
    state.path = 'C:\\repo\\localisation\\russian\\other.yml';
    state.relativePath = 'localisation/russian/other.yml';
    open.fire('click');
    await waitUntil(() => calls.history === 3 && calls.diff === 4);
    assert.equal(calls.head, 2, 'a different file skips the cached-HEAD fast path');

    close.fire('click');
    window.dispatchEvent(new Event('eaw-diff-cache-cleared'));
    open.fire('click');
    await waitUntil(() => calls.history === 4 && calls.diff === 5);
    assert.equal(calls.head, 2, 'clearing the cache invalidates the warm view');
    dialog.fire('cancel');
    dialog.close();
    assert.equal(dialog.inert, true, 'Escape suspends the diff before closing');
    open.fire('click');
    await waitUntil(() => calls.head === 3);
    assert.equal(calls.diff, 5, 'Escape keeps the warm comparison');
    panel.dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
