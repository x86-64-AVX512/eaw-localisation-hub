import assert from 'node:assert/strict';
import test from 'node:test';

test('syntax worker fetches the repository index and checks references off the UI thread', async (t) => {
  const previousSelf = globalThis.self;
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const messages = [];
  const requests = [];
  let indexPayload = { complete: true, languages: { russian: { complete: true, keys: ['EYE_known'] } } };
  let diskPayload = { diagnostics: [] };
  globalThis.self = { postMessage(message) { messages.push(message); } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.startsWith('/api/localisation-file-diagnostics') ? diskPayload : indexPayload };
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

  indexPayload = { complete: true, languages: {
    russian: { complete: true, keys: ['EYE_known'] },
    english: { complete: true, keys: ['EYE_english_only'] },
  }, scripted: { complete: true, definitions: [{ name: 'GetRaceMembers' }] }, documentedGetters: ['GetName'] };
  globalThis.self.onmessage({ data: { type: 'init-key-index', token: 'local-token' } });
  await new Promise((resolve) => setImmediate(resolve));
  const text = 'l_russian:\n EYE_test:0 "$EYE_english_only$ [Root.GetRaceMemebrs]"';
  globalThis.self.onmessage({ data: { id: 9, version: 2, filePath: 'localisation/russian/test_l_russian.yml', text } });
  assert.deepEqual(messages.find((message) => message.id === 9).diagnostics.map((item) => item.code),
    ['unresolved-local-reference', 'likely-getter-typo']);

  // A language missing from the inventory must not turn every reference into an error.
  globalThis.self.onmessage({ data: { id: 13, version: 1, filePath: 'localisation/french/test_l_french.yml',
    text: 'l_french:\n EYE_test:0 "$EYE_absent$"' } });
  assert.ok(!messages.find((message) => message.id === 13).diagnostics
    .some((issue) => issue.code === 'unresolved-local-reference'));

  indexPayload = { ...indexPayload, complete: false, scripted: { complete: false, definitions: [] } };
  globalThis.self.onmessage({ data: { type: 'init-key-index', token: 'local-token' } });
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.self.onmessage({ data: { id: 10, version: 2, filePath: 'localisation/russian/test_l_russian.yml', text } });
  assert.deepEqual(messages.find((message) => message.id === 10).diagnostics, []);

  diskPayload = { diagnostics: [{ code: 'disk-missing-utf8-bom', message: 'disk', severity: 'error',
    lineNumber: 1, startColumn: 1, endColumn: 2 }] };
  const filePath = 'localisation/russian/other_l_russian.yml';
  globalThis.self.onmessage({ data: { id: 11, version: 1, filePath, text: 'l_russian:\n EYE_test:0 "OK"' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(messages.some((message) => message.type === 'disk-diagnostics-ready'));
  globalThis.self.onmessage({ data: { id: 12, version: 2, filePath, text: 'l_russian:\n EYE_test:0 "Edited"' } });
  assert.equal(messages.find((message) => message.id === 12).diagnostics[0].code, 'disk-missing-utf8-bom');
  assert.equal(requests.filter((item) => item.url === `/api/localisation-file-diagnostics?${new URLSearchParams({ path: filePath })}`).length, 1,
    'typing repeatedly must not reread the working file on every keystroke');
});
