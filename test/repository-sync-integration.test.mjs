import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createReviewDocument } from '../apps/review/src/review-document.ts';
import { runGitSync } from '../apps/agent/src/git-executable.mts';
import { repositorySyncDirectory } from '../apps/agent/src/repository-sync.mjs';
import { normaliseLineEndings, withoutUtf8Bom } from '../packages/shared/src/text.mts';

const projectRoot = path.resolve(import.meta.dirname, '..');
function git(repo, ...args) {
  const result = runGitSync(args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
async function waitUntil(predicate, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}
function node(args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: projectRoot,
    env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8'); stream.on('data', (chunk) => { child.output += chunk; });
  }
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit'); child.kill(); await closed;
}

for (const startup of [false, true]) {
test(startup
  ? 'real auto-pull initialises Review opened on an outdated file without importing its old snapshot'
  : 'real Agent update reconnects Review to canonical Git without reverting checkout or importing it as an edit',
  { timeout: 45_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-repository-sync-transport-'));
    const publisher = path.join(root, 'publisher'), remote = path.join(root, 'remote.git'), repo = path.join(root, 'client');
    const state = path.join(root, 'state');
    const relative = 'localisation/russian/test_l_russian.yml';
    const file = path.join(repo, relative);
    const original = 'l_russian:\n first:0 "One"\n second:0 "Two"\n duplicate:0 "First"\n duplicate:0 "Second"\n';
    const updated = original.replace('"Two"', '"Remote Two"').replace('"Second"', '"Remote duplicate"');
    let server, agent, socket, document;
    const messages = [];
    try {
      await fs.mkdir(path.dirname(path.join(publisher, relative)), { recursive: true });
      git(publisher, 'init', '-b', 'general-dev');
      git(publisher, 'config', 'user.name', 'Test'); git(publisher, 'config', 'user.email', 'test@example.invalid');
      git(publisher, 'config', 'core.autocrlf', 'false');
      await fs.writeFile(path.join(publisher, '.gitattributes'), '*.yml text eol=lf\n');
      await fs.writeFile(path.join(publisher, relative), `\uFEFF${original}`);
      git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'initial');
      git(root, 'clone', '--bare', publisher, remote);
      git(publisher, 'remote', 'add', 'fork', remote);
      git(root, 'clone', '-c', 'core.autocrlf=false', '-b', 'general-dev', '-o', 'fork', remote, repo);
      git(repo, 'config', 'core.autocrlf', 'false');
      // Restore checkout to this repo's explicit LF policy, before Agent starts.
      await fs.writeFile(file, `\uFEFF${original}`);
      const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
      const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
      server = node(['apps/server/src/main.mjs', '--host', '127.0.0.1', '--port', String(port),
        '--data', path.join(root, 'server-data'), '--auth', 'disabled'], {
        EAW_HUB_GITHUB_REPOSITORY: '', EAW_HUB_CANONICAL_REPOSITORY: pathToFileURL(remote).href,
        EAW_HUB_GIT_REFRESH_MILLISECONDS: '1000',
      });
      await waitUntil(() => server.output.includes('listening on'), 'server ready');
      const publishUpdate = async () => {
        await fs.writeFile(path.join(publisher, relative), `\uFEFF${updated}`);
        git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'remote change'); git(publisher, 'push', 'fork', 'general-dev');
      };
      const waitCanonical = async () => {
        const target = git(publisher, 'rev-parse', 'HEAD');
        await waitUntil(async () => {
          const result = await fetch(`http://127.0.0.1:${port}/api/git/head?branch=general-dev`);
          return (await result.json()).commit === target;
        }, 'canonical server remote HEAD');
      };
      // Auto-Git is enabled only after Review attaches, so startup reliably
      // exercises the previously circular initialisation/checkout wait.
      if (startup) { await publishUpdate(); await waitCanonical(); }
      agent = node(['apps/agent/src/main.mjs', '--repo', repo, '--user', 'Alice', '--state', state,
        '--server', `ws://127.0.0.1:${port}`]);
      await waitUntil(() => agent.output.includes('review application: ready'), 'Agent ready');
      const discovery = JSON.parse(await fs.readFile(path.join(state, 'review-session.json'), 'utf8'));
      const syncUrl = `${discovery.origin}/api/repository-sync`;
      const headers = { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' };
      assert.equal((await fetch(syncUrl)).status, 401);
      assert.equal((await fetch(syncUrl, { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(syncUrl, { method: 'DELETE', headers })).status, 405);
      const initialSync = await (await fetch(syncUrl, { headers })).json();
      assert.equal(initialSync.checkout.branch, 'general-dev');
      assert.equal(initialSync.settings.autoPull, false);
      assert.equal((await fetch(syncUrl, { method: 'POST', headers,
        body: JSON.stringify({ action: 'update', checkout: initialSync.checkout }) })).status, 400);
      assert.equal((await fetch(syncUrl, { method: 'POST', headers,
        body: JSON.stringify({ action: 'update', confirmed: true,
          checkout: { ...initialSync.checkout, head: '0'.repeat(40) } }) })).status, 409);
      assert.equal((await fetch(syncUrl, { method: 'POST', headers,
        body: JSON.stringify({ action: 'reset', confirmed: true, checkout: initialSync.checkout }) })).status, 400);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), initialSync.checkout.head, 'rejected requests do not mutate Git');
      socket = new WebSocket(`${discovery.origin.replace('http:', 'ws:')}/review-socket?token=${discovery.token}`, { origin: discovery.origin });
      document = createReviewDocument({ send(message) { socket.send(JSON.stringify(message)); }, onText() {} });
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()); messages.push(message);
        if (message.type === 'documentSync') document.receive(message);
        if (message.type === 'documentReady') document.replay();
      });
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'open', path: file, crdt: 'yjs-v1', textBase64: Buffer.from(original).toString('base64') }));
      if (startup) {
        await waitUntil(() => messages.some((m) => m.type === 'documentStatus' && m.status === 'git-file-outdated'), 'outdated initial view');
        assert.equal(messages.some((m) => m.type === 'documentReady'), false);
      } else await waitUntil(() => messages.some((m) => m.type === 'documentVariants'), 'initial projection');
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(git(repo, 'status', '--porcelain'), '');
      if (!startup) await publishUpdate();
      const target = git(publisher, 'rev-parse', 'HEAD');
      const directory = repositorySyncDirectory(state, repo);
      await fs.mkdir(directory, { recursive: true });
      const requestUpdate = async () => {
        const status = await (await fetch(syncUrl, { headers })).json();
        const response = await fetch(syncUrl, { method: 'POST', headers,
          body: JSON.stringify({ action: 'update', confirmed: true, checkout: status.checkout }) });
        assert.equal(response.status, 202, await response.text());
      };
      // Force canonical refresh so the client is already read-only/outdated.
      await waitCanonical();
      if (startup) await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ autoPull: true }));
      else await requestUpdate();
      await waitUntil(() => git(repo, 'rev-parse', 'HEAD') === target, 'fast-forward');
      await waitUntil(() => normaliseLineEndings(document.text()) === updated, 'Review new canonical text');
      const readDisk = async () => normaliseLineEndings(withoutUtf8Bom(await fs.readFile(file, 'utf8')));
      await waitUntil(async () => await readDisk() === updated, 'new disk projection');
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(await readDisk(), updated);
      assert.equal(git(repo, 'status', '--porcelain'), '', 'no phantom materialisation changes after checkout');
      assert.equal(messages.some((m) => m.type === 'notice' && /Изменения с диска объединены|Git-откат применён/u.test(m.message)), false);
      assert.equal(messages.some((m) => m.type === 'error'), false);

      // A personal translation must still veto the next remote branch update.
      document.commit(document.text().replace('"One"', '"Alice translation"'));
      await waitUntil(async () => (await readDisk()).includes('Alice translation'), 'personal translation saved');
      const next = updated.replace('"Remote Two"', '"Next remote"');
      await fs.writeFile(path.join(publisher, relative), `\uFEFF${next}`);
      git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'another update'); git(publisher, 'push', 'fork', 'general-dev');
      await requestUpdate();
      await waitUntil(async () => {
        try { const status = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
          return status.reason === 'dirty' && status.behind === 1 && Boolean(status.alertId); } catch { return false; }
      }, 'dirty block notification');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), target);
      assert.match(await readDisk(), /Alice translation/u);
    } catch (error) {
      try { error.message += `; Git status: ${await fs.readFile(path.join(repositorySyncDirectory(state, repo), 'status.json'), 'utf8')}; worktree: ${git(repo, 'status', '--porcelain')}`; } catch {}
      error.message += `; Agent: ${agent?.output.slice(-1800)}; Server: ${server?.output.slice(-1500)}; messages: ${JSON.stringify(messages.slice(-12))}`;
      throw error;
    } finally {
      socket?.terminate(); document?.dispose();
      await stop(agent); await stop(server);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
