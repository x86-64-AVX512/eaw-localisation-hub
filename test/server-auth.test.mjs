import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AuthStore } from '../apps/server/src/auth.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

function testAvatarBase64() {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(95, 24, 3);
  bytes.writeUIntLE(95, 27, 3);
  return bytes.toString('base64');
}

test('login limiter isolates account and transient source buckets before password work', async () => {
  let now = 1000;
  let passwordChecks = 0;
  const store = new AuthStore('.', async () => {}, 'required', {
    accountCapacity: 10,
    accountRefillPerSecond: 1,
    sourceCapacity: 2,
    sourceRefillPerSecond: 1,
    now: () => now,
  });
  store.verifyPassword = async () => {
    passwordChecks += 1;
    return false;
  };
  await assert.rejects(store.login('First unknown', 'anything', 'source-a'), { code: 'invalid_credentials' });
  await assert.rejects(store.login('Second unknown', 'anything', 'source-a'), { code: 'invalid_credentials' });
  await assert.rejects(store.login('Third unknown', 'anything', 'source-a'), {
    code: 'login_rate_limited',
    status: 429,
  });
  assert.equal(passwordChecks, 2);
  await assert.rejects(store.login('Third unknown', 'anything', 'source-b'), { code: 'invalid_credentials' });
  assert.equal(passwordChecks, 3);
  now += 1000;
  await assert.rejects(store.login('Fourth unknown', 'anything', 'source-a'), { code: 'invalid_credentials' });
  assert.equal(passwordChecks, 4);
});

test('registration rechecks invitations revoked during password hashing', async () => {
  const store = new AuthStore('.', async () => {}, 'required');
  const actor = { id: 'admin', roles: ['admin'] };
  const { code, invite } = await store.createInvite(actor, { roles: ['translator'] });
  store.recoveryCodes.key = Buffer.alloc(32);
  store.hashPassword = async () => {
    await store.revokeInvite(actor, invite.id);
    return {};
  };
  await assert.rejects(store.redeem(code, 'Translator', 'test-password'), { code: 'registration_race' });
  assert.equal(store.state.invites[0].uses, 0);
  assert.deepEqual(store.state.users, []);
  assert.deepEqual(store.state.sessions, []);
});

test('sessions have role-sensitive expiry and a per-user cap', async () => {
  let now = Date.now();
  const store = new AuthStore('.', async () => {}, 'required', { now: () => now });
  const translator = {
    id: 'translator-user',
    displayName: 'Translator',
    roles: ['translator'],
    passwordVerifier: {},
  };
  const admin = {
    id: 'admin-user',
    displayName: 'Admin',
    roles: ['admin'],
    passwordVerifier: {},
  };
  store.state.users.push(translator, admin);
  const translatorTokens = [];
  for (let index = 0; index < 9; index += 1) {
    translatorTokens.push(store.issueSession(translator).token);
    now += 1;
  }
  assert.equal(store.state.sessions.filter(({ userId }) => userId === translator.id).length, 8);
  await assert.rejects(store.authenticate(translatorTokens[0]), { code: 'invalid_session' });
  assert.equal((await store.authenticate(translatorTokens.at(-1))).id, translator.id);

  const adminSession = store.issueSession(admin);
  const adminExpiry = Date.parse(adminSession.session.expiresAt);
  const translatorExpiry = Date.parse(store.state.sessions.find(({ userId }) => userId === translator.id).expiresAt);
  assert.ok(translatorExpiry - now > adminExpiry - now);
  now = adminExpiry + 1;
  await assert.rejects(store.authenticate(adminSession.token), { code: 'expired_session' });
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => resolve(data));
        });
        request.on('error', reject);
      });
      if (JSON.parse(body).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Authenticated server did not become ready');
}

async function api(port, method, route, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const value = contentType.includes('application/json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, value };
}

async function connectSocket(port, documentId, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?document=${encodeURIComponent(documentId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  socket.jsonMessages = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) socket.jsonMessages.push(JSON.parse(data.toString('utf8')));
  });
  await once(socket, 'open');
  return socket;
}

function waitJson(socket, predicate, timeout = 10000) {
  const existing = socket.jsonMessages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket JSON'));
    }, timeout);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString('utf8'));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForOutput(child, pattern, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(child.output)) return;
    if (child.exitCode !== null) throw new Error(`Process exited early (${child.exitCode}):\n${child.output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}:\n${child.output}`);
}

async function startAuthenticatedServer(dataDirectory) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const server = spawn(
      process.execPath,
      ['apps/server/src/main.mjs', '--port', String(port), '--data', dataDirectory, '--auth', 'required'],
      {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    server.output = '';
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      server.output += chunk;
    });
    server.stderr.on('data', (chunk) => {
      server.output += chunk;
    });
    try {
      await waitForOutput(server, /\[server\] listening/u, 3000);
      await waitForHealth(port);
      return { server, port };
    } catch (error) {
      lastError = error;
      const retryableBindFailure = /listen (?:EACCES|EADDRINUSE)/u.test(server.output);
      await stop(server);
      if (!retryableBindFailure) throw error;
    }
  }
  throw lastError;
}

