import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceTabs, workspaceTabLabel } from '../apps/review/src/workspace-tabs.ts';

const storageKey = 'eaw-hub-workspace-tabs-v1';
const tab = (name, ticket = '') => ({ path: `C:/repo/localisation/russian/${name}.yml`,
  relativePath: `localisation/russian/${name}.yml`, ticket });
const A = tab('A'), B = tab('B'), C = tab('C');

test('compact tab labels distinguish language and ticket without losing arbitrary filenames', () => {
  assert.equal(workspaceTabLabel(tab('country_BAR_l_russian')), 'BAR · RU');
  assert.equal(workspaceTabLabel({ ...tab('country_BAR_l_english'), ticket:'ticket-123456789', ticketTitle:'Reactor' }), 'BAR · EN · Reactor');
  assert.equal(workspaceTabLabel({ ...tab('country_BAR_l_russian'), ticket:'ticket-123456789' }), 'BAR · RU · ticket-1');
  assert.equal(workspaceTabLabel({ path:'C:\\repo\\localisation\\english\\events.yml', relativePath:'', ticket:'' }), 'events · EN');
  assert.equal(workspaceTabLabel({ path:'C:/repo/custom.txt', relativePath:'', ticket:'' }), 'custom.txt');
});

class Element extends EventTarget {
  children = []; className = ''; textContent = ''; scrollLeft = 0;
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    contains: (name) => this.className.split(' ').includes(name),
  };
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector); }
  getBoundingClientRect() { return { left: 0, right: 100, width: 100 }; }
  get lastElementChild() { return this.children.at(-1); }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
  close() {}
}

function dragEvent(element, type, clientX = 10) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, { clientX: { value: clientX }, dataTransfer: { value: { setData() {} } } });
  element.dispatchEvent(event);
  return event;
}

async function withTabs(initial, current, callback) {
  const names = ['document', 'localStorage', 'location', 'Element'];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  let saved = JSON.stringify({ tabs: initial }), elements, controller, reloads = 0;
  try {
    globalThis.Element = Element;
    globalThis.localStorage = { getItem: () => saved, setItem(key, value) { assert.equal(key, storageKey); saved = value; } };
    globalThis.location = { hash: '', reload() { reloads++; } };
    function mount(request = current) {
      elements = Object.fromEntries(['document-tabs', 'document-tab-list', 'document-tab-add', 'file-picker-dialog',
        'file-picker-search', 'file-picker-files', 'file-picker-close'].map((id) => [id, new Element()]));
      globalThis.document = { querySelector: (selector) => elements[selector.slice(1)], createElement: () => new Element() };
      controller = createWorkspaceTabs({ token: 'fixture', requestedPath: request.path,
        requestedTicket: request.ticket, readOnlyMode: '', showToast() {} });
      return controller;
    }
    mount();
    await callback({ mount, confirm: (confirmed = current) => controller.confirmPath(confirmed.path, confirmed.relativePath,
      confirmed.ticket ? { id: confirmed.ticket } : null),
    saved: () => JSON.parse(saved).tabs, buttons: () => elements['document-tab-list'].children,
    list: () => elements['document-tab-list'], reloads: () => reloads, controller: () => controller });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name];
    }
  }
}

test('activating and confirming tabs repeatedly preserves opening order, names and editor position', async () => {
  await withTabs([A, B, C], B, async (f) => {
    assert.equal(f.buttons()[1].title, B.relativePath, 'startup must not replace a saved label with an absolute path');
    const editor = { getPosition: () => ({ lineNumber: 42, column: 7 }), getScrollTop: () => 520 };
    f.controller().remember(editor);
    for (const current of [B, A, C, B]) {
      f.mount(current); f.confirm(current); f.confirm(current);
      assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path]);
    }
    const restored = {};
    f.controller().restore({ setPosition: (position) => { restored.position = position; },
      setScrollTop: (top) => { restored.top = top; } }, B.path);
    assert.deepEqual(restored, { position: { lineNumber: 42, column: 7 }, top: 520 });
  });
});

