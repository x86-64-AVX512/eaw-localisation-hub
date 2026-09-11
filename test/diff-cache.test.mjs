import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiffCache } from '../apps/agent/src/diff-cache.mjs';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';

test('local diff cache persists payloads, prunes old entries, and clears on request', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-diff-cache-'));
  try {
    const first = new DiffCache(directory, {
      maximumBytes: 1024 * 1024,
      maximumEntries: 2,
      maximumEntryBytes: 64 * 1024,
    });
    await first.set('history', 'one', { textBase64: 'b25l' });
    await first.set('git', 'two', { base: 'a', head: 'b' });
    assert.deepEqual(await first.get('history', 'one'), { textBase64: 'b25l' });

    const restarted = new DiffCache(directory, {
      maximumBytes: 1024 * 1024,
      maximumEntries: 2,
      maximumEntryBytes: 64 * 1024,
    });
    assert.deepEqual(await restarted.get('git', 'two'), { base: 'a', head: 'b' });
    await restarted.set('audit', 'three', { rows: [1, 2, 3] });
    assert.equal((await restarted.stats()).entries, 2);

    const before = await restarted.clear();
    assert.equal(before.entries, 2);
    assert.equal(before.bytes > 0, true);
    assert.deepEqual(await restarted.stats(), {
      entries: 0, bytes: 0, maximumBytes: 1024 * 1024, maximumEntries: 2,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('local diff cache ignores oversized and corrupt entries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-diff-cache-invalid-'));
  try {
    const cache = new DiffCache(directory, { maximumEntryBytes: 64 });
    assert.equal(await cache.set('history', 'large', { text: 'x'.repeat(100) }), false);
    assert.equal(await cache.get('history', 'large'), undefined);
    await cache.initialise();
    const target = cache.target('history', 'broken');
    await fs.writeFile(target, 'not gzip');
    assert.equal(await cache.get('history', 'broken'), undefined);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    const stableCache = new DiffCache(directory, { maximumEntryBytes: 1024 });
    await stableCache.set('history', 'stable', { text: 'first' });
    assert.equal(await stableCache.set('history', 'stable', { text: 'second' }), true);
    assert.deepEqual(await stableCache.get('history', 'stable'), { text: 'first' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Agent serves immutable history versions from the local cache before contacting the server', async () => {
  const sent = [];
  const serverRequests = [];
  const binding = {
    documentId: 'general-dev:localisation/russian/test.yml',
    socket: { send: (message) => serverRequests.push(JSON.parse(message)) },
  };
  const absolutePath = 'C:\\repo\\localisation\\russian\\test.yml';
  const client = {
    documents: new Map([[absolutePath, { binding }]]),
    send: (message) => sent.push(message),
  };
  const context = {
    options: { server: 'wss://hub.invalid' },
    diffCache: {
      async get(_namespace, key) {
        return key.includes('cached') ? { id: 'cached', textBase64: 'Y2FjaGVk' } : undefined;
      },
    },
    historyCacheKey: AgentHub.prototype.historyCacheKey,
  };

  await AgentHub.prototype.requestHistoryVersion.call(
    context, client, absolutePath, binding, 'cached',
  );
  assert.deepEqual(sent, [{
    type: 'historyVersion', path: absolutePath, id: 'cached', textBase64: 'Y2FjaGVk',
  }]);
  assert.deepEqual(serverRequests, []);

  await AgentHub.prototype.requestHistoryVersion.call(
    context, client, absolutePath, binding, 'missing',
  );
  assert.deepEqual(serverRequests, [{ type: 'history-get', id: 'missing' }]);
});