async function connectReviewClient(stateDirectory, filePath, initialText) {
  const discovery = JSON.parse(await fs.readFile(path.join(stateDirectory, 'review-session.json'), 'utf8'));
  const socket = new WebSocket(`${discovery.origin.replace('http:', 'ws:')}/review-socket?token=${discovery.token}`, {
    origin: discovery.origin,
  });
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    messages.push(JSON.parse(data.toString('utf8')));
    for (const notify of [...waiters]) notify();
  });
  const waitFor = (predicate, timeout = 10000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for Review message:\n${JSON.stringify(messages, null, 2)}`)),
        timeout,
      );
      const notify = () => {
        const found = messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(notify), 1);
        resolve(found);
      };
      waiters.push(notify);
    });
  };
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'open',
      path: filePath,
      crdt: 'yjs-v1',
      textBase64: Buffer.from(initialText).toString('base64'),
    }),
  );
  return { socket, messages, waitFor, send: (message) => socket.send(JSON.stringify(message)) };
}

test(
  'the CLI shares account permissions and confirms saved proposals without editing the worktree',
  { timeout: 45000 },
  async (t) => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'eaw-cli-'));
    const repo = path.join(root, 'repo');
    const state = path.join(root, 'agent');
    const data = path.join(root, 'server');
    const relative = 'localisation/russian/cli_l_russian.yml';
    const file = path.join(repo, relative);
    const oldRelative = 'localisation/russian/old_l_russian.yml';
    const source = 'l_russian:\n CLI_KEY:0 "Исходный текст"\n';
    let server, agent, review;
    t.after(async () => {
      review?.socket.terminate();
      await stop(agent);
      await stop(server);
      assert.equal(path.dirname(await fs.realpath(root)), temp);
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    await fs.writeFile(path.join(repo, oldRelative), source);
    const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
    git('init', '-b', 'general-dev');
    git('add', '.');
    git('-c', 'user.name=CLI Test', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    const baseCommit = git('rev-parse', 'HEAD').toString().trim();
    git('rm', oldRelative);
    git('-c', 'user.name=CLI Test', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'remove old file');
    let port;
    ({ server, port } = await startAuthenticatedServer(data));
    const inviteCode = (await fs.readFile(path.join(data, 'bootstrap-invite.txt'), 'utf8')).trim();
    const identity = await api(port, 'POST', '/api/auth/redeem', {
      body: { inviteCode, displayName: 'CLI Tester', password: 'CLI-test-password-184!' },
    });
    assert.equal(identity.status, 201);
    agent = spawn(
      process.execPath,
      ['apps/agent/src/main.mjs', '--server', `ws://127.0.0.1:${port}`, '--repo', repo, '--state', state],
      { cwd: projectRoot, env: { ...process.env, EAW_HUB_TOKEN: identity.value.token }, windowsHide: true },
    );
    agent.output = '';
    for (const stream of [agent.stdout, agent.stderr])
      stream.on('data', (chunk) => {
        agent.output += chunk;
      });
    await waitForOutput(agent, /review application: ready/u);
    review = await connectReviewClient(state, file, source);
    await review.waitFor((message) => message.type === 'documentReady');

    const session = JSON.parse(await fs.readFile(path.join(state, 'review-session.json'), 'utf8'));
    const local = (method, route, body, token = session.token) =>
      api(new URL(session.origin).port, method, `/api/cli/v1/${route}`, { token, body });
    const grantRequest = () => local('POST', 'grants', { minutes: 15, label: 'Integration' });
    const grant = async () => {
      const reply = await grantRequest();
      assert.equal(reply.status, 200, JSON.stringify(reply.value));
      return reply.value.data;
    };
    const setMode = async (mode) => {
      const result = await local('PUT', 'settings', { mode });
      assert.equal(result.value.data.mode, mode);
    };
    const run = async (capability, ...args) => {
      const result = await promisify(execFile)(process.execPath, ['apps/agent/src/cli.mjs', ...args, '--json'], {
        cwd: projectRoot,
        env: { ...process.env, EAW_HUB_CLI_TOKEN: capability },
        timeout: 10000,
        windowsHide: true,
      }).catch((error) => {
        if (!error.stdout) throw error;
        return { stdout: error.stdout };
      });
      return JSON.parse(result.stdout);
    };
    assert.equal((await local('GET', 'settings')).value.data.mode, 'off');
    assert.equal((await grantRequest()).value.error.code, 'CLI_DISABLED');
    await setMode('read');
    const reader = await grant();
    await setMode('write');
    const writer = await grant();
    const ticket = await api(port, 'POST', '/api/tickets', {
      token: identity.value.token,
      body: {
        title: 'CLI ticket',
        baseBranch: 'general-dev',
        baseCommit,
        files: [relative, oldRelative],
      },
    });
    assert.equal(ticket.status, 201, JSON.stringify(ticket.value));
    const ticketId = ticket.value.ticket.id;
    assert.equal((await run(reader.token, 'status')).data.user, 'CLI Tester');
    assert.equal(
      (await run(reader.token, 'ticket', 'list')).data.items.some(({ id }) => id === ticketId),
      true,
    );
    assert.equal((await run(reader.token, 'ticket', 'read', '--id', ticketId)).data.ticket.id, ticketId);
    assert.equal((await run(reader.token, 'search', '--lang', 'ru', '--key', 'CLI_KEY')).data.items[0].file, relative);
    const keyArgs = ['--file', relative, '--key', 'CLI_KEY'];
    const original = await run(reader.token, 'read', ...keyArgs);
    assert.equal(original.data.text, 'Исходный текст');
    const ticketBaseline = (await run(reader.token, 'read', ...keyArgs, '--ticket', ticketId)).data;
    assert.equal(ticketBaseline.source, 'ticket-baseline');
    assert.equal(ticketBaseline.text, 'Исходный текст');
    const historical = await run(reader.token, 'read', '--file', oldRelative, '--key', 'CLI_KEY', '--ticket', ticketId);
    assert.equal(historical.data.source, 'ticket-baseline');
    assert.equal(historical.data.text, 'Исходный текст');
    const emptyHistory = (await run(reader.token, 'history', 'list', '--file', relative, '--ticket', ticketId)).data;
    assert.equal(emptyHistory.total, 0);
    assert.equal(emptyHistory.revision, null);
    assert.equal(emptyHistory.source, 'ticket-baseline');
    for (const command of ['discussion', 'reservation']) {
      const empty = (await run(reader.token, command, 'list', ...keyArgs, '--ticket', ticketId)).data;
      assert.deepEqual(empty.items, []);
      assert.equal(empty.revision, null);
    }
    const ticketHash = crypto.createHash('sha256').update(`ticket-${ticketId}:${relative}`).digest('hex');
    await assert.rejects(fs.access(path.join(data, 'documents', `${ticketHash}.json`)), { code: 'ENOENT' });

    const replacement = path.join(root, 'replacement.txt');
    await fs.writeFile(replacement, 'Новый текст');
    const preview = ['suggestion', 'preview', ...keyArgs, '--text-file', replacement];
    const coldReply = await run(
      writer.token,
      'discussion',
      'reply',
      '--file',
      relative,
      '--kind',
      'comment',
      '--id',
      crypto.randomUUID(),
      '--text-file',
      replacement,
      '--ticket',
      ticketId,
    );
    assert.equal(coldReply.error.code, 'DOCUMENT_NOT_INITIALISED');
    const historyAfterReply = (await run(reader.token, 'history', 'list', '--file', relative, '--ticket', ticketId))
      .data;
    assert.equal(historyAfterReply.total, 0);
    await assert.rejects(fs.access(path.join(data, 'documents', `${ticketHash}.json`)), { code: 'ENOENT' });
    assert.equal((await run(writer.token, ...preview, '--ticket', ticketId)).error.code, 'DOCUMENT_NOT_INITIALISED');
    assert.equal((await run(reader.token, ...preview)).error.code, 'READ_ONLY');
    const proposed = await run(writer.token, ...preview);
    assert.deepEqual(proposed.data.diff, { before: 'Исходный текст', after: 'Новый текст' });
    const submit = ['suggestion', 'submit', '--plan', proposed.data.planId];
    const first = await run(writer.token, ...submit);
    assert.equal(first.data.status, 'saved');
    assert.equal((await run(writer.token, ...submit)).data.id, first.data.id);
    const replyId = crypto.randomUUID();
    const reply = [
      'discussion',
      'reply',
      '--file',
      relative,
      '--kind',
      'suggestion',
      '--id',
      first.data.id,
      '--text-file',
      replacement,
      '--request-id',
      replyId,
    ];
    assert.equal((await run(writer.token, ...reply)).data.messageId, replyId);
    assert.equal((await run(writer.token, ...reply)).data.messageId, replyId);
    const items = (await run(reader.token, 'discussion', 'list', ...keyArgs)).data.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].author, 'CLI Tester');
    assert.equal(items[0].messageCount, 1);
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          data,
          'documents',
          `${crypto.createHash('sha256').update(`general-dev:${relative}`).digest('hex')}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(onDisk.suggestions.length, 1);
    assert.match(await fs.readFile(file, 'utf8'), /Исходный текст/u);

    const stale = await run(writer.token, ...preview);
    const nextSource = source.replace('Исходный текст', 'Текст обновлён человеком');
    review.send({ type: 'snapshot', path: file, textBase64: Buffer.from(nextSource).toString('base64') });
    const deadline = Date.now() + 5000;
    let next;
    do {
      next = await run(reader.token, 'read', ...keyArgs);
      if (next.data?.text === 'Текст обновлён человеком') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(next.data?.text, 'Текст обновлён человеком');
    assert.equal(
      (await run(writer.token, 'suggestion', 'submit', '--plan', stale.data.planId)).error.code,
      'STALE_REVISION',
    );
    const comment = await run(
      writer.token,
      'discussion',
      'create',
      ...keyArgs,
      '--revision',
      next.data.revision,
      '--text-file',
      replacement,
    );
    assert.equal(comment.data.status, 'saved');
    const keyComment = crypto.randomUUID();
    const keyOffset = Buffer.byteLength(nextSource.slice(0, nextSource.indexOf('CLI_KEY')));
    review.send({
      type: 'commentCreate',
      path: file,
      id: keyComment,
      requestId: keyComment,
      messageId: keyComment,
      startByte: keyOffset,
      endByte: keyOffset + 'CLI_KEY'.length,
      bodyBase64: Buffer.from('Comment on a key name').toString('base64'),
    });
    const savedKeyComment = await review.waitFor(
      (message) => message.type === 'discussionResult' && message.id === keyComment,
    );
    assert.equal(savedKeyComment.status, 'saved');
    const keyDiscussion = await run(reader.token, 'discussion', 'list', ...keyArgs, '--id', keyComment);
    assert.equal(keyDiscussion.data.items[0].id, keyComment);

    const reservationId = crypto.randomUUID();
    const reserve = [
      'reservation',
      'create',
      ...keyArgs,
      '--revision',
      next.data.revision,
      '--request-id',
      reservationId,
    ];
    assert.equal((await run(reader.token, ...reserve)).error.code, 'READ_ONLY');
    const note = path.join(root, 'note.txt');
    assert.equal((await run(writer.token, ...reserve, '--text-file', note)).error.code, 'INVALID_ARGUMENT');
    await fs.writeFile(note, 'Invalid\t note\n');
    assert.equal((await run(writer.token, ...reserve, '--text-file', note)).error.code, 'INVALID_ARGUMENT');
    await fs.writeFile(note, 'A reservation note\r\n');
    reserve.push('--text-file', note);
    assert.equal((await run(writer.token, ...reserve)).data.id, reservationId);
    assert.equal((await run(writer.token, ...reserve)).data.id, reservationId);
    const reservations = (await run(reader.token, 'reservation', 'list', ...keyArgs)).data.items;
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].assignee, 'CLI Tester');
    assert.equal(reservations[0].comment, 'A reservation note');
    assert.equal(reservations[0].startRelative, undefined);
    const history = (await run(reader.token, 'history', 'list', '--file', relative)).data;
    const version = (await run(reader.token, 'history', 'read', '--file', relative, '--id', history.headId)).data;
    assert.match(version.text, /Текст обновлён человеком/u);
    assert.equal(version.file, relative);
    assert.equal(version.ticket, null);
    const missingVersion = await run(reader.token, 'history', 'read', '--file', relative, '--id', crypto.randomUUID());
    assert.equal(missingVersion.error.code, 'HISTORY_UNAVAILABLE');

    const maximumValue = 'a'.repeat(16 * 1024);
    await fs.writeFile(replacement, maximumValue + '\r\n');
    const largePreview = await run(writer.token, ...preview);
    assert.equal(largePreview.data.diff.after, maximumValue);
    for (let index = 0; index < 126; index++) {
      const pending = await local(
        'POST',
        'command',
        { command: 'preview', file: relative, key: 'CLI_KEY', text: 'Next value' },
        writer.token,
      );
      assert.equal(pending.status, 200);
    }
    assert.equal((await run(writer.token, ...submit)).error.code, 'PLAN_EXPIRED');
    assert.equal((await run(writer.token, ...preview)).error.code, 'BUSY');

    await setMode('read');
    assert.equal((await run(writer.token, ...reserve)).error.code, 'READ_ONLY');
    assert.equal((await run(writer.token, 'status')).data.access, 'read');
    await setMode('write');
    assert.equal((await run(writer.token, ...preview)).error.code, 'READ_ONLY');
    assert.equal((await run(reader.token, 'status')).ok, true);
    await setMode('off');
    assert.equal((await run(reader.token, 'status')).error.code, 'CLI_DISABLED');
    assert.equal(JSON.parse(await fs.readFile(path.join(state, 'cli-access.json'), 'utf8')).mode, 'off');
    await setMode('read');
    assert.equal((await run(reader.token, 'status')).error.code, 'GRANT_REQUIRED');
  },
);

test(
  'an idle authenticated socket closes at session expiry and HTTP access is denied',
  { timeout: 12000 },
  async (t) => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'eaw-expiring-session-'));
    let server;
    let socket;
    t.after(async () => {
      socket?.terminate();
      await stop(server);
      const resolved = await fs.realpath(root);
      assert.equal(resolved, root);
      assert.equal(path.dirname(resolved), temp);
      await fs.rm(resolved, { recursive: true });
    });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = { id: crypto.randomUUID(), displayName: 'Expiry Fixture', roles: ['translator'] };
    const session = {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 4500).toISOString(),
    };
    await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ schema: 6, users: [user], sessions: [session] }));
    let port;
    ({ server, port } = await startAuthenticatedServer(root));
    socket = new WebSocket(`ws://127.0.0.1:${port}/?watchSession=1`, { headers: { Authorization: `Bearer ${token}` } });
    const closed = once(socket, 'close');
    const [message] = await once(socket, 'message');
    assert.equal(JSON.parse(message.toString()).type, 'session-active');
    const [code, reason] = await closed;
    assert.equal(code, 1008);
    assert.equal(reason.toString(), 'Session has expired');
    assert.equal((await api(port, 'GET', '/api/tickets', { token })).status, 401);
  },
);

