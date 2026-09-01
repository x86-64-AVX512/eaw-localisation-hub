import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { TicketWorkflow } from '../apps/agent/src/ticket-workflow.mjs';

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('Agent applies a ticket without writing collaborative ticket text into the personal Git file', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-workflow-'));
  const relativePath = 'localisation/russian/test_l_russian.yml';
  const absolutePath = path.join(repository, ...relativePath.split('/'));
  const base = 'l_russian:\n key_one:0 "Base"\n';
  const ticketText = 'l_russian:\n key_one:0 "Ticket"\n';
  const localText = 'l_russian:\n key_one:0 "Base"\n key_two:0 "Local"\n';
  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `\uFEFF${base}`);
    git(repository, 'init');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'base');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const branch = git(repository, 'branch', '--show-current');
    await fs.writeFile(absolutePath, `\uFEFF${localText}`);
    let appliedBody;
    const ticket = { id: 'ticket-id', baseBranch: branch, baseCommit: commit, files: [relativePath] };
    const snapshot = { ticket, files: [{
      path: relativePath, ticketHash: hash(ticketText), mainHash: hash(base),
      ticketInitialised: true, mainInitialised: true,
      ticketTextBase64: Buffer.from(ticketText).toString('base64'),
      mainTextBase64: Buffer.from(base).toString('base64'),
    }] };
    const hub = {
      options: { repo: repository, workspace: branch },
      async ticketRequest(route, options) {
        if (route.endsWith('/snapshot')) return snapshot;
        if (route.endsWith('/apply')) {
          appliedBody = JSON.parse(options.body);
          return { ticket: { ...ticket, status: 'applied' } };
        }
        throw new Error(`Unexpected route ${route}`);
      },
    };
    const result = await new TicketWorkflow(hub).apply(ticket.id);
    assert.equal(result.ok, true);
    const appliedText = Buffer.from(appliedBody.results[0].textBase64, 'base64').toString('utf8');
    assert.match(appliedText, /key_one:0 "Ticket"/u);
    assert.match(appliedText, /key_two:0 "Local"/u);
    assert.equal(await fs.readFile(absolutePath, 'utf8'), `\uFEFF${localText}`);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
