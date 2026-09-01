import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startReviewServer } from '../apps/agent/src/review-server.mjs';
import { persistentReviewEndpoint } from '../apps/agent/src/review-endpoint.mjs';

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
    socket.once('error', reject);
  });
}

test('review endpoint keeps its loopback port and capability across Agent restarts', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-review-endpoint-'));
  try {
    const first = await persistentReviewEndpoint({ state });
    const second = await persistentReviewEndpoint({ state });
    assert.equal(second.port, first.port);
    assert.equal(second.token, first.token);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.parse(await fs.readFile(first.endpointPath, 'utf8')).port, first.port);
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('review server is loopback-bound, bearer-protected, origin-checked, and path-contained', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-review-'));
  const repository = path.join(temporary, 'repository');
  const state = path.join(temporary, 'state');
  const tracked = path.join(repository, 'localisation', 'russian', 'review_l_russian.yml');
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  await fs.writeFile(tracked, 'l_russian:\n REVIEW_KEY:0 "Review"\n', 'utf8');
  const received = [];
  let canonicalText = 'l_russian:\n REVIEW_KEY:0 "Review"\n';
  const hub = {
    options: { repo: repository },
    workspaceBlocked: false,
    attachAuthenticatedClient(client) {
      this.client = client;
      client.send({ type: 'agentHello', user: 'Reviewer', workspace: 'test', color: '#abcdef' });
      return true;
    },
    receivePluginMessage(client, message) {
      received.push(message);
      if (message.type === 'open') {
        client.documents.set(path.resolve(message.path), {
          initialised: true,
          pendingExternal: null,
          binding: { text: { toString: () => canonicalText } },
        });
      } else if (message.type === 'snapshot') {
        canonicalText = Buffer.from(message.textBase64, 'base64').toString('utf8');
      }
    },
    detachClient() {},
    currentGitCommit() { return 'a'.repeat(40); },
    async ticketRequest(route, options = {}) {
      received.push({ type: 'ticketRequest', route, options });
      if (options.method === 'POST') return { ticket: { id: 'ticket-created' } };
      return { tickets: [] };
    },
  };
  const review = await startReviewServer(hub, {
    repo: repository, state, workspace: 'test', user: 'Reviewer', color: '#abcdef',
  });
  try {
    const discovery = JSON.parse(await fs.readFile(review.discoveryPath, 'utf8'));
    assert.match(discovery.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(discovery.token.length >= 40, true);

    const index = await fetch(`${discovery.origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
    assert.match(await index.text(), /E[aA]W Localisation Hub/u);

    const unauthorized = await fetch(`${discovery.origin}/api/bootstrap?path=${encodeURIComponent(tracked)}`);
    assert.equal(unauthorized.status, 401);
    const bootstrap = await fetch(`${discovery.origin}/api/bootstrap?path=${encodeURIComponent(tracked)}`, {
      headers: { Authorization: `Bearer ${discovery.token}` },
    });
    assert.equal(bootstrap.status, 200);
    const payload = await bootstrap.json();
    assert.equal(payload.path, tracked);
    assert.equal(Buffer.from(payload.textBase64, 'base64').toString('utf8').includes('REVIEW_KEY'), true);

    const tickets = await fetch(`${discovery.origin}/api/tickets`, {
      headers: { Authorization: `Bearer ${discovery.token}` },
    });
    assert.equal(tickets.status, 200);
    assert.deepEqual((await tickets.json()).tickets, []);
    const createdTicket = await fetch(`${discovery.origin}/api/tickets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Review ticket', files: ['localisation/russian/review_l_russian.yml'] }),
    });
    assert.equal(createdTicket.status, 200);
    assert.equal((await createdTicket.json()).ticket.id, 'ticket-created');
    const forwarded = received.find(({ type, options: requestOptions }) => (
      type === 'ticketRequest' && requestOptions?.method === 'POST'
    ));
    const forwardedBody = JSON.parse(forwarded.options.body);
    assert.equal(forwardedBody.baseBranch, 'test');
    assert.equal(forwardedBody.baseCommit, 'a'.repeat(40));

    const escaped = await fetch(`${discovery.origin}/api/bootstrap?path=${encodeURIComponent(path.join(temporary, 'outside.yml'))}`, {
      headers: { Authorization: `Bearer ${discovery.token}` },
    });
    assert.equal(escaped.status, 400);

    const socketUrl = discovery.origin.replace('http:', 'ws:')
      + `/review-socket?token=${encodeURIComponent(discovery.token)}`;
    const rejected = new WebSocket(socketUrl, { origin: 'https://attacker.invalid' });
    await assert.rejects(waitForOpen(rejected));

    const socket = new WebSocket(socketUrl, { origin: discovery.origin });
    const helloPromise = waitForMessage(socket);
    await waitForOpen(socket);
    assert.equal((await helloPromise).type, 'agentHello');
    socket.send(JSON.stringify({
      type: 'open', path: tracked,
      textBase64: Buffer.from('l_russian:\n REVIEW_KEY:0 "Review"\n', 'utf8').toString('base64'),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.at(-1)?.type, 'open');
    const changed = 'l_russian:\n REVIEW_KEY:0 "Из Review"\n';
    socket.send(JSON.stringify({
      type: 'snapshot', path: tracked,
      textBase64: Buffer.from(changed, 'utf8').toString('base64'),
    }));
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(await fs.readFile(tracked, 'utf8'), `\uFEFF${changed}`);
    socket.close();
  } finally {
    await review.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
