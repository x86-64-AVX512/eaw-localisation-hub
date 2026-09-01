import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DISPLAY_VERSION, PROTOCOL_VERSION } from '../packages/shared/src/constants.mjs';
import { applyUtf8ByteEdit } from '../packages/shared/src/text.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const pipePath = (name) => process.platform === 'win32'
  ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnNode(argumentsList, environment = {}) {
  const child = spawn(process.execPath, argumentsList, {
    cwd: projectRoot, env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function waitUntil(predicate, description, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForHealth(port) {
  await waitUntil(async () => {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve(data));
        });
        request.on('error', reject);
      });
      return JSON.parse(body).ok;
    } catch { return false; }
  }, 'server health');
}

class FakePlugin {
  constructor(socket, filePath, initialText, clientId, ipcSecret) {
    Object.assign(this, { socket, filePath, text: initialText, clientId, ipcSecret });
    this.messages = [];
    this.waiters = [];
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.receive(chunk));
  }

  static async connect(pipe, filePath, initialText, clientId, ipcSecret) {
    const socket = net.createConnection(pipe);
    await once(socket, 'connect');
    const plugin = new FakePlugin(socket, filePath, initialText, clientId, ipcSecret);
    const challenge = await plugin.waitFor((message) => message.type === 'ipcChallenge');
    const proof = crypto.createHmac('sha256', ipcSecret)
      .update(`plugin:${challenge.nonce}`, 'utf8').digest('hex');
    plugin.send({ type: 'hello', clientId, version: DISPLAY_VERSION, protocol: PROTOCOL_VERSION, proof });
    plugin.send({ type: 'open', path: filePath,
      textBase64: Buffer.from(initialText, 'utf8').toString('base64') });
    await plugin.waitFor((message) => message.type === 'documentReady');
    plugin.send({ type: 'activate', path: filePath, positionByte: 0, anchorByte: 0 });
    return plugin;
  }

  receive(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const newline = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === 'replace' && path.resolve(message.path) === path.resolve(this.filePath)) {
        this.text = applyUtf8ByteEdit(this.text, message.positionByte, message.deleteBytes,
          Buffer.from(message.insertBase64, 'base64').toString('utf8'));
      }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) waiter();
    }
  }

  send(message) { this.socket.write(`${JSON.stringify(message)}\n`); }
  snapshot(nextText) {
    this.text = nextText;
    this.send({ type: 'snapshot', path: this.filePath,
      textBase64: Buffer.from(nextText, 'utf8').toString('base64') });
  }
  async waitFor(predicate, timeout = 10000) {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const check = () => {
        const message = this.messages.find(predicate);
        if (!message) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((item) => item !== check);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== check);
        reject(new Error(`Timed out waiting for plugin message. Text:\n${this.text}`));
      }, timeout);
      this.waiters.push(check);
    });
  }
  close() { this.socket.destroy(); }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('two agents keep personal worktrees isolated while sharing metadata and server text',
  { timeout: 40000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-test-'));
    const relative = path.join('localisation', 'russian', 'prototype_l_russian.yml');
    const original = 'l_russian:\r\n key_one:0 "Первый"\r\n key_two:0 "Второй"\r\n key_three:0 "Третий"\r\n';
    const repoAlice = path.join(temporary, 'alice');
    const repoBob = path.join(temporary, 'bob');
    const fileAlice = path.join(repoAlice, relative);
    const fileBob = path.join(repoBob, relative);
    await fs.mkdir(path.dirname(fileAlice), { recursive: true });
    await fs.mkdir(path.dirname(fileBob), { recursive: true });
    await fs.writeFile(fileAlice, original);
    await fs.writeFile(fileBob, original);
    const port = await freePort();
    const suffix = `${process.pid}-${Date.now()}`;
    const alicePipe = `eaw-hub-alice-${suffix}`;
    const bobPipe = `eaw-hub-bob-${suffix}`;
    const ipcSecret = `integration-${crypto.randomBytes(16).toString('hex')}`;
    let server; let aliceAgent; let bobAgent; let alice; let bob;
    try {
      server = spawnNode(['apps/server/src/main.mjs', '--port', String(port),
        '--data', path.join(temporary, 'server-data'), '--auth', 'disabled']);
      await waitForHealth(port);
      aliceAgent = spawnNode(['apps/agent/src/main.mjs', '--repo', repoAlice,
        '--workspace', 'general-dev', '--pipe', alicePipe, '--user', 'Alice',
        '--state', path.join(temporary, 'state-alice'), '--server', `ws://127.0.0.1:${port}`],
      { EAW_HUB_IPC_SECRET: ipcSecret });
      bobAgent = spawnNode(['apps/agent/src/main.mjs', '--repo', repoBob,
        '--workspace', 'general-dev', '--pipe', bobPipe, '--user', 'Bob',
        '--state', path.join(temporary, 'state-bob'), '--server', `ws://127.0.0.1:${port}`],
      { EAW_HUB_IPC_SECRET: ipcSecret });
      await Promise.all([
        waitUntil(() => /pipe:/u.test(aliceAgent.output), 'Alice pipe'),
        waitUntil(() => /pipe:/u.test(bobAgent.output), 'Bob pipe'),
      ]);
      [alice, bob] = await Promise.all([
        FakePlugin.connect(pipePath(alicePipe), fileAlice, original, 'alice-plugin', ipcSecret),
        FakePlugin.connect(pipePath(bobPipe), fileBob, original, 'bob-plugin', ipcSecret),
      ]);
      await bob.waitFor((message) => message.type === 'presence' && message.user === 'Alice');

      const aliceOnly = original.replace('"Первый"', '"Версия Alice"');
      alice.snapshot(aliceOnly);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(alice.text, aliceOnly);
      assert.equal(bob.text, original, 'Alice text must not be materialised into Bob worktree');

      const bobOnly = original.replace('"Второй"', '"Версия Bob"');
      bob.snapshot(bobOnly);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(bob.text, bobOnly);
      assert.equal(alice.text, aliceOnly, 'Bob text must not be materialised into Alice worktree');

      const aliceSameKey = aliceOnly.replace('"Третий"', '"Третий Alice"');
      alice.snapshot(aliceSameKey);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const bobSameKey = bobOnly.replace('"Третий"', '"Третий Bob"');
      bob.snapshot(bobSameKey);
      const conflict = await bob.waitFor((message) => message.type === 'externalConflict'
        && message.key === 'key_three');
      assert.match(conflict.detail, /один и тот же ключ|одновременно|изменён/iu);
      bob.send({ type: 'externalConflictResolve', path: fileBob,
        key: 'key_three', choice: 'external' });
      await waitUntil(() => bob.text.includes('"Третий Bob"'), 'Bob conflict choice');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.match(alice.text, /"Третий Alice"/u,
        'same-key choices must remain separate in Alice personal projection');
      assert.doesNotMatch(alice.text, /"Третий Bob"/u);
    } finally {
      alice?.close(); bob?.close();
      await stopProcess(aliceAgent); await stopProcess(bobAgent); await stopProcess(server);
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
