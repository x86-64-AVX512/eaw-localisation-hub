import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentActions } from '../apps/review/src/comment-actions.ts';
import { decodeBase64 } from '../apps/review/src/review-utilities.ts';

function setup() {
  const sent = [], notices = [], events = new Map();
  let descriptor, version = 1, menuEnabled = false, readOnly = false;
  const state = { path: 'test.yml', ready: true, documentView: 'shared' };
  const button = { disabled: false, hidden: false, addEventListener(k, v) { events.set(k, v); },
    removeEventListener(k) { events.delete(k); } };
  const model = { getVersionId: () => version };
  const editor = { getOption: () => readOnly, getModel: () => model,
    createContextKey: () => ({ set(v) { menuEnabled = v; }, reset() { menuEnabled = false; } }),
    addAction(v) { descriptor = v; return { dispose() {} }; },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeModel: () => ({ dispose() {} }), onMouseDown: () => ({ dispose() {} }) };
  let range = { start: 4, end: 12 };
  const options = { monaco: { editor: { EditorOption: { readOnly: 1 } } }, editor, button, state,
    selectionBytes: () => range, askText: async () => '  Комментарий 🦄  ',
    send: (m) => sent.push(m), showToast: (text, error) => notices.push({ text, error }) };
  return { options, sent, notices, events, state, button, get action() { return descriptor; },
    get enabled() { return menuEnabled; }, moveSelection(v) { range = v; },
    changeText() { version += 1; }, setReadOnly(v) { readOnly = v; } };
}

test('toolbar and context menu share the comment action and captured selection', async () => {
  const s = setup();
  s.options.askText = async () => { s.moveSelection({ start: 0, end: 0 }); return 'Комментарий 🦄'; };
  const controller = createCommentActions(s.options);
  assert.equal(s.action.label, 'Создать комментарий');
  assert.equal(s.action.contextMenuGroupId, '1_modification');
  assert.equal(s.enabled, true);
  await s.action.run();
  assert.equal(s.sent[0].startByte, 4);
  assert.equal(s.sent[0].endByte, 12);
  assert.equal(decodeBase64(s.sent[0].bodyBase64), 'Комментарий 🦄');
  s.events.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.sent.length, 2);
  controller.dispose();
  assert.equal(s.events.has('click'), false);
});

test('comment action allows an empty selection but refuses readonly, disconnected and variant views', async () => {
  const s = setup(); s.moveSelection({ start: 5, end: 5 });
  const controller = createCommentActions(s.options);
  await controller.create();
  assert.equal(s.sent[0].startByte, s.sent[0].endByte);
  for (const block of [() => { s.state.ready = false; }, () => { s.state.documentView = 'mine'; },
    () => { s.button.disabled = true; }, () => { s.button.hidden = true; }, () => s.setReadOnly(true)]) {
    s.state.ready = true; s.state.documentView = 'shared'; s.button.disabled = false; s.button.hidden = false;
    s.setReadOnly(false); block(); controller.refresh();
    assert.equal(s.enabled, false);
    await controller.create();
    assert.equal(s.sent.length, 1);
  }
});

test('cancel and whitespace create no comments', async () => {
  for (const value of [null, '', ' \n ']) {
    const s = setup(); s.options.askText = async () => value;
    await createCommentActions(s.options).create();
    assert.equal(s.sent.length, 0);
  }
});

test('captured CRDT anchors survive selection changes and are not recomputed at submit', async () => {
  const s = setup(); let anchorCalls = 0;
  s.options.anchor = (m) => { anchorCalls += 1; return { ...m, reviewAnchors: 'captured-before-dialog' }; };
  s.options.askText = async () => { s.changeText(); return 'Текст'; };
  await createCommentActions(s.options).create();
  assert.equal(anchorCalls, 1);
  assert.equal(s.sent[0].reviewAnchors, 'captured-before-dialog');
});

test('an unanchored changed document or switched file cannot receive a stale comment', async () => {
  for (const change of [(s) => s.changeText(), (s) => { s.state.path = 'other.yml'; }]) {
    const s = setup(); s.options.askText = async () => { change(s); return 'Текст'; };
    await createCommentActions(s.options).create();
    assert.equal(s.sent.length, 0);
    assert.equal(s.notices[0].error, true);
  }
});

test('repeated clicks while the dialog is open do not open another dialog', async () => {
  const s = setup(); let answer, calls = 0;
  s.options.askText = () => { calls += 1; return new Promise((resolve) => { answer = resolve; }); };
  const controller = createCommentActions(s.options);
  const first = controller.create();
  await controller.create();
  assert.equal(calls, 1);
  assert.equal(s.enabled, false);
  answer('Комментарий'); await first;
  assert.equal(s.enabled, true);
  assert.equal(s.sent.length, 1);
});
