import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRepositorySyncPanel } from '../apps/review/src/repository-sync-panel.ts';

class Element extends EventTarget {
  disabled = false; hidden = false; open = false; textContent = ''; title = '';
  showModal() { this.open = true; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const checkout = { branch: 'barrad', head: 'a'.repeat(40), upstream: 'refs/remotes/fork/barrad',
  remote: 'fork', remoteRef: 'refs/heads/barrad' };
const idle = { stage: 'disabled', message: 'Automation off', checkout, busy: false };
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function withPanel(options, callback) {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  const ids = ['repository-update', 'repository-sync-dialog', 'repository-sync-message', 'repository-sync-progress'];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const calls = [], toasts = [], confirmations = [];
  const button = elements['repository-update'];
  let panel;
  try {
    globalThis.document = { querySelector: (selector) => elements[selector.slice(1)] };
    globalThis.fetch = async (url, init) => {
      calls.push({ url, ...init });
      assert.equal(init.headers.Authorization, 'Bearer local-session');
      assert.equal(init.cache, 'no-store');
      return options.fetch ? options.fetch(init, calls) : { ok: true, json: async () => idle };
    };
    panel = createRepositorySyncPanel({ token: 'local-session', showToast: (...args) => toasts.push(args),
      confirm: async (...args) => { confirmations.push(args); return options.confirm?.(...args) ?? false; } });
    await callback({ panel, button, elements, calls, toasts, confirmations });
  } finally {
    panel?.dispose(); globalThis.fetch = previous.fetch;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
  }
}

test('Review update remains available in read-only contexts and cancellation never requests Git mutation', async () => {
  const html = fs.readFileSync(new URL('../apps/review/src/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="repository-update"[^>]*>Обновить репозиторий/u);
  assert.doesNotMatch(html, /id="repository-update"[^>]*disabled/u);
  await withPanel({}, async ({ button, calls, confirmations, elements }) => {
    button.click(); await turn();
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
    assert.match(confirmations[0][1], /barrad/u);
    assert.match(confirmations[0][1], /fast-forward/u);
    assert.equal(elements['repository-sync-dialog'].open, false);
    assert.equal(button.disabled, false);
  });
});

test('Review confirms pinned checkout, blocks double clicks, polls results and explains local changes', async () => {
  let finishPost;
  await withPanel({ confirm: () => true, fetch(init, calls) {
    if (init.method === 'POST') return new Promise((resolve) => { finishPost = () => resolve({ ok: true,
      json: async () => ({ ...idle, stage: 'fetching', busy: true, message: 'Fetching' }) }); });
    return { ok: true, json: async () => calls.length > 1
      ? { ...idle, stage: 'blocked', message: 'Local translations must be committed', behind: 1, reason: 'dirty' } : idle };
  } }, async ({ button, calls, elements, toasts }) => {
    button.click(); button.click(); await turn();
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.deepEqual(JSON.parse(calls[1].body), { action: 'update', confirmed: true, checkout });
    assert.equal(button.disabled, true); assert.equal(elements['repository-sync-progress'].hidden, false);
    assert.equal(elements['repository-sync-dialog'].open, true);
    button.click(); finishPost(); await turn(); await turn();
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(button.disabled, false); assert.equal(elements['repository-sync-progress'].hidden, true);
    assert.match(elements['repository-sync-message'].textContent, /Local translations/u);
    assert.deepEqual(toasts.at(-1), ['Local translations must be committed', true]);
  });
});

test('Review attaches to an existing Agent operation without another update or confirmation', async () => {
  await withPanel({ fetch: (_init, calls) => ({ ok: true, json: async () => calls.length === 1
    ? { ...idle, stage: 'updating', busy: true, message: 'Updating' }
    : { ...idle, stage: 'updated', message: 'Updated' } }) }, async ({ button, calls, confirmations }) => {
    button.click(); await turn(); await turn();
    assert.equal(calls.length, 2); assert.equal(calls.every((call) => call.method === 'GET'), true);
    assert.equal(confirmations.length, 0); assert.equal(button.disabled, false);
  });
});

test('Review preserves a rejected stale-branch error instead of displaying an unrelated previous success', async () => {
  await withPanel({ confirm: () => true, fetch: (init) => init.method === 'POST'
    ? { ok: false, json: async () => ({ error: 'Branch changed. Confirm again.' }) }
    : { ok: true, json: async () => idle } }, async ({ button, calls, elements }) => {
    button.click(); await turn();
    assert.equal(calls.length, 2); assert.equal(button.disabled, false);
    assert.match(elements['repository-sync-message'].textContent, /Confirm again/u);
  });
});

test('Review recovers a lost POST response with read-only polling, never resubmits mutation', async () => {
  await withPanel({ confirm: () => true, fetch: (init, calls) => {
    if (init.method === 'POST') throw new Error('Response lost');
    return { ok: true, json: async () => calls.length === 1 ? idle : { ...idle, stage: 'updated', message: 'Updated' } };
  } }, async ({ button, calls, toasts }) => {
    button.click(); await turn(); await turn();
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(calls.at(-1).method, 'GET'); assert.equal(button.disabled, false);
    assert.deepEqual(toasts.at(-1), ['Updated', false]);
  });
});

test('Review disposal prevents a deferred confirmation from updating the repository', async () => {
  let decide;
  await withPanel({ confirm: () => new Promise((resolve) => { decide = resolve; }) },
    async ({ panel, button, calls }) => {
      button.click(); await turn(); panel.dispose(); decide(true); await turn();
      assert.equal(calls.length, 1);
    });
});
