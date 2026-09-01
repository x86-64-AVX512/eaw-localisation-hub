import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';

async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, target);
}

test('tickets persist their Git base and isolate document namespaces', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-tickets-'));
  const actor = { id: 'translator-1', displayName: 'Translator' };
  const relativePath = 'localisation/russian/country_l_russian.yml';
  try {
    const store = new TicketStore(temporary, atomicWrite);
    await store.initialise();
    const ticket = await store.create(actor, {
      title: 'Country translation',
      description: 'Collaborative draft',
      baseBranch: 'general-dev',
      baseCommit: 'a'.repeat(40),
      files: [relativePath],
    });
    assert.equal(ticket.status, 'draft');
    assert.equal(ticket.creator, 'Translator');
    assert.doesNotThrow(() => store.assertDocumentAccess(`ticket-${ticket.id}:${relativePath}`));
    assert.throws(
      () => store.assertDocumentAccess(`ticket-${ticket.id}:localisation/russian/other_l_russian.yml`),
      /unavailable/u,
    );

    const reloaded = new TicketStore(temporary, atomicWrite);
    await reloaded.initialise();
    assert.deepEqual(reloaded.get(ticket.id).files, [relativePath]);
    await reloaded.update(actor, ticket.id, { status: 'review' });
    assert.equal(reloaded.get(ticket.id).status, 'review');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('ticket validation rejects unsafe input and makes terminal tickets read-only', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-tickets-'));
  const actor = { id: 'translator-1', displayName: 'Translator' };
  try {
    const store = new TicketStore(temporary, atomicWrite);
    await store.initialise();
    await assert.rejects(store.create(actor, {
      title: 'Escape', baseBranch: '../secret', baseCommit: 'b'.repeat(40), files: ['../outside.yml'],
    }));
    const ticket = await store.create(actor, {
      title: 'Closed ticket', baseBranch: 'country-dev', baseCommit: 'c'.repeat(40),
      files: ['localisation/russian/country_l_russian.yml'],
    });
    await store.update(actor, ticket.id, { status: 'closed' });
    assert.doesNotThrow(() => store.assertDocumentAccess(`ticket-${ticket.id}:${ticket.files[0]}`));
    assert.equal(store.documentWritable(`ticket-${ticket.id}:${ticket.files[0]}`), false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
