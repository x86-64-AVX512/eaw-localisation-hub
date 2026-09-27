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
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createReviewDocument } from '../apps/review/src/review-document.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

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


async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    timer.unref?.();
  })]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function connectReview(stateDirectory, filePath, initialText, retained = null) {
  const discovery = JSON.parse(await fs.readFile(path.join(stateDirectory, 'review-session.json'), 'utf8'));
  const socket = new WebSocket(`${discovery.origin.replace('http:', 'ws:')}/review-socket?token=${discovery.token}`, {
    origin: discovery.origin,
  });
  const client = retained ?? { held: [], holding: false, messages: [] };
  client.socket = socket;
  client.ready = false;
  client.document ??= createReviewDocument({
    send(message) {
      if (client.holding) client.held.push(message);
      else client.socket.send(JSON.stringify(message));
    },
    onText() {},
  });
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8'));
    client.messages.push(message);
    if (message.type === 'documentSync') client.document.receive(message);
    if (message.type === 'documentReady') {
      client.ready = true; client.document.replay();
      socket.send(JSON.stringify(client.document.anchor({ type: 'cursor', path: filePath, positionByte: 0, anchorByte: 0 })));
    }
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'open', path: filePath, crdt: 'yjs-v1',
    textBase64: Buffer.from(initialText).toString('base64') }));
  socket.send(JSON.stringify(client.document.anchor({ type: 'activate', path: filePath, positionByte: 0, anchorByte: 0 })));
  await waitUntil(() => client.ready, 'Review ready');
  client.close = () => { socket.terminate(); client.document.dispose(); };
  return client;
}

test('real Review–Agent–server transport preserves in-flight typing and writes only personal variants',
  { timeout: 40000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-review-crdt-integration-'));
    const relative = path.join('localisation', 'russian', 'review.yml');
    const original = 'l_russian:\n first:0 "One"\n second:0 "Two"\n';
    const repoAlice = path.join(temporary, 'alice'); const repoBob = path.join(temporary, 'bob');
    const fileAlice = path.join(repoAlice, relative); const fileBob = path.join(repoBob, relative);
    const stateAlice = path.join(temporary, 'state-alice'); const stateBob = path.join(temporary, 'state-bob');
    const port = await freePort();
    let server; let aliceAgent; let bobAgent; let alice; let bob;
    try {
      for (const file of [fileAlice, fileBob]) {
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, original);
      }
      server = spawnNode(['apps/server/src/main.mjs', '--port', String(port),
        '--data', path.join(temporary, 'data'), '--auth', 'disabled']);
      await waitForHealth(port);
      const startAgent = (repo, state, user) => spawnNode(['apps/agent/src/main.mjs',
        '--repo', repo, '--workspace', 'general-dev',
        '--user', user, '--state', state, '--server', `ws://127.0.0.1:${port}`]);
      aliceAgent = startAgent(repoAlice, stateAlice, 'Alice');
      bobAgent = startAgent(repoBob, stateBob, 'Bob');
      await Promise.all([
        waitUntil(async () => { try { await fs.access(path.join(stateAlice, 'review-session.json')); return true; } catch { return false; } }, 'Alice Review endpoint'),
        waitUntil(async () => { try { await fs.access(path.join(stateBob, 'review-session.json')); return true; } catch { return false; } }, 'Bob Review endpoint'),
      ]);
      alice = await connectReview(stateAlice, fileAlice, original);
      bob = await connectReview(stateBob, fileBob, original);
      alice.holding = true;
      alice.document.commit(original.replace('"One"', '"Alice One"'));
      bob.document.commit(original.replace('"Two"', '"Bob Two"'));
      await waitUntil(() => alice.document.text().includes('"Bob Two"'), 'remote update while Alice typing is in flight');
      assert.match(alice.document.text(), /"Alice One"/u);
      alice.holding = false;
      for (const message of alice.held.splice(0)) alice.socket.send(JSON.stringify(message));
      await waitUntil(() => bob.document.text().includes('"Alice One"'), 'Alice CRDT update at Bob');
      assert.equal(alice.document.text(), bob.document.text());
      try {
        await waitUntil(async () => (await fs.readFile(fileAlice, 'utf8')).includes('"Alice One"'), 'Alice personal materialisation');
      } catch (error) {
        const messages = alice.messages.slice(-20).map(({ type, message }) => ({ type, message }));
        error.message += `; Review messages: ${JSON.stringify(messages)}; Agent output: ${aliceAgent.output.slice(-2000)}`;
        throw error;
      }
      await waitUntil(async () => (await fs.readFile(fileBob, 'utf8')).includes('"Bob Two"'), 'Bob personal materialisation');
      assert.equal(await fs.readFile(fileAlice, 'utf8'), `\uFEFF${original.replace('"One"', '"Alice One"')}`);
      assert.equal(await fs.readFile(fileBob, 'utf8'), `\uFEFF${original.replace('"Two"', '"Bob Two"')}`);
      assert.equal(alice.messages.some(({ type }) => type === 'error'), false);
      assert.equal(bob.messages.some(({ type }) => type === 'error'), false);

      // Keep the Review CRDT peer alive while its Agent disappears. Old relative
      // activation positions must not leave the new connection without an active file.
      const beforeRestart = alice.document.text();
      await stopProcess(aliceAgent);
      aliceAgent = startAgent(repoAlice, stateAlice, 'Alice');
      await waitUntil(() => /review application: ready/u.test(aliceAgent.output), 'restarted Alice Review endpoint');
      alice = await connectReview(stateAlice, fileAlice, beforeRestart, alice);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(alice.socket.readyState, WebSocket.OPEN, 'restarted Review must stay connected after its cursor heartbeat');
      assert.equal(alice.messages.some(({ type }) => type === 'error'), false);
      alice.document.commit(beforeRestart.replace('Alice One', 'Alice restarted'));
      await waitUntil(() => bob.document.text().includes('Alice restarted'), 'editing after Agent restart');
    } finally {
      alice?.close(); bob?.close();
      await stopProcess(aliceAgent); await stopProcess(bobAgent); await stopProcess(server);
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