test(
  'password auth supports multiple roles, private reset, identity enforcement, and revocation',
  { timeout: 60000 },
  async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-auth-'));
    const dataDirectory = path.join(temporary, 'data');
    let port;
    let server;
    let aliceSocket;
    let adminSocket;
    let aliceAgent;
    let agentReview;
    try {
      const documents = path.join(dataDirectory, 'documents');
      await fs.mkdir(documents, { recursive: true });
      const corruptDocument = 'general-dev:localisation/russian/corrupt.yml';
      const corruptHash = crypto.createHash('sha256').update(corruptDocument).digest('hex');
      const corruptFiles = [
        { path: path.join(documents, `${corruptHash}.json`), data: '{"reservations":[' },
        { path: path.join(documents, `${'b'.repeat(64)}.json`), data: 'null' },
      ];
      for (const { path: file, data } of corruptFiles) await fs.writeFile(file, data);
      ({ server, port } = await startAuthenticatedServer(dataDirectory));
      assert.match(server.output, /skipping corrupt room metadata/u);
      const bootstrapCode = (await fs.readFile(path.join(dataDirectory, 'bootstrap-invite.txt'), 'utf8')).trim();
      const adminRedeem = await api(port, 'POST', '/api/auth/redeem', {
        body: { inviteCode: bootstrapCode, displayName: 'Admin', password: 'Admin-only-password-947!' },
      });
      assert.equal(adminRedeem.status, 201);
      assert.deepEqual(adminRedeem.value.user.roles, ['admin']);
      const adminUserToken = adminRedeem.value.token;
      const corruptSocket = await connectSocket(port, corruptDocument, adminUserToken);
      const [corruptCode, corruptReason] = await once(corruptSocket, 'close');
      assert.equal(corruptCode, 1011);
      assert.equal(corruptReason.toString(), 'Persisted room metadata is corrupt');
      assert.equal((await api(port, 'GET', '/api/admin/users', { token: adminUserToken })).status, 401);
      assert.equal(
        (
          await api(port, 'POST', '/api/admin/session', {
            token: adminUserToken,
            body: { password: 'wrong-administrator-password' },
          })
        ).status,
        401,
      );
      const adminSession = await api(port, 'POST', '/api/admin/session', {
        token: adminUserToken,
        body: { password: 'Admin-only-password-947!' },
      });
      assert.equal(adminSession.status, 201);
      assert.match(adminSession.value.token, /^eaw_management_/u);
      const adminToken = adminSession.value.token;
      assert.equal(
        (
          await api(port, 'PUT', `/api/admin/users/${adminRedeem.value.user.id}/roles`, {
            token: adminToken,
            body: { roles: ['translator'] },
          })
        ).status,
        409,
      );

      const invite = await api(port, 'POST', '/api/admin/invites', {
        token: adminToken,
        body: { roles: ['translator', 'translation-editor'], maxUses: 1, expiresInHours: 24 },
      });
      assert.equal(invite.status, 201);
      const aliceRedeem = await api(port, 'POST', '/api/auth/redeem', {
        body: { inviteCode: invite.value.code, displayName: 'Alice', password: 'Alice-original-password-371!' },
      });
      assert.equal(aliceRedeem.status, 201);
      assert.deepEqual(aliceRedeem.value.user.roles, ['translator', 'translation-editor']);
      const aliceToken = aliceRedeem.value.token;
      assert.match(aliceRedeem.value.recoveryCode, /^EAWH-R1-/);
      const confirmedRecovery = await api(port, 'POST', '/api/auth/recovery/confirm', {
        token: aliceToken,
        body: { recoveryCode: aliceRedeem.value.recoveryCode },
      });
      assert.equal(confirmedRecovery.status, 200);
      assert.equal(confirmedRecovery.value.user.recoveryStatus, 'active');

      const wrongLogin = await api(port, 'POST', '/api/auth/login', {
        body: { displayName: 'Alice', password: 'Alice-wrong-password-998!' },
      });
      assert.equal(wrongLogin.status, 401);
      const aliceLogin = await api(port, 'POST', '/api/auth/login', {
        body: { displayName: 'Alice', password: 'Alice-original-password-371!' },
      });
      assert.equal(aliceLogin.status, 200);
      const aliceLoginToken = aliceLogin.value.token;

      const training = await api(port, 'PUT', '/api/auth/training', {
        token: aliceLoginToken,
        body: { segmentId: 'git-updates', revision: 2 },
      });
      assert.equal(training.status, 200);
      assert.equal(training.value.user.trainingProgress['git-updates'], 2);
      const trainingMe = await api(port, 'GET', '/api/auth/me', { token: aliceLoginToken });
      assert.equal(trainingMe.value.user.trainingProgress['git-updates'], 2);
      const persistedAuth = JSON.parse(await fs.readFile(path.join(dataDirectory, 'auth.json'), 'utf8'));
      assert.equal(
        persistedAuth.users.find(({ id }) => id === aliceRedeem.value.user.id).trainingProgress['git-updates'],
        2,
      );

      const logoutLogin = await api(port, 'POST', '/api/auth/login', {
        body: { displayName: 'Alice', password: 'Alice-original-password-371!' },
      });
      assert.equal(logoutLogin.status, 200);
      const logoutSocket = await connectSocket(
        port,
        'general-dev:localisation/russian/logout.yml',
        logoutLogin.value.token,
      );
      await waitJson(logoutSocket, (message) => message.type === 'synced');
      const closedByLogout = once(logoutSocket, 'close');
      const watcher = new WebSocket(`ws://127.0.0.1:${port}/?watchSession=1`, {
        headers: { Authorization: `Bearer ${logoutLogin.value.token}` },
      });
      const [notice] = await once(watcher, 'message');
      assert.equal(JSON.parse(notice.toString()).type, 'session-active');
      const closedWatcher = once(watcher, 'close');
      assert.equal((await api(port, 'POST', '/api/auth/logout', { token: logoutLogin.value.token })).status, 200);
      assert.equal((await closedByLogout)[0], 1008);
      assert.equal((await closedWatcher)[0], 1008);
      assert.equal((await api(port, 'GET', '/api/auth/me', { token: logoutLogin.value.token })).status, 401);
      assert.equal((await api(port, 'GET', '/api/tickets', { token: logoutLogin.value.token })).status, 401);

      const reused = await api(port, 'POST', '/api/auth/redeem', {
        body: { inviteCode: invite.value.code, displayName: 'Mallory', password: 'Mallory-unique-password-118!' },
      });
      assert.equal(reused.status, 401);

      const unauthorised = await connectSocket(port, 'general-dev:localisation/russian/auth.yml');
      const [unauthorisedCode] = await once(unauthorised, 'close');
      assert.equal(unauthorisedCode, 1008);

      aliceSocket = await connectSocket(port, 'general-dev:localisation/russian/auth.yml', aliceLoginToken);
      const aliceSyncedPromise = waitJson(aliceSocket, (message) => message.type === 'synced');
      const aliceSynced = await aliceSyncedPromise;
      assert.equal(aliceSynced.identity.displayName, 'Alice');
      assert.deepEqual(aliceSynced.identity.roles, ['translator', 'translation-editor']);
      aliceSocket.send(
        JSON.stringify({
          type: 'presence',
          clientId: 'alice-client',
          user: 'Spoofed name',
          color: '#ff6677',
          caretRelative: 'AA==',
          anchorRelative: 'AA==',
          userId: 'must-not-survive',
          documentId: 'must-not-survive',
          lastSeenAt: 'must-not-survive',
        }),
      );

      adminSocket = await connectSocket(port, 'general-dev:localisation/russian/auth.yml', adminUserToken);
      const adminSynced = await waitJson(adminSocket, (message) => message.type === 'synced');
      assert.deepEqual(adminSynced.directory.map(({ displayName }) => displayName).sort(), ['Admin', 'Alice']);
      assert.deepEqual(Object.keys(adminSynced.directory[0]).sort(), ['avatarBase64', 'color', 'displayName', 'id']);
      assert.equal(new Set(adminSynced.directory.map(({ color }) => color)).size, 2);
      const alicePresence = adminSynced.presences.find(({ clientId }) => clientId === 'alice-client');
      assert.equal(alicePresence.user, 'Alice');
      assert.equal('userId' in alicePresence, false);
      assert.equal('documentId' in alicePresence, false);
      assert.equal('lastSeenAt' in alicePresence, false);

      const avatarBase64 = testAvatarBase64();
      const directoryUpdated = waitJson(
        adminSocket,
        (message) =>
          message.type === 'directory' &&
          message.users.some((user) => user.id === aliceRedeem.value.user.id && user.avatarBase64 === avatarBase64),
      );
      const avatarUpdate = await api(port, 'PUT', '/api/auth/avatar', {
        token: aliceToken,
        body: { avatarBase64 },
      });
      assert.equal(avatarUpdate.status, 200);
      assert.equal(avatarUpdate.value.user.avatarBase64, avatarBase64);
      await directoryUpdated;

      const rolesClosed = once(aliceSocket, 'close');
      const changedRoles = await api(port, 'PUT', `/api/admin/users/${aliceRedeem.value.user.id}/roles`, {
        token: adminToken,
        body: { roles: ['senior translator', 'translator', 'translation-editor'] },
      });
      assert.equal(changedRoles.status, 200);
      assert.deepEqual(changedRoles.value.user.roles, ['senior translator', 'translator', 'translation-editor']);
      assert.equal((await rolesClosed)[0], 1012);
      aliceSocket = await connectSocket(port, 'general-dev:localisation/russian/auth.yml', aliceLoginToken);
      const refreshedIdentity = await waitJson(aliceSocket, (message) => message.type === 'synced');
      assert.deepEqual(refreshedIdentity.identity.roles, changedRoles.value.user.roles);

      const seniorAccountInvite = await api(port, 'POST', '/api/management/invites', {
        token: adminToken,
        body: { roles: ['senior translator', 'translator'], maxUses: 1, expiresInHours: 24 },
      });
      assert.equal(seniorAccountInvite.status, 201);
      const seniorAccount = await api(port, 'POST', '/api/auth/redeem', {
        body: {
          inviteCode: seniorAccountInvite.value.code,
          displayName: 'Senior Manager',
          password: 'Senior-manager-password-492!',
        },
      });
      assert.equal(seniorAccount.status, 201);
      const seniorSession = await api(port, 'POST', '/api/management/session', {
        token: seniorAccount.value.token,
        body: { password: 'Senior-manager-password-492!' },
      });
      assert.equal(seniorSession.status, 201);
      const seniorToken = seniorSession.value.token;
      assert.equal((await api(port, 'GET', '/api/admin/audit', { token: seniorToken })).status, 403);
      assert.equal((await api(port, 'GET', '/api/admin/audit', { token: adminUserToken })).status, 401);
      assert.equal((await api(port, 'GET', '/api/admin/audit', { token: adminToken })).status, 200);
      assert.equal((await api(port, 'GET', '/api/management/audit', { token: adminToken })).status, 404);
      assert.equal((await api(port, 'DELETE', '/api/admin/audit', { token: adminToken })).status, 404);
      assert.equal((await api(port, 'GET', '/api/management/users', { token: seniorToken })).status, 200);
      assert.equal(
        (
          await api(port, 'PUT', `/api/management/users/${seniorAccount.value.user.id}/roles`, {
            token: seniorToken,
            body: { roles: ['translator'] },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api(port, 'PUT', `/api/management/users/${adminRedeem.value.user.id}/roles`, {
            token: seniorToken,
            body: { roles: ['translator'] },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api(port, 'POST', '/api/management/invites', {
            token: seniorToken,
            body: { roles: ['admin'], maxUses: 1, expiresInHours: 24 },
          })
        ).status,
        403,
      );
      const seniorInvite = await api(port, 'POST', '/api/management/invites', {
        token: seniorToken,
        body: { roles: ['senior translator', 'translator'], maxUses: 3, expiresInHours: 24 },
      });
      assert.equal(seniorInvite.status, 201);
      const inviteList = await api(port, 'GET', '/api/management/invites', { token: seniorToken });
      const listedSeniorInvite = inviteList.value.invites.find(({ id }) => id === seniorInvite.value.invite.id);
      assert.deepEqual(listedSeniorInvite.roles, ['senior translator', 'translator']);
      assert.equal(listedSeniorInvite.remainingUses, 3);
      assert.equal(listedSeniorInvite.status, 'active');
      assert.equal(
        (
          await api(port, 'POST', `/api/management/invites/${listedSeniorInvite.id}/revoke`, {
            token: seniorToken,
          })
        ).status,
        200,
      );

      const contributorInvite = await api(port, 'POST', '/api/management/invites', {
        token: seniorToken,
        body: { roles: ['mod-contributor'], maxUses: 1, expiresInHours: 24 },
      });
      assert.equal(contributorInvite.status, 201);
      assert.deepEqual(contributorInvite.value.invite.roles, ['mod-contributor']);
      assert.equal(
        (
          await api(port, 'POST', `/api/management/invites/${contributorInvite.value.invite.id}/revoke`, {
            token: seniorToken,
          })
        ).status,
        200,
      );

      const reservationPromise = waitJson(adminSocket, (message) => message.type === 'reservations');
      aliceSocket.send(
        JSON.stringify({
          type: 'reservation-create',
          id: 'auth-reservation',
          assigneeId: adminRedeem.value.user.id,
          assignee: 'Spoofed name',
          createdBy: 'Spoofed name',
          startRelative: 'AA==',
          endRelative: 'AA==',
          initialKeys: ['key_one'],
        }),
      );
      const reservations = await reservationPromise;
      const adminDirectoryEntry = adminSynced.directory.find(({ id }) => id === adminRedeem.value.user.id);
      assert.equal(reservations.reservations[0].assignee, 'Admin');
      assert.equal(reservations.reservations[0].assigneeId, adminRedeem.value.user.id);
      assert.equal(reservations.reservations[0].color, adminDirectoryEntry.color);
      assert.equal(reservations.reservations[0].createdBy, 'Alice');
      assert.equal(reservations.reservations[0].createdById, aliceRedeem.value.user.id);

      const aliceDirectoryEntry = adminSynced.directory.find(({ id }) => id === aliceRedeem.value.user.id);
      const commentPromise = waitJson(
        adminSocket,
        (message) => message.type === 'review' && message.commentThreads?.[0]?.id === 'auth-comment',
      );
      aliceSocket.send(
        JSON.stringify({
          type: 'comment-create',
          id: 'auth-comment',
          messageId: 'auth-comment-first',
          author: 'Spoofed author',
          color: '#000000',
          body: 'Canonical colour',
          startRelative: 'AA==',
          endRelative: 'AA==',
        }),
      );
      const commentReview = await commentPromise;
      assert.equal(commentReview.commentThreads[0].author, 'Alice');
      assert.equal(commentReview.commentThreads[0].color, aliceDirectoryEntry.color);
      assert.equal(commentReview.commentThreads[0].messages[0].color, aliceDirectoryEntry.color);
      const replyPromise = waitJson(
        aliceSocket,
        (message) => message.type === 'review' && message.commentThreads?.[0]?.messages?.length === 2,
      );
      adminSocket.send(
        JSON.stringify({
          type: 'comment-reply',
          id: 'auth-comment',
          messageId: 'auth-comment-reply',
          author: 'Spoofed admin',
          color: '#000000',
          body: 'Admin response',
        }),
      );
      const replyReview = await replyPromise;
      assert.equal(replyReview.commentThreads[0].messages[1].author, 'Admin');
      assert.equal(replyReview.commentThreads[0].messages[1].color, adminDirectoryEntry.color);

      const agentRepo = path.join(temporary, 'agent-repo');
      const agentFile = path.join(agentRepo, 'localisation', 'russian', 'agent_auth_l_russian.yml');
      const agentText = 'l_russian:\n agent_auth_key:0 "Тест"\n';
      await fs.mkdir(path.dirname(agentFile), { recursive: true });
      await fs.writeFile(agentFile, agentText);
      const agentState = path.join(temporary, 'agent-state');
      aliceAgent = spawn(
        process.execPath,
        [
          'apps/agent/src/main.mjs',
          '--repo',
          agentRepo,
          '--workspace',
          'general-dev',
          '--user',
          'Spoofed local name',
          '--state',
          agentState,
          '--server',
          `ws://127.0.0.1:${port}`,
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, EAW_HUB_TOKEN: aliceToken },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      aliceAgent.output = '';
      aliceAgent.stdout.setEncoding('utf8');
      aliceAgent.stderr.setEncoding('utf8');
      aliceAgent.stdout.on('data', (chunk) => {
        aliceAgent.output += chunk;
      });
      aliceAgent.stderr.on('data', (chunk) => {
        aliceAgent.output += chunk;
      });
      await waitForOutput(aliceAgent, /review application: ready/u);
      agentReview = await connectReviewClient(agentState, agentFile, agentText);
      const authenticatedHello = await agentReview.waitFor(
        (message) => message.type === 'agentHello' && message.user === 'Alice',
      );
      assert.equal(authenticatedHello.user, 'Alice');
      await agentReview.waitFor((message) => message.type === 'documentReady');
      const targetSnapshot = await agentReview.waitFor(
        (message) =>
          message.type === 'reservationTargetSnapshot' &&
          message.targets?.some((target) => target.displayName === 'Admin'),
      );
      const adminTarget = targetSnapshot.targets.find((target) => target.displayName === 'Admin');
      assert.equal(adminTarget.id, adminRedeem.value.user.id);
      agentReview.send({
        type: 'reservationCreate',
        path: agentFile,
        startByte: 0,
        endByte: Buffer.byteLength(agentText, 'utf8'),
        assigneeId: adminTarget.id,
        assignee: 'Spoofed target',
        assigneeColor: '#000000',
      });
      const delegatedSnapshot = await agentReview.waitFor(
        (message) =>
          message.type === 'reservationSnapshot' &&
          message.reservations?.some((reservation) => reservation.assigneeId === adminTarget.id),
      );
      const delegatedFromReview = delegatedSnapshot.reservations.find(
        (reservation) => reservation.assigneeId === adminTarget.id,
      );
      assert.equal(delegatedFromReview.assignee, 'Admin');
      assert.equal(delegatedFromReview.createdBy, 'Alice');
      assert.equal(delegatedFromReview.color, adminTarget.color);

      const agentUnauthorised = once(agentReview.socket, 'close');
      const changedPassword = await api(port, 'POST', '/api/auth/password/change', {
        token: aliceLoginToken,
        body: {
          currentPassword: 'Alice-original-password-371!',
          newPassword: 'Alice-changed-password-482!',
        },
      });
      assert.equal(changedPassword.status, 200);
      assert.equal((await api(port, 'GET', '/api/auth/me', { token: aliceToken })).status, 401);
      assert.equal((await agentUnauthorised)[0], 4003);
      assert.equal(
        (
          await api(port, 'POST', '/api/auth/login', {
            body: { displayName: 'Alice', password: 'Alice-original-password-371!' },
          })
        ).status,
        401,
      );
      const changedLogin = await api(port, 'POST', '/api/auth/login', {
        body: { displayName: 'Alice', password: 'Alice-changed-password-482!' },
      });
      assert.equal(changedLogin.status, 200);

      const recoveryCode = aliceRedeem.value.recoveryCode;
      const aliceClosedByReset = once(aliceSocket, 'close');
      const reset = await api(port, 'POST', '/api/auth/password/recover', {
        body: { displayName: 'Alice', recoveryCode, newPassword: 'Alice-reset-password-593!' },
      });
      assert.equal(reset.status, 200);
      let resetToken = reset.value.token;
      assert.equal(reset.value.user.recoveryStatus, 'admin_authorization_required');
      const [resetCloseCode] = await aliceClosedByReset;
      assert.equal(resetCloseCode, 1008);
      assert.equal((await api(port, 'GET', '/api/auth/me', { token: changedLogin.value.token })).status, 401);
      assert.equal(
        (
          await api(port, 'POST', '/api/auth/password/recover', {
            body: { displayName: 'Alice', recoveryCode, newPassword: 'Another-password-never-used-77!' },
          })
        ).status,
        401,
      );

      const authorized = await api(port, 'POST', `/api/admin/users/${aliceRedeem.value.user.id}/recovery-authorize`, {
        token: adminToken,
      });
      assert.equal(authorized.status, 200);
      assert.equal(authorized.value.user.recoveryStatus, 'issuance_authorized');
      const replacement = await api(port, 'POST', '/api/auth/recovery/issue', { token: resetToken, body: {} });
      assert.equal(replacement.status, 201);
      assert.match(replacement.value.code, /^EAWH-R1-/);
      assert.notEqual(replacement.value.code, recoveryCode);
      assert.equal(
        (
          await api(port, 'POST', '/api/auth/recovery/confirm', {
            token: resetToken,
            body: { recoveryCode: replacement.value.code },
          })
        ).status,
        200,
      );

      const temporaryPassword = 'Alice-temporary-password-704!';
      const temporaryIssued = await api(
        port,
        'POST',
        `/api/admin/users/${aliceRedeem.value.user.id}/temporary-password`,
        { token: adminToken, body: { temporaryPassword } },
      );
      assert.equal(temporaryIssued.status, 200);
      assert.equal(temporaryIssued.value.user.temporaryPassword, true);
      assert.equal((await api(port, 'GET', '/api/auth/me', { token: resetToken })).status, 401);
      const temporaryLogin = await api(port, 'POST', '/api/auth/login', {
        body: { displayName: 'Alice', password: temporaryPassword },
      });
      assert.equal(temporaryLogin.status, 200);
      assert.equal(temporaryLogin.value.user.temporaryPassword, true);
      const temporarySocket = await connectSocket(
        port,
        'general-dev:localisation/russian/temporary-password.yml',
        temporaryLogin.value.token,
      );
      assert.equal((await once(temporarySocket, 'close'))[0], 1008);
      const permanent = await api(port, 'POST', '/api/auth/password/change', {
        token: temporaryLogin.value.token,
        body: { currentPassword: temporaryPassword, newPassword: 'Alice-permanent-password-815!' },
      });
      assert.equal(permanent.status, 200);
      assert.equal(permanent.value.user.temporaryPassword, false);
      resetToken = temporaryLogin.value.token;

      const authStateText = await fs.readFile(path.join(dataDirectory, 'auth.json'), 'utf8');
      for (const forbidden of [
        'Admin-only-password-947!',
        'Alice-original-password-371!',
        'Alice-changed-password-482!',
        'Alice-reset-password-593!',
        temporaryPassword,
        'Alice-permanent-password-815!',
        'deviceName',
        'lastSeenAt',
        'createdAt',
        'revokedAt',
        'displayNameKey',
      ])
        assert.equal(authStateText.includes(forbidden), false, `auth state leaked ${forbidden}`);
      assert.equal(authStateText.includes(recoveryCode), false);
      assert.equal(authStateText.includes(replacement.value.code), false);
      assert.match(authStateText, /"algorithm": "scrypt"/);
      assert.equal(server.output.includes('Admin-only-password-947!'), false);
      assert.equal(server.output.includes('Alice'), false);
      assert.equal(server.output.includes(dataDirectory), false);
      assert.equal(aliceAgent.output.includes('Alice'), false);
      assert.equal(aliceAgent.output.includes(agentRepo), false);

      aliceSocket = await connectSocket(port, 'general-dev:localisation/russian/auth-after-reset.yml', resetToken);
      await waitJson(aliceSocket, (message) => message.type === 'synced');
      const aliceClosed = once(aliceSocket, 'close');
      const anonymisedReservation = waitJson(
        adminSocket,
        (message) =>
          message.type === 'reservations' &&
          message.reservations[0]?.id === 'auth-reservation' &&
          message.reservations[0]?.createdBy === 'Deleted user',
      );
      const revoked = await api(port, 'POST', `/api/admin/users/${aliceRedeem.value.user.id}/revoke`, {
        token: adminToken,
      });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.value.user.id, aliceRedeem.value.user.id);
      for (const { path: file, data } of corruptFiles) assert.equal(await fs.readFile(file, 'utf8'), data);
      const [revokedCode] = await aliceClosed;
      assert.equal(revokedCode, 1008);
      const afterRevocation = await anonymisedReservation;
      assert.equal(afterRevocation.reservations[0].createdById, null);
      assert.equal(afterRevocation.reservations[0].assignee, 'Admin');
      const documentMetadataFiles = (await fs.readdir(path.join(dataDirectory, 'documents'))).filter((name) =>
        name.endsWith('.json'),
      );
      for (const metadataFile of documentMetadataFiles) {
        const metadataText = await fs.readFile(path.join(dataDirectory, 'documents', metadataFile), 'utf8');
        assert.equal(metadataText.includes('Alice'), false, 'revoked account remained in reservation metadata');
      }
      const rejectedMe = await api(port, 'GET', '/api/auth/me', { token: resetToken });
      assert.equal(rejectedMe.status, 401);
      assert.equal((await api(port, 'GET', '/api/admin/backup', { token: adminUserToken })).status, 401);
      const backupCredential = await api(port, 'POST', '/api/admin/backup-token', { token: adminToken });
      assert.equal(backupCredential.status, 201);
      assert.match(backupCredential.value.token, /^eaw_backup_/u);
      const backup = await api(port, 'GET', '/api/admin/backup', { token: backupCredential.value.token });
      assert.equal(backup.status, 200);
      assert.ok(Buffer.isBuffer(backup.value));
      assert.ok(backup.value.length > 100);
    } finally {
      aliceSocket?.close();
      adminSocket?.close();
      agentReview?.socket.terminate();
      await stop(aliceAgent);
      await stop(server);
      await fs.rm(temporary, { recursive: true, force: true });
    }
  },
);
