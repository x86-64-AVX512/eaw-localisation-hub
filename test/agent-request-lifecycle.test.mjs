import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Agent start cancellation and account results remain scoped to the original request', {skip: process.platform !== 'win32'}, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-request-lifecycle-'));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  const sockets = new Set(), mutations = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', value => body += value);
    req.on('end', () => {
      const input = body ? JSON.parse(body) : {};
      const token = req.headers.authorization ?? '';
      if (req.url !== '/api/auth/me') mutations.push({route: req.url, outcome: input.outcome});
      if (token === 'Bearer fixture-timeout' || input.outcome === 'timeout') return;
      const denied = token === 'Bearer fixture-denied' || input.outcome === 'rejected';
      res.writeHead(denied ? 401 : 200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(denied ? {error: 'fixture rejected'} : {user: {displayName: 'Fixture', temporaryPassword: token === 'Bearer fixture-temporary'}}));
    });
  });
  server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));});
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'test/fixtures/agent-request-lifecycle.ps1'), '-Root', root, '-Scratch', scratch, '-Port', String(server.address().port)], {windowsHide: true});
  let output = '', error = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
  const timer = setTimeout(() => child.kill(), 15000);
  const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
  assert.equal(code, 0, error);
  const results = new Map(JSON.parse(output.trim()).map(value => [value.case, value]));
  await t.test('stop invalidates successful and failed callbacks already dequeued', () => {
    const result = results.get('stop-cancels-start');
    assert.equal(result.launches, 0); assert.equal(result.pending, 0); assert.equal(result.intent, null);
    assert.match(result.status, /остановлен/u);
  });
  await t.test('a later explicit start survives old callbacks and repeated clicks stay single-flight', () => {
    const result = results.get('new-start-survives-old-callback');
    assert.equal(result.preserved, true); assert.equal(result.pendingBeforeDrain, 1); assert.equal(result.launches, 1);
  });
  await t.test('network failure permits an intended local start; revoked and temporary credentials do not', () => {
    assert.equal(results.get('fixture-timeout').launches, 1);
    for (const name of ['fixture-denied', 'fixture-temporary']) assert.equal(results.get(name).launches, 0, name);
    for (const name of ['fixture-timeout', 'fixture-denied', 'fixture-temporary']) assert.equal(results.get(name).intent, null);
  });
  for (const operation of ['password-change', 'logout']) for (const outcome of ['ok', 'rejected', 'timeout']) {
    await t.test(`${operation}: ${outcome} reaches the UI after switching servers without changing the selected account`, () => {
      const result = results.get(`${operation}-${outcome}`);
      assert.equal(result.successCalls, 0); assert.equal(result.failureCalls, 0); assert.equal(result.completeCalls, 1);
      assert.equal(result.account, 'Selected account'); assert.equal(result.accountServer, 'ws://127.0.0.1:1'); assert.equal(result.confirmed, '2026-01-01');
      assert.ok(result.status.includes(`ws://127.0.0.1:${server.address().port}`), result.status);
      assert.ok(result.status.includes(operation), result.status);
      assert.match(result.status, outcome === 'ok' ? /Операция выполнена/u : outcome === 'rejected' ? /fixture rejected/u : /Результат не подтверждён/u);
      const expected = operation === 'password-change' && outcome === 'ok' ? 2 : 1;
      assert.equal(mutations.filter(value => value.route.endsWith(operation === 'logout' ? '/logout' : '/password/change') && value.outcome === outcome).length, expected, 'no automatic retries');
    });
  }
  await t.test('stale account checks and login responses cannot apply credentials for another server', () => {
    for (const name of ['stale-GET', 'stale-POST']) {
      const result = results.get(name);
      assert.equal(result.successCalls, 0); assert.equal(result.failureCalls, 0); assert.equal(result.completeCalls, 1); assert.equal(result.status, 'initial');
    }
  });
  await t.test('a current-server mutation keeps its ordinary success and completion callbacks', () => {
    const result = results.get('same-server');
    assert.equal(result.successCalls, 1); assert.equal(result.failureCalls, 0); assert.equal(result.completeCalls, 1); assert.equal(result.status, 'initial');
  });
});