test('new tabs append; canonical path confirmation replaces the placeholder in its existing slot', async () => {
  const alias = { ...B, path: 'relative/B.yml', line: 23 };
  await withTabs([A, alias, C], alias, async (f) => {
    f.confirm(B);
    assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path]);
    assert.equal(f.saved()[1].line, 23);
    const D = tab('D'); f.mount(D); f.confirm(D);
    assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path, D.path]);
  });
});

test('confirmation of a path alias deduplicates without moving an already-open canonical tab', async () => {
  const alias = { ...B, path: 'relative/B.yml' };
  await withTabs([A, B, C, alias], alias, async (f) => {
    f.confirm(B);
    assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path]);
    assert.equal(f.buttons()[1].classList.contains('active'), true);
  });
});

test('the same filename in main and different tickets remains three distinct stable tabs', async () => {
  const tabs = [A, { ...A, ticket: 'first' }, { ...A, ticket: 'second' }];
  await withTabs(tabs, tabs[1], async (f) => {
    for (const current of [tabs[1], tabs[0], tabs[2]]) { f.mount(current); f.confirm(current); }
    assert.deepEqual(f.saved().map((item) => item.ticket), ['', 'first', 'second']);
  });
});

test('dragging before and after another tab persists order without activation or navigation', async () => {
  await withTabs([A, { ...B, line: 42 }, C], B, async (f) => {
    dragEvent(f.buttons()[2], 'dragstart');
    assert.equal(dragEvent(f.buttons()[0], 'dragover').defaultPrevented, true);
    assert.equal(f.buttons()[0].classList.contains('drop-before'), true);
    dragEvent(f.buttons()[0], 'drop');
    assert.deepEqual(f.saved().map((item) => item.path), [C.path, A.path, B.path]);
    assert.equal(f.buttons()[2].classList.contains('active'), true);
    assert.equal(f.saved()[2].line, 42); assert.equal(f.reloads(), 0);
    f.confirm(); f.mount(); f.confirm();
    assert.deepEqual(f.saved().map((item) => item.path), [C.path, A.path, B.path]);
    dragEvent(f.buttons()[1], 'dragstart');
    dragEvent(f.buttons()[2], 'dragover', 90);
    assert.equal(f.buttons()[2].classList.contains('drop-after'), true);
    dragEvent(f.buttons()[2], 'drop', 90);
    assert.deepEqual(f.saved().map((item) => item.path), [C.path, B.path, A.path]);
    assert.equal(f.buttons()[1].classList.contains('active'), true);
    assert.equal(f.reloads(), 0);
  });
});

test('dragging to the strip end works; closing the active tab chooses its adjacent survivor', async () => {
  await withTabs([A, B, C], B, async (f) => {
    dragEvent(f.buttons()[0], 'dragstart'); dragEvent(f.list(), 'drop', 90);
    assert.deepEqual(f.saved().map((item) => item.path), [B.path, C.path, A.path]);
    f.buttons()[0].children[1].click();
    assert.deepEqual(f.saved().map((item) => item.path), [C.path, A.path]);
    assert.equal(new URLSearchParams(globalThis.location.hash).get('path'), C.path);
    assert.equal(f.reloads(), 1);
  });
});

test('cancelled and external drags never reorder tabs or accidentally switch documents', async (t) => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  await withTabs([A, B, C], A, async (f) => {
    assert.equal(dragEvent(f.buttons()[2], 'drop').defaultPrevented, false);
    const button = f.buttons()[1]; dragEvent(button, 'dragstart'); dragEvent(button, 'dragend'); button.click();
    assert.equal(f.reloads(), 0);
    assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path]);
    now += 151; button.click(); assert.equal(f.reloads(), 1);
  });
});

test('path confirmation during a drag cancels stale DOM events without changing the tab order', async () => {
  await withTabs([A, B, C], B, async (f) => {
    const source = f.buttons()[0], target = f.buttons()[2];
    dragEvent(source, 'dragstart'); f.confirm();
    assert.equal(dragEvent(target, 'drop', 90).defaultPrevented, false);
    assert.deepEqual(f.saved().map((item) => item.path), [A.path, B.path, C.path]);
    assert.equal(f.buttons()[1].classList.contains('active'), true);
    assert.equal(f.reloads(), 0);
  });
});
