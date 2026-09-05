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
  await assert.rejects(store.login('Third unknown', 'anything', 'source-a'), { code: 'login_rate_limited', status: 429 });
  assert.equal(passwordChecks, 2);
  await assert.rejects(store.login('Third unknown', 'anything', 'source-b'), { code: 'invalid_credentials' });
  assert.equal(passwordChecks, 3);
  now += 1000;
  await assert.rejects(store.login('Fourth unknown', 'anything', 'source-a'), { code: 'invalid_credentials' });
  assert.equal(passwordChecks, 4);
});

test('sessions have role-sensitive expiry and a per-user cap', async () => {
  let now = Date.now();
  const store = new AuthStore('.', async () => {}, 'required', { now: () => now });
  const translator = {
    id: 'translator-user', displayName: 'Translator', roles: ['translator'], passwordVerifier: {},
  };
  const admin = {
    id: 'admin-user', displayName: 'Admin', roles: ['admin'], passwordVerifier: {},
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

function pipePath(name) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

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
          response.on('data', (chunk) => { data += chunk; });
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

async function connectFakePlugin(pipe, filePath, initialText, ipcSecret) {
  const socket = net.createConnection(pipePath(pipe));
  await once(socket, 'connect');
  const messages = [];
  const waiters = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
      for (const notify of [...waiters]) notify();
    }
  });
  const waitFor = (predicate, timeout = 10000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for Agent message:\n${JSON.stringify(messages, null, 2)}`)), timeout);
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
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  const challenge = await waitFor((message) => message.type === 'ipcChallenge');
  send({
    type: 'hello',
    clientId: 'authenticated-agent-test',
    version: '0.6.5F1',
    protocol: 15,
    proof: crypto.createHmac('sha256', ipcSecret)
      .update(`plugin:${challenge.nonce}`, 'utf8')
      .digest('hex'),
  });
  send({ type: 'open', path: filePath, textBase64: Buffer.from(initialText).toString('base64') });
  return { socket, messages, waitFor };
}

test('password auth supports multiple roles, private reset, identity enforcement, and revocation', { timeout: 60000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-auth-'));
  const dataDirectory = path.join(temporary, 'data');
  const port = await freePort();
  const server = spawn(process.execPath, [
    'apps/server/src/main.mjs', '--port', String(port), '--data', dataDirectory, '--auth', 'required',
  ], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.output = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { server.output += chunk; });
  server.stderr.on('data', (chunk) => { server.output += chunk; });
  let aliceSocket;
  let adminSocket;
  let aliceAgent;
  let agentPlugin;
  const ipcSecret = `auth-test-ipc-secret-${crypto.randomBytes(16).toString('hex')}`;
  try {
    await waitForHealth(port);
    const bootstrapCode = (await fs.readFile(path.join(dataDirectory, 'bootstrap-invite.txt'), 'utf8')).trim();
    const adminRedeem = await api(port, 'POST', '/api/auth/redeem', {
      body: { inviteCode: bootstrapCode, displayName: 'Admin', password: 'Admin-only-password-947!' },
    });
    assert.equal(adminRedeem.status, 201);
    assert.deepEqual(adminRedeem.value.user.roles, ['admin']);
    const adminUserToken = adminRedeem.value.token;
    assert.equal((await api(port, 'GET', '/api/admin/users', { token: adminUserToken })).status, 401);
    assert.equal((await api(port, 'POST', '/api/admin/session', {
      token: adminUserToken, body: { password: 'wrong-administrator-password' },
    })).status, 401);
    const adminSession = await api(port, 'POST', '/api/admin/session', {
      token: adminUserToken, body: { password: 'Admin-only-password-947!' },
    });
    assert.equal(adminSession.status, 201);
    assert.match(adminSession.value.token, /^eaw_management_/u);
    const adminToken = adminSession.value.token;
    assert.equal((await api(port, 'PUT', `/api/admin/users/${adminRedeem.value.user.id}/roles`, {
      token: adminToken,
      body: { roles: ['translator'] },
    })).status, 409);

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
      token: aliceToken, body: { recoveryCode: aliceRedeem.value.recoveryCode },
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
      token: aliceLoginToken, body: { segmentId: 'git-updates', revision: 2 },
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
      port, 'general-dev:localisation/russian/logout.yml', logoutLogin.value.token,
    );
    await waitJson(logoutSocket, (message) => message.type === 'synced');
    const closedByLogout = once(logoutSocket, 'close');
    assert.equal((await api(port, 'POST', '/api/auth/logout', { token: logoutLogin.value.token })).status, 200);
    assert.equal((await closedByLogout)[0], 1008);
    assert.equal((await api(port, 'GET', '/api/auth/me', { token: logoutLogin.value.token })).status, 401);

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
    aliceSocket.send(JSON.stringify({
      type: 'presence',
      clientId: 'alice-client',
      user: 'Spoofed name',
      color: '#ff6677',
      caretRelative: 'AA==',
      anchorRelative: 'AA==',
      userId: 'must-not-survive',
      documentId: 'must-not-survive',
      lastSeenAt: 'must-not-survive',
    }));

    adminSocket = await connectSocket(port, 'general-dev:localisation/russian/auth.yml', adminUserToken);
    const adminSynced = await waitJson(adminSocket, (message) => message.type === 'synced');
    assert.deepEqual(
      adminSynced.directory.map(({ displayName }) => displayName).sort(),
      ['Admin', 'Alice'],
    );
    assert.deepEqual(Object.keys(adminSynced.directory[0]).sort(), ['avatarBase64', 'color', 'displayName', 'id']);
    assert.equal(new Set(adminSynced.directory.map(({ color }) => color)).size, 2);
    const alicePresence = adminSynced.presences.find(({ clientId }) => clientId === 'alice-client');
    assert.equal(alicePresence.user, 'Alice');
    assert.equal('userId' in alicePresence, false);
    assert.equal('documentId' in alicePresence, false);
    assert.equal('lastSeenAt' in alicePresence, false);

    const avatarBase64 = testAvatarBase64();
    const directoryUpdated = waitJson(adminSocket, (message) => message.type === 'directory'
      && message.users.some((user) => user.id === aliceRedeem.value.user.id
        && user.avatarBase64 === avatarBase64));
    const avatarUpdate = await api(port, 'PUT', '/api/auth/avatar', {
      token: aliceToken, body: { avatarBase64 },
    });
    assert.equal(avatarUpdate.status, 200);
    assert.equal(avatarUpdate.value.user.avatarBase64, avatarBase64);
    await directoryUpdated;

    const changedRoles = await api(port, 'PUT', `/api/admin/users/${aliceRedeem.value.user.id}/roles`, {
      token: adminToken,
      body: { roles: ['senior translator', 'translator', 'translation-editor'] },
    });
    assert.equal(changedRoles.status, 200);
    assert.deepEqual(changedRoles.value.user.roles, ['senior translator', 'translator', 'translation-editor']);

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
      token: seniorAccount.value.token, body: { password: 'Senior-manager-password-492!' },
    });
    assert.equal(seniorSession.status, 201);
    const seniorToken = seniorSession.value.token;
    assert.equal((await api(port, 'GET', '/api/management/users', { token: seniorToken })).status, 200);
    assert.equal((await api(port, 'PUT', `/api/management/users/${seniorAccount.value.user.id}/roles`, {
      token: seniorToken, body: { roles: ['translator'] },
    })).status, 403);
    assert.equal((await api(port, 'PUT', `/api/management/users/${adminRedeem.value.user.id}/roles`, {
      token: seniorToken, body: { roles: ['translator'] },
    })).status, 403);
    assert.equal((await api(port, 'POST', '/api/management/invites', {
      token: seniorToken, body: { roles: ['admin'], maxUses: 1, expiresInHours: 24 },
    })).status, 403);
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
    assert.equal((await api(port, 'POST', `/api/management/invites/${listedSeniorInvite.id}/revoke`, {
      token: seniorToken,
    })).status, 200);

    const reservationPromise = waitJson(adminSocket, (message) => message.type === 'reservations');
    aliceSocket.send(JSON.stringify({
      type: 'reservation-create',
      id: 'auth-reservation',
      assigneeId: adminRedeem.value.user.id,
      assignee: 'Spoofed name',
      createdBy: 'Spoofed name',
      startRelative: 'AA==',
      endRelative: 'AA==',
      initialKeys: ['key_one'],
    }));
    const reservations = await reservationPromise;
    const adminDirectoryEntry = adminSynced.directory.find(({ id }) => id === adminRedeem.value.user.id);
    assert.equal(reservations.reservations[0].assignee, 'Admin');
    assert.equal(reservations.reservations[0].assigneeId, adminRedeem.value.user.id);
    assert.equal(reservations.reservations[0].color, adminDirectoryEntry.color);
    assert.equal(reservations.reservations[0].createdBy, 'Alice');
    assert.equal(reservations.reservations[0].createdById, aliceRedeem.value.user.id);

    const aliceDirectoryEntry = adminSynced.directory.find(({ id }) => id === aliceRedeem.value.user.id);
    const commentPromise = waitJson(adminSocket, (message) => message.type === 'review'
      && message.commentThreads?.[0]?.id === 'auth-comment');
    aliceSocket.send(JSON.stringify({
      type: 'comment-create', id: 'auth-comment', messageId: 'auth-comment-first',
      author: 'Spoofed author', color: '#000000', body: 'Canonical colour',
      startRelative: 'AA==', endRelative: 'AA==',
    }));
    const commentReview = await commentPromise;
    assert.equal(commentReview.commentThreads[0].author, 'Alice');
    assert.equal(commentReview.commentThreads[0].color, aliceDirectoryEntry.color);
    assert.equal(commentReview.commentThreads[0].messages[0].color, aliceDirectoryEntry.color);
    const replyPromise = waitJson(aliceSocket, (message) => message.type === 'review'
      && message.commentThreads?.[0]?.messages?.length === 2);
    adminSocket.send(JSON.stringify({
      type: 'comment-reply', id: 'auth-comment', messageId: 'auth-comment-reply',
      author: 'Spoofed admin', color: '#000000', body: 'Admin response',
    }));
    const replyReview = await replyPromise;
    assert.equal(replyReview.commentThreads[0].messages[1].author, 'Admin');
    assert.equal(replyReview.commentThreads[0].messages[1].color, adminDirectoryEntry.color);

    const agentRepo = path.join(temporary, 'agent-repo');
    const agentFile = path.join(agentRepo, 'localisation', 'russian', 'agent_auth_l_russian.yml');
    const agentText = 'l_russian:\n agent_auth_key:0 "Тест"\n';
    await fs.mkdir(path.dirname(agentFile), { recursive: true });
    await fs.writeFile(agentFile, agentText);
    const agentPipe = `eaw-hub-auth-${process.pid}-${Date.now()}`;
    aliceAgent = spawn(process.execPath, [
      'apps/agent/src/main.mjs', '--repo', agentRepo, '--workspace', 'general-dev',
      '--pipe', agentPipe, '--user', 'Spoofed local name', '--state', path.join(temporary, 'agent-state'),
      '--server', `ws://127.0.0.1:${port}`,
    ], {
      cwd: projectRoot,
      env: { ...process.env, EAW_HUB_TOKEN: aliceToken, EAW_HUB_IPC_SECRET: ipcSecret },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    aliceAgent.output = '';
    aliceAgent.stdout.setEncoding('utf8');
    aliceAgent.stderr.setEncoding('utf8');
    aliceAgent.stdout.on('data', (chunk) => { aliceAgent.output += chunk; });
    aliceAgent.stderr.on('data', (chunk) => { aliceAgent.output += chunk; });
    await waitForOutput(aliceAgent, /pipe:/);
    agentPlugin = await connectFakePlugin(agentPipe, agentFile, agentText, ipcSecret);
    const authenticatedHello = await agentPlugin.waitFor(
      (message) => message.type === 'agentHello' && message.user === 'Alice',
    );
    assert.equal(authenticatedHello.user, 'Alice');
    await agentPlugin.waitFor((message) => message.type === 'documentReady');
    const adminTarget = await agentPlugin.waitFor(
      (message) => message.type === 'reservationTarget' && message.displayName === 'Admin',
    );
    assert.equal(adminTarget.id, adminRedeem.value.user.id);
    agentPlugin.socket.write(`${JSON.stringify({
      type: 'reservationCreate',
      path: agentFile,
      startByte: 0,
      endByte: Buffer.byteLength(agentText, 'utf8'),
      assigneeId: adminTarget.id,
      assignee: 'Spoofed target',
      assigneeColor: '#000000',
    })}\n`);
    const delegatedFromPlugin = await agentPlugin.waitFor(
      (message) => message.type === 'reservation' && message.assigneeId === adminTarget.id,
    );
    assert.equal(delegatedFromPlugin.assignee, 'Admin');
    assert.equal(delegatedFromPlugin.createdBy, 'Alice');
    assert.equal(delegatedFromPlugin.color, adminTarget.color);

    const agentUnauthorised = agentPlugin.waitFor(
      (message) => message.type === 'documentStatus' && message.status === 'unauthorized',
    );
    const changedPassword = await api(port, 'POST', '/api/auth/password/change', {
      token: aliceLoginToken,
      body: {
        currentPassword: 'Alice-original-password-371!',
        newPassword: 'Alice-changed-password-482!',
      },
    });
    assert.equal(changedPassword.status, 200);
    assert.equal((await api(port, 'GET', '/api/auth/me', { token: aliceToken })).status, 401);
    await agentUnauthorised;
    assert.equal((await api(port, 'POST', '/api/auth/login', {
      body: { displayName: 'Alice', password: 'Alice-original-password-371!' },
    })).status, 401);
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
    assert.equal((await api(port, 'POST', '/api/auth/password/recover', {
      body: { displayName: 'Alice', recoveryCode, newPassword: 'Another-password-never-used-77!' },
    })).status, 401);

    const authorized = await api(port, 'POST', `/api/admin/users/${aliceRedeem.value.user.id}/recovery-authorize`, {
      token: adminToken,
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.value.user.recoveryStatus, 'issuance_authorized');
    const replacement = await api(port, 'POST', '/api/auth/recovery/issue', { token: resetToken, body: {} });
    assert.equal(replacement.status, 201);
    assert.match(replacement.value.code, /^EAWH-R1-/);
    assert.notEqual(replacement.value.code, recoveryCode);
    assert.equal((await api(port, 'POST', '/api/auth/recovery/confirm', {
      token: resetToken, body: { recoveryCode: replacement.value.code },
    })).status, 200);

    const temporaryPassword = 'Alice-temporary-password-704!';
    const temporaryIssued = await api(
      port, 'POST', `/api/admin/users/${aliceRedeem.value.user.id}/temporary-password`,
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
      port, 'general-dev:localisation/russian/temporary-password.yml', temporaryLogin.value.token,
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
      'Admin-only-password-947!', 'Alice-original-password-371!', 'Alice-changed-password-482!',
      'Alice-reset-password-593!', temporaryPassword, 'Alice-permanent-password-815!',
      'deviceName', 'lastSeenAt', 'createdAt', 'revokedAt', 'displayNameKey',
    ]) assert.equal(authStateText.includes(forbidden), false, `auth state leaked ${forbidden}`);
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
      (message) => message.type === 'reservations'
        && message.reservations[0]?.id === 'auth-reservation'
        && message.reservations[0]?.createdBy === 'Deleted user',
    );
    const revoked = await api(port, 'POST', `/api/admin/users/${aliceRedeem.value.user.id}/revoke`, {
      token: adminToken,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.value.user.id, aliceRedeem.value.user.id);
    const [revokedCode] = await aliceClosed;
    assert.equal(revokedCode, 1008);
    const afterRevocation = await anonymisedReservation;
    assert.equal(afterRevocation.reservations[0].createdById, null);
    assert.equal(afterRevocation.reservations[0].assignee, 'Admin');
    const documentMetadataFiles = (await fs.readdir(path.join(dataDirectory, 'documents')))
      .filter((name) => name.endsWith('.json'));
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
    agentPlugin?.socket.destroy();
    await stop(aliceAgent);
    await stop(server);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
