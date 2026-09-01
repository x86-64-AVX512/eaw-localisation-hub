import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  instanceRegistryPath,
  registerAgentInstance,
  unregisterAgentInstance,
} from '../apps/agent/src/instance-registry.mjs';

test('Agent instance registry is discoverable and removed only by its owner', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-agent-instance-'));
  const options = {
    state: temporary,
    pipe: 'eaw-test-pipe',
    server: 'wss://hub.example.test:10443',
    repo: 'C:\\repo',
  };
  try {
    const registration = await registerAgentInstance(options, { version: '0.8.5F1' });
    const target = instanceRegistryPath(temporary);
    const record = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.pipe, options.pipe);
    assert.equal(record.server, options.server);
    assert.equal(record.repository, options.repo);
    assert.equal(record.version, '0.8.5F1');
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));

    await unregisterAgentInstance({
      target,
      record: { ...registration.record, startedAt: 'someone-else' },
    });
    assert.equal((await fs.stat(target)).isFile(), true);

    await unregisterAgentInstance(registration);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
