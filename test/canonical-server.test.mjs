import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
async function waitForOutput(process, marker) {
  let output = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (output.includes(marker)) return;
    if (process.exitCode != null) throw new Error(`Server exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for server: ${output}`);
}
async function waitForRecordedMessage(messages, predicate, label, timeoutMilliseconds = 45_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(messages, null, 2)}`);
}
async function connect(port, head, blob) {
  const document = encodeURIComponent('general-dev:localisation/replace/russian/test.yml');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?document=${document}&head=${head}&blob=${blob}`);
  const ydoc = new Y.Doc();
  const messages = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) Y.applyUpdate(ydoc, new Uint8Array(data));
    else messages.push(JSON.parse(data.toString('utf8')));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const synced = await waitForRecordedMessage(messages, ({ type }) => type === 'synced', 'initial sync');
  return { socket, ydoc, messages, synced };
}

test('server seeds rooms from Git and blocks only an outdated file blob', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-canonical-server-'));
  let server;
  try {
    const source = path.join(root, 'source');
    const origin = path.join(root, 'origin.git');
    const file = path.join(source, 'localisation', 'replace', 'russian', 'test.yml');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'l_russian:\n canonical:0 "Git"\n');
    git(source, 'init', '-b', 'general-dev');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'canonical');
    const commit = git(source, 'rev-parse', 'HEAD');
    const blob = git(source, 'rev-parse', 'HEAD:localisation/replace/russian/test.yml');
    git(root, 'clone', '--bare', source, origin);
    const port = await freePort();
    server = spawn(process.execPath, [
      'apps/server/src/main.mjs', '--host', '127.0.0.1', '--port', String(port),
      '--data', path.join(root, 'data'), '--auth', 'disabled',
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        EAW_HUB_GITHUB_REPOSITORY: '',
        EAW_HUB_CANONICAL_REPOSITORY: pathToFileURL(origin).href,
        EAW_HUB_GIT_REFRESH_MILLISECONDS: '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    await waitForOutput(server, 'listening on');
    const stale = await connect(port, '0'.repeat(40), '1'.repeat(40));
    assert.equal(stale.synced.git.status, 'file-outdated');
    assert.equal(stale.ydoc.getText('content').toString().replaceAll('\r\n', '\n'), 'l_russian:\n canonical:0 "Git"\n');
    const update = new Y.Doc();
    update.getText('content').insert(0, 'stale overwrite');
    stale.socket.send(Y.encodeStateAsUpdate(update));
    const staleError = await waitForRecordedMessage(stale.messages, ({ type }) => type === 'error', 'stale update rejection');
    assert.match(staleError.message, /Git version of this file/u);
    stale.socket.close();
    const branchOnly = await connect(port, '0'.repeat(40), blob);
    assert.equal(branchOnly.synced.git.status, 'branch-outdated');
    branchOnly.socket.close();
    const current = await connect(port, commit, blob);
    assert.equal(current.synced.git.status, 'current');
    const beforeEdit = Y.encodeStateVector(current.ydoc);
    const liveText = current.ydoc.getText('content');
    liveText.delete(0, liveText.length);
    liveText.insert(0, 'l_russian:\n canonical:0 "Live"\n');
    current.socket.send(Y.encodeStateAsUpdate(current.ydoc, beforeEdit));
    await fs.writeFile(file, 'l_russian:\n canonical:0 "Remote"\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'remote conflict');
    git(source, 'push', origin, 'general-dev');
    const conflict = await waitForRecordedMessage(
      current.messages,
      ({ type, status }) => type === 'git-status' && status === 'conflict',
      'canonical Git conflict',
    );
    assert.deepEqual(conflict.conflicts.map(({ key }) => key), ['canonical']);
    current.socket.send(JSON.stringify({
      type: 'git-conflict-resolve', key: 'canonical', choice: 'external',
    }));
    await waitForRecordedMessage(
      current.messages,
      ({ type, status }) => type === 'git-status' && status === 'file-outdated',
      'resolved file-outdated status',
    );
    for (let attempt = 0; attempt < 500
      && !current.ydoc.getText('content').toString().includes('"Remote"'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(current.ydoc.getText('content').toString(), /"Remote"/u);
    current.socket.close();
  } finally {
    if (server && server.exitCode == null) server.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
});
