import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Ticket test server did not start');
}

test('ticket HTTP metadata gates its isolated WebSocket document namespace', { timeout: 15000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-server-'));
  const port = await freePort();
  const child = spawn(process.execPath, [
    'apps/server/src/main.mjs', '--host', '127.0.0.1', '--port', String(port),
    '--data', temporary, '--auth', 'disabled',
  ], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore', windowsHide: true });
  const file = 'localisation/russian/ticket_l_russian.yml';
  try {
    await waitForHealth(port);
    const created = await fetch(`http://127.0.0.1:${port}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Server ticket', baseBranch: 'general-dev', baseCommit: 'd'.repeat(40), files: [file],
      }),
    });
    assert.equal(created.status, 201);
    const { ticket } = await created.json();
    const listed = await (await fetch(`http://127.0.0.1:${port}/api/tickets`)).json();
    assert.equal(listed.tickets[0].id, ticket.id);

    const accepted = new WebSocket(`ws://127.0.0.1:${port}/?document=${encodeURIComponent(`ticket-${ticket.id}:${file}`)}`);
    const messages = [];
    accepted.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString('utf8'))); });
    await once(accepted, 'open');
    for (let attempt = 0; attempt < 100 && !messages.some(({ type }) => type === 'synced'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(messages.some(({ type }) => type === 'synced'), true);
    accepted.close();

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/?document=${encodeURIComponent(`ticket-${crypto.randomUUID()}:${file}`)}`);
    await once(rejected, 'open');
    const [code] = await once(rejected, 'close');
    assert.equal(code, 1008);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
