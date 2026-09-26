import assert from 'node:assert/strict';
import test from 'node:test';

test('syntax worker fetches the repository index and checks references off the UI thread', async (t) => {
  const previousSelf = globalThis.self;
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const messages = [];
  const requests = [];
  globalThis.self = { postMessage(message) { messages.push(message); } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ complete: true, keys: ['EYE_known'] }) };
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.self = previousSelf;
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousSetInterval;
    globalThis.clearInterval = previousClearInterval;
  });

  await import('../apps/review/src/syntax-worker.ts');
  globalThis.self.onmessage({ data: { type: 'init-key-index', token: 'local-token' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].url, '/api/localisation-key-index');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer local-token');
  assert.ok(messages.some((message) => message.type === 'key-index-ready'));

  globalThis.self.onmessage({ data: {
    id: 7, version: 1, filePath: 'localisation/russian/test_l_russian.yml',
    text: 'l_russian:\nEYE_test:0 "$EYE_missing$"',
  } });
  const result = messages.find((message) => message.id === 7);
  assert.ok(result.diagnostics.some((issue) => issue.code === 'unresolved-local-reference'));
  globalThis.self.onmessage({ data: {
    id: 8, version: 1, filePath: 'localisation/russian/test_l_russian.yml',
    text: 'EYE_test:0 "Текст"',
  } });
  assert.ok(messages.find((message) => message.id === 8).diagnostics
    .some((issue) => issue.code === 'missing-header'));
});
