import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  instanceRegistryPath,
  registerAgentInstance,
  unregisterAgentInstance,
} from '../apps/agent/src/instance-registry.mts';

test('Agent instance registry is discoverable and removed only by its owner', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-agent-instance-'));
  const options = {
    state: temporary,
    server: 'wss://hub.example.test:10443',
    repo: 'C:\\repo',
  };
  try {
    const registration = await registerAgentInstance(options, { version: '0.8.5F1' });
    const target = instanceRegistryPath(temporary);
    const record = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.pipe, undefined);
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

function launchAgent(state, repo, preload) {
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ['--import', pathToFileURL(preload).href] : []),
      'apps/agent/src/main.mjs',
      '--state',
      state,
      '--repo',
      repo,
      '--workspace',
      'test',
      '--server',
      'ws://127.0.0.1:1',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, EAW_HUB_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      child.output += chunk;
    });
  }
  return child;
}

async function waitForAgent(child) {
  const deadline = Date.now() + 10_000;
  while (!child.output.includes('review application: ready')) {
    assert.equal(child.exitCode, null, child.output);
    assert.equal(child.signalCode, null, child.output);
    assert.ok(Date.now() < deadline, child.output || 'Agent did not become ready');
    await delay(20);
  }
}

async function killAgent(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('a blocked Agent keeps its state lock and a forced exit releases it', { timeout: 30_000 }, async (t) => {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'eaw-agent-lock-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = path.join(root, 'state');
  const alias = path.join(root, 'state-alias');
  const repo = path.join(root, 'repo');
  const preload = path.join(root, 'block-agent.mjs');
  await fs.mkdir(state);
  await fs.mkdir(repo);
  await fs.symlink(state, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(
    preload,
    `
    process.on('message', () => {
      process.send('blocking');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
    });
  `,
  );

  const files = ['agent-instance.json', 'review-endpoint.json', 'review-session.json'];
  const readState = () => Promise.all(files.map((name) => fs.readFile(path.join(state, name), 'utf8')));
  const owner = launchAgent(state, repo, preload);
  try {
    await waitForAgent(owner);
    const original = await readState();
    const discovery = JSON.parse(original[2]);
    const blocking = once(owner, 'message', { signal: AbortSignal.timeout(5000) });
    owner.send('block');
    const [notice] = await blocking;
    assert.equal(notice, 'blocking');
    await assert.rejects(fetch(discovery.origin, { signal: AbortSignal.timeout(200) }), { name: 'TimeoutError' });

    const duplicate = launchAgent(alias, repo);
    try {
      const [exitCode] = await once(duplicate, 'close', { signal: AbortSignal.timeout(5000) });
      assert.equal(exitCode, 1, duplicate.output);
      assert.match(duplicate.output, /already running for this state directory/u);
      assert.deepEqual(await readState(), original);
    } finally {
      await killAgent(duplicate);
    }
  } finally {
    await killAgent(owner);
  }

  const restarted = launchAgent(state, repo);
  try {
    await waitForAgent(restarted);
    const [registry] = await readState();
    assert.equal(JSON.parse(registry).pid, restarted.pid);
  } finally {
    await killAgent(restarted);
  }
});
