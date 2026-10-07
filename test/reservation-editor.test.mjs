import assert from 'node:assert/strict';
import test from 'node:test';
import { createReservationEditor } from '../apps/review/src/reservation-editor.ts';
import { parseAgentMessage } from '../apps/review/src/agent-message.ts';

class Element extends EventTarget {
  value = ''; textContent = ''; hidden = false; disabled = false; title = ''; children = [];
  classList = { add() {}, remove() {} };
  get options() { return this.children; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  focus() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function harness(t) {
  const elements = new Map();
  const previous = globalThis.document;
  globalThis.document = { querySelector: (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  }, createElement: () => new Element() };
  t.after(() => { globalThis.document = previous; });
  const original = { id: 'stable', revision: 1, assigneeId: 'alice', assignee: 'Alice',
    comment: 'Original', keyCount: 1, status: 'active', startByte: 0, endByte: 20, color: '#112233' };
  const state = { path: 'C:/repo/file.yml', reservationUpdates: true, selectedReservation: 'stable',
    reservations: new Map([['stable', original]]), reservationTargets: [
      { id: 'alice', displayName: 'Alice', color: '#112233' }, { id: 'bob', displayName: 'Bob', color: '#abcdef' } ] };
  const sent = [], toasts = []; let writable = true;
  const source = 'l_russian:\n first:0 "Один"\n second:0 "Два"\n';
  const selection = { start: 11, end: Buffer.byteLength(source) };
  const controller = createReservationEditor({ state, editor: { getValue: () => source },
    selectionBytes: () => selection, send: (message) => sent.push(message), showToast: (message) => toasts.push(message),
    canEditReservations: () => writable, anchor: (command) => ({ ...command, reviewAnchors: 'captured-at-selection' }) });
  t.after(controller.dispose);
  const get = (name) => elements.get(`#reservation-${name}`);
  controller.refresh();
  return { controller, state, get, sent, toasts, original, setWritable: (value) => { writable = value; } };
}

test('reservation form sends only changed fields and waits for a matching confirmation', (t) => {
  const { controller, get, sent, state } = harness(t);
  get('edit').click(); assert.equal(controller.hasDraft(), true); assert.equal(get('editor').hidden, false);
  assert.equal(get('edit-comment').value, 'Original'); assert.equal(get('edit-target').value, 'alice');
  get('edit-target').value = 'bob'; get('edit-comment').value = 'New'; get('edit-save').click();
  assert.equal(sent.length, 1); assert.equal(sent[0].id, 'stable'); assert.equal(sent[0].expectedRevision, 1);
  assert.equal(sent[0].assigneeId, 'bob'); assert.equal(sent[0].comment, 'New');
  assert.equal(sent[0].startByte, undefined); assert.equal(get('edit-save').disabled, true);
  assert.equal(controller.hasDraft(), true); assert.equal(state.reservations.get('stable').comment, 'Original');
  controller.receive({ requestId: 'someone-else', id: 'stable', status: 'saved', revision: 2 });
  assert.equal(controller.hasDraft(), true);
  controller.receive({ requestId: sent[0].requestId, id: 'stable', status: 'saved', revision: 2 });
  assert.equal(controller.hasDraft(), false); assert.equal(get('editor').hidden, true);
});

test('explicit range selection captures anchors once; cancellation and reset never modify the reservation', (t) => {
  const { controller, get, sent } = harness(t);
  get('edit').click(); get('edit-selection').click();
  assert.match(get('edit-range').textContent, /2 ключ/);
  get('edit-save').click(); assert.equal(sent[0].reviewAnchors, 'captured-at-selection');
  assert.equal(sent[0].comment, undefined); assert.equal(sent[0].assigneeId, undefined);
  controller.receive({ requestId: sent[0].requestId, id: 'stable', status: 'error', message: 'Rejected' });
  get('edit-reset-range').click(); get('edit-cancel').click();
  assert.equal(controller.hasDraft(), false); assert.equal(sent.length, 1);
});

test('remote changes never overwrite draft input and require explicit reload before saving', (t) => {
  const { controller, get, state, original, sent } = harness(t);
  get('edit').click(); get('edit-comment').value = 'My draft'; get('edit-target').value = 'bob';
  state.reservations.set('stable', { ...original, revision: 2, comment: 'Someone else' }); controller.refresh();
  assert.equal(get('edit-comment').value, 'My draft'); assert.equal(get('edit-target').value, 'bob');
  assert.equal(get('edit-save').disabled, true); assert.equal(get('edit-reload').hidden, false);
  get('edit-save').click(); assert.equal(sent.length, 0);
  get('edit-reload').click(); assert.equal(get('edit-comment').value, 'Someone else');
  get('edit-comment').value = 'Revised draft'; get('edit-save').click(); assert.equal(sent[0].expectedRevision, 2);
  controller.receive({ requestId: sent[0].requestId, id: 'stable', status: 'error', message: 'Rejected' });
  assert.equal(get('edit-comment').value, 'Revised draft'); assert.equal(get('editor').hidden, false);
});

test('deletion keeps the form, disables save and cannot silently recreate the reservation', (t) => {
  const { controller, get, state, sent } = harness(t);
  get('edit').click(); get('edit-comment').value = 'My draft'; state.reservations.clear(); controller.refresh();
  assert.equal(get('edit-comment').value, 'My draft'); assert.equal(get('edit-save').disabled, true);
  assert.match(get('edit-status').textContent, /удалена/); get('edit-save').click(); assert.equal(sent.length, 0);
});

test('unsupported server and read-only state disable editing without losing an open draft', (t) => {
  const { controller, get, state, setWritable } = harness(t);
  state.reservationUpdates = false; controller.refresh(); assert.equal(get('edit').disabled, true);
  state.reservationUpdates = true; controller.refresh(); get('edit').click(); get('edit-comment').value = 'Draft';
  setWritable(false); controller.refresh(); assert.equal(get('edit-save').disabled, true);
  assert.equal(get('edit-comment').value, 'Draft'); assert.equal(controller.hasDraft(), true);
});

test('timeout releases the form without success or automatic retry, and keeps input', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, get, sent } = harness(t);
  get('edit').click(); get('edit-comment').value = 'Draft'; get('edit-save').click();
  t.mock.timers.tick(15001);
  assert.equal(get('edit-save').disabled, false); assert.equal(get('edit-comment').value, 'Draft');
  assert.equal(controller.hasDraft(), true); assert.equal(sent.length, 1); assert.match(get('edit-status').textContent, /Подтверждение/);
});

test('Review validates update result envelopes and optional legacy revision/capability fields', () => {
  assert.ok(parseAgentMessage({ type: 'reservationUpdateResult', id: 'stable', requestId: 'one', status: 'saved', revision: 2 }));
  assert.equal(parseAgentMessage({ type: 'reservationUpdateResult', id: 'stable', requestId: 'one', status: 'unknown' }), null);
  assert.equal(parseAgentMessage({ type: 'reservationSnapshot', canUpdate: 'yes' }), null);
  assert.equal(parseAgentMessage({ type: 'reservationUpdateResult', id: 'stable', requestId: 'one', status: 'saved' }), null);
});
