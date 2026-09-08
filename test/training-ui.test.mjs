import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';
import { createHelpPanel } from '../apps/review/src/help-panel.js';

const SEGMENT_IDS = [
  'start', 'editing', 'suggestions', 'discussion', 'personal-file', 'git-updates',
  'conflicts', 'tickets', 'language-tools', 'history-diff', 'notifications', 'agent-plugin',
];

function fakeElement() {
  const listeners = new Map();
  return {
    checked: true, disabled: false, hidden: true, open: false, textContent: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type) { listeners.get(type)?.({ preventDefault() {} }); },
    showModal() { this.open = true; this.opens = (this.opens ?? 0) + 1; },
    close() { this.open = false; },
  };
}

test('automatic training waits for a server-confirmed incomplete account', (t) => {
  const selectors = [
    '#help-dialog', '#tutorial-dialog', '#tutorial-content', '#tutorial-heading',
    '#tutorial-progress', '#notifications-enabled', '#notification-sound', '#tutorial-back',
    '#tutorial-next', '#help-open', '#help-close', '#tutorial-repeat', '#version-notice',
  ];
  const elements = new Map(selectors.map((selector) => [selector, fakeElement()]));
  const stored = new Map();
  const previousDocument = globalThis.document;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.document = { querySelector: (selector) => elements.get(selector) };
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.localStorage = previousLocalStorage;
  });

  const state = {
    version: '0.8.7F4', serverVersion: '0.8.7F4',
    trainingProgress: {}, trainingProgressConfirmed: false,
  };
  const panel = createHelpPanel({ state, token: 'local', showToast() {} });
  const tutorial = elements.get('#tutorial-dialog');
  panel.refresh();
  assert.equal(tutorial.opens ?? 0, 0, 'an initial local hello is not server confirmation');

  state.trainingProgressConfirmed = true;
  panel.refresh();
  assert.equal(tutorial.opens, 1, 'the server-confirmed incomplete account starts training');

  tutorial.close();
  state.trainingProgress = Object.fromEntries(SEGMENT_IDS.map((id) => [id, 1]));
  panel.refresh();
  assert.equal(tutorial.opens, 1, 'server-confirmed completed training stays closed');
});

test('Agent distinguishes local startup from server-confirmed training progress', () => {
  const messages = [];
  const context = {
    identity: null, serverVersion: '0.8.7F4',
    options: { user: 'Alice', color: '#abcdef', workspace: 'general-dev' },
    clients: new Set(),
  };
  AgentHub.prototype.sendAgentHello.call(context, { send: (message) => messages.push(message) });
  assert.equal(messages.at(-1).trainingProgressConfirmed, false);

  AgentHub.prototype.updateIdentity.call(context, {
    id: 'alice', displayName: 'Alice', roles: [], avatarBase64: '',
  });
  AgentHub.prototype.sendAgentHello.call(context, { send: (message) => messages.push(message) });
  assert.equal(messages.at(-1).trainingProgressConfirmed, false,
    'the compact WebSocket identity does not confirm training progress');

  AgentHub.prototype.updateIdentity.call(context, {
    id: 'alice', displayName: 'Alice', roles: [], avatarBase64: '', trainingProgress: {},
  });
  AgentHub.prototype.sendAgentHello.call(context, { send: (message) => messages.push(message) });
  assert.equal(messages.at(-1).trainingProgressConfirmed, true);

  AgentHub.prototype.updateIdentity.call(context, {
    id: 'alice', displayName: 'Alice', roles: [], avatarBase64: '',
  });
  AgentHub.prototype.sendAgentHello.call(context, { send: (message) => messages.push(message) });
  assert.equal(messages.at(-1).trainingProgressConfirmed, true,
    'a later compact identity cannot erase the earlier server confirmation');
});
